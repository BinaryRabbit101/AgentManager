/**
 * The library watcher (roster DESIGN §2.3, IMPLEMENTATION M2).
 *
 * Acceptance: "Editing `persona.md` externally is reflected in the registry
 * within ~1s without a restart."
 *
 * The reflection test is a genuine wall-clock test — it writes a file and waits
 * for the operating system to say so — because that is exactly the claim being
 * made, and a fake timer would prove only that the debounce arithmetic is right.
 * It is kept to one test, with a short debounce, so the suite does not pay for
 * the guarantee more than once.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFixture } from './__tests__/fixtures.js';
import {
  makeSpacedTempDir,
  makeTempDir,
  wait,
  writeAgentFolder,
  type TempDir,
} from './__tests__/helpers.js';
import { createRosterRegistry } from './registry.js';
import { createRosterStore } from './store.js';
import { DEFAULT_DEBOUNCE_MS, createRosterWatcher, inertWatcher } from './watcher.js';

let temp: TempDir;
let agentsDir: string;
const closers: (() => void)[] = [];

beforeEach(() => {
  temp = makeTempDir('agentmanager-roster-watch-');
  agentsDir = join(temp.path, 'agents');
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
  for (const close of closers.splice(0)) close();
  temp.cleanup();
});

describe('debouncing (§2.3)', () => {
  it('collapses a burst of events on one folder into a single call', async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const watcher = createRosterWatcher({
      dir: agentsDir,
      debounceMs: 40,
      onChanged: (folders) => void seen.push(folders),
    });
    closers.push(() => watcher.close());

    const dir = join(agentsDir, 'priya-bugfix');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(dir, 'persona.md'), `edit ${String(i)}`, 'utf8');
    }
    await wait(300);

    expect(seen.length).toBeLessThanOrEqual(2);
    expect(seen.flatMap((folders) => folders ?? [])).toContain('priya-bugfix');
  });

  it('defaults to the ~250 ms §2.3 calls for', () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(250);
  });

  it('reports the folder, not the file inside it', async () => {
    const seen: string[] = [];
    const watcher = createRosterWatcher({
      dir: agentsDir,
      debounceMs: 30,
      onChanged: (folders) => void seen.push(...(folders ?? ['<whole library>'])),
    });
    closers.push(() => watcher.close());

    const deep = join(agentsDir, 'priya-bugfix', 'skills', 'triage-a-stack-trace');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'SKILL.md'), '# triage', 'utf8');
    await wait(300);

    expect(seen).toContain('priya-bugfix');
    expect(seen).not.toContain('SKILL.md');
  });

  it('stops calling back once closed', async () => {
    let calls = 0;
    const watcher = createRosterWatcher({
      dir: agentsDir,
      debounceMs: 20,
      onChanged: () => {
        calls += 1;
      },
    });
    watcher.close();

    writeFileSync(join(agentsDir, 'stray.txt'), 'x', 'utf8');
    await wait(120);
    expect(calls).toBe(0);
  });

  it('degrades to an inert watcher when the directory cannot be watched', () => {
    const watcher = createRosterWatcher({
      dir: join(temp.path, 'no-such-directory'),
      onChanged: () => {
        throw new Error('must not fire');
      },
    });
    expect(watcher.watching).toBe(false);
    // Closing an inert watcher is safe, which is what the module's `stop()`
    // relies on when `library.watch` is off.
    watcher.close();
    expect(inertWatcher().watching).toBe(false);
  });
});

describe('the registry reflects an external edit (M2 acceptance)', () => {
  it('picks up an edited persona.md within a second, without a restart', async () => {
    const definition = loadFixture('coder');
    writeAgentFolder(temp.path, definition, { persona: 'before' });

    const store = createRosterStore({ root: temp.path });
    const registry = createRosterRegistry(store);
    registry.reloadAll();
    expect(registry.get(definition.id)?.persona).toBe('before');

    const watcher = createRosterWatcher({
      dir: agentsDir,
      // The design's own figure. The acceptance allows ~1s; this leaves room
      // for the filesystem to notice as well as for the debounce.
      debounceMs: DEFAULT_DEBOUNCE_MS,
      onChanged: (folders) => {
        if (folders === undefined) registry.reloadAll();
        else for (const folder of folders) registry.reload(folder);
      },
    });
    closers.push(() => watcher.close());

    writeFileSync(join(agentsDir, definition.id, 'persona.md'), 'after', 'utf8');

    const deadline = Date.now() + 1000;
    while (registry.get(definition.id)?.persona !== 'after' && Date.now() < deadline) {
      await wait(25);
    }
    expect(registry.get(definition.id)?.persona).toBe('after');
  });

  it('works from a library path containing spaces', async () => {
    const spaced = makeSpacedTempDir('agentmanager roster watch ');
    try {
      const definition = loadFixture('minimal');
      writeAgentFolder(spaced.path, definition, { persona: 'before' });
      const store = createRosterStore({ root: spaced.path });
      const registry = createRosterRegistry(store);
      registry.reloadAll();

      const watcher = createRosterWatcher({
        dir: join(spaced.path, 'agents'),
        debounceMs: 30,
        onChanged: (folders) => {
          if (folders === undefined) registry.reloadAll();
          else for (const folder of folders) registry.reload(folder);
        },
      });
      closers.push(() => watcher.close());

      writeFileSync(join(spaced.path, 'agents', definition.id, 'persona.md'), 'after', 'utf8');
      const deadline = Date.now() + 1000;
      while (registry.get(definition.id)?.persona !== 'after' && Date.now() < deadline) {
        await wait(25);
      }
      expect(registry.get(definition.id)?.persona).toBe('after');
    } finally {
      spaced.cleanup();
    }
  });
});
