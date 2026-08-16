/**
 * The debounced library watcher (roster DESIGN §2.3, IMPLEMENTATION M2).
 *
 * > "watches the directory (debounced, ~250 ms) for external edits — so
 * > hand-editing a persona in an editor, or `git pull`ing a roster, is a
 * > first-class workflow."
 *
 * Why debounce at all: a single editor save is several filesystem events (a
 * temp file, a rename, an attribute touch), a `git pull` is one per file across
 * every agent it changed, and `fs.watch` on Windows reports each of them
 * separately. Reloading per event would reread the library dozens of times for
 * one logical change and emit a `roster.changed` for each reread.
 *
 * Why per *folder* rather than per file: the unit of validity is the folder —
 * `agent.json` plus the persona it names plus the avatar it names — so there is
 * nothing useful to do with "persona.md changed" other than reload the agent
 * that owns it. Collecting folder names between ticks also collapses a
 * multi-file save into one reload.
 *
 * The watcher never touches the registry itself. It reports folder names, and
 * the service decides what that means — which keeps the reload path identical
 * whether the change came from the watcher, from a boot, or from a test calling
 * `reload()` directly.
 */
import { watch, type FSWatcher } from 'node:fs';
import type { Logger } from 'pino';

/** §2.3's "~250 ms", which M2 requires to show up "within ~1s without a restart". */
export const DEFAULT_DEBOUNCE_MS = 250;

export interface RosterWatcherOptions {
  /** `<libraryRoot>/agents` — the only directory worth watching (§2.1). */
  readonly agentsDir: string;
  /**
   * Called once per quiet period with the folder names that changed, or with
   * `undefined` when the platform gave no filename and the whole library has to
   * be rechecked.
   */
  readonly onChanged: (folders: readonly string[] | undefined) => void;
  readonly debounceMs?: number;
  readonly logger?: Logger;
}

export interface RosterWatcher {
  /** False when the directory could not be watched; the roster still works. */
  readonly watching: boolean;
  /** Runs any pending debounce immediately. Tests use it; production does not. */
  flush(): void;
  close(): void;
}

/** A watcher that watches nothing — `library.watch: false`, or a failed start. */
export function inertWatcher(): RosterWatcher {
  return { watching: false, flush: () => {}, close: () => {} };
}

export function createRosterWatcher(options: RosterWatcherOptions): RosterWatcher {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pending = new Set<string>();
  let wholeLibrary = false;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let watcher: FSWatcher;

  function fire(): void {
    timer = undefined;
    if (closed) return;
    const folders = wholeLibrary ? undefined : [...pending];
    pending.clear();
    wholeLibrary = false;
    if (folders !== undefined && folders.length === 0) return;
    try {
      options.onChanged(folders);
    } catch (error) {
      options.logger?.error({ err: error }, 'roster watcher listener threw');
    }
  }

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
    // The watcher must never be the reason the process stays alive: it is a
    // convenience over a filesystem, and `stop()` should not have to race it.
    timer.unref();
  }

  try {
    watcher = watch(options.agentsDir, { recursive: true, persistent: false }, (_event, name) => {
      if (closed) return;
      if (name === null || name === undefined) {
        // Some platforms omit the filename under load. Rechecking everything is
        // the only correct response, and is exactly what a boot already does.
        wholeLibrary = true;
      } else {
        // `name` is relative to the watched directory: `priya-bugfix`,
        // `priya-bugfix\persona.md`, `priya-bugfix\skills\x\SKILL.md`. The first
        // segment is the agent folder, on either separator — a recursive watch
        // reports the platform's, and tests run on both.
        const folder = String(name).split(/[\\/]/)[0] ?? '';
        if (folder.length > 0 && !folder.startsWith('.')) pending.add(folder);
        else wholeLibrary = true;
      }
      schedule();
    });
  } catch (error) {
    options.logger?.warn(
      { err: error, dir: options.agentsDir },
      'the agent library could not be watched; external edits will need a restart to appear',
    );
    return inertWatcher();
  }

  watcher.on('error', (error) => {
    options.logger?.warn({ err: error }, 'the agent library watcher failed');
  });

  return {
    watching: true,
    flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        fire();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      watcher.close();
    },
  };
}
