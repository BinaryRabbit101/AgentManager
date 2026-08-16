/**
 * The data-root directory layout of DESIGN §1.2, resolved once.
 *
 * Nothing else in the tree derives a path under the data root by string
 * concatenation: every consumer takes a {@link DataRootPaths} so the layout can
 * only be wrong in one place. The install root is deliberately absent — it is
 * never written at runtime, and locating it is the launcher's problem.
 */
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

/** Absolute paths to every directory and file the data root owns. */
export interface DataRootPaths {
  /** `%LOCALAPPDATA%\AgentManager\` by default; everything below is under it. */
  readonly dataRoot: string;
  /** `<dataRoot>\config\` — machine-local `config.json` (config layer 3, §2.1). */
  readonly config: string;
  /**
   * The library root. `<dataRoot>\library\` by default, but relocatable (§1.2,
   * config `library.root`), so it is not assumed to live under the data root.
   */
  readonly library: string;
  /** `<dataRoot>\state\` — everything the service generates and can lose without losing the roster. */
  readonly state: string;
  /** `<dataRoot>\state\agentmanager.db` — the one SQLite file (WAL siblings alongside). */
  readonly database: string;
  /** `<dataRoot>\state\backups\` — pre-migration copies, `agentmanager-<schemaVersion>-<ts>.db`. */
  readonly backups: string;
  /** `<dataRoot>\state\transcripts\` — `<YYYY>\<MM>\<session-id>.jsonl` (§1.5; writer is M5). */
  readonly transcripts: string;
  /** `<dataRoot>\state\logs\` — `core.log`, rotations, `access.log` (§5.1). */
  readonly logs: string;
  /** `<dataRoot>\state\secrets\` — the DPAPI envelope, or the keyfile fallback (§3.1). */
  readonly secrets: string;
  /** `<dataRoot>\worktrees\` — git worktrees; relocatable via `projects.worktreesRoot`. */
  readonly worktrees: string;
  /** `<dataRoot>\run\` — `core.lock`, `core.port`. Recreated on boot if missing. */
  readonly run: string;
  /** `<dataRoot>\cache\` — regenerable; safe to delete. Recreated on boot if missing. */
  readonly cache: string;
}

/** Overrides for roots that DESIGN §1.2 allows to live outside the data root. */
export interface DataRootPathOptions {
  /** Absolute path to the library root. Defaults to `<dataRoot>\library`. */
  readonly libraryRoot?: string;
  /** Absolute path to the worktrees root. Defaults to `<dataRoot>\worktrees`. */
  readonly worktreesRoot?: string;
}

/** The SQLite filename, fixed by §1.2. */
export const DATABASE_FILENAME = 'agentmanager.db';

function requireAbsolute(label: string, value: string): string {
  const resolved = resolve(value);
  if (!isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path (received ${JSON.stringify(value)})`);
  }
  return resolved;
}

/** Resolves the §1.2 layout for a given data root. Purely arithmetic — touches no disk. */
export function dataRootPaths(dataRoot: string, options: DataRootPathOptions = {}): DataRootPaths {
  const root = requireAbsolute('dataRoot', dataRoot);
  const state = resolve(root, 'state');

  return {
    dataRoot: root,
    config: resolve(root, 'config'),
    library:
      options.libraryRoot === undefined
        ? resolve(root, 'library')
        : requireAbsolute('libraryRoot', options.libraryRoot),
    state,
    database: resolve(state, DATABASE_FILENAME),
    backups: resolve(state, 'backups'),
    transcripts: resolve(state, 'transcripts'),
    logs: resolve(state, 'logs'),
    secrets: resolve(state, 'secrets'),
    worktrees:
      options.worktreesRoot === undefined
        ? resolve(root, 'worktrees')
        : requireAbsolute('worktreesRoot', options.worktreesRoot),
    run: resolve(root, 'run'),
    cache: resolve(root, 'cache'),
  };
}

/**
 * Every directory the bootstrap creates, in creation order.
 *
 * Directories only: contents belong to the elements that own them (the
 * library's `roster.json` and `.gitignore` are roster's on first run, §4.4).
 *
 * §1.2 singles out `run/` and `cache/` as "recreated on boot if missing", but
 * the bootstrap repairs any missing directory in this list — the distinction
 * the design draws is about which absences are *expected*, not about needing a
 * second code path for them.
 */
export function managedDirectories(paths: DataRootPaths): readonly string[] {
  return [
    paths.dataRoot,
    paths.config,
    paths.library,
    paths.state,
    paths.backups,
    paths.transcripts,
    paths.logs,
    paths.secrets,
    paths.worktrees,
    paths.run,
    paths.cache,
  ];
}

/**
 * The directory holding foundation's own numbered migration set.
 *
 * Resolved relative to this module rather than to `process.cwd()`, so it is
 * correct whether the code is running from `src/` under vitest or from `dist/`
 * under the scheduled task — both sit one level below the package root.
 */
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}
