/**
 * The in-memory registry (roster DESIGN §2.3, IMPLEMENTATION M2).
 *
 * Acceptance covered here:
 * - "Registry loads all fixtures from a temp directory; counts and ids match";
 * - "Corrupting one `agent.json` on disk removes exactly that agent from the
 *   registry, adds one diagnostic, and leaves the others loadable".
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FIXTURE_NAMES, loadFixture } from './__tests__/fixtures.js';
import {
  makeTempDir,
  writeAgentFolder,
  writeFixtureAgent,
  type TempDir,
} from './__tests__/helpers.js';
import { createRosterRegistry, type RosterRegistry } from './registry.js';
import { createRosterStore, type RosterStore } from './store.js';

const NOW = new Date('2026-08-16T10:35:00.000Z');

let temp: TempDir;
let store: RosterStore;
let registry: RosterRegistry;

beforeEach(() => {
  temp = makeTempDir('agentmanager-roster-registry-');
  mkdirSync(join(temp.path, 'agents'), { recursive: true });
  store = createRosterStore({ root: temp.path, clock: () => NOW });
  registry = createRosterRegistry(store);
});

afterEach(() => {
  temp.cleanup();
});

function writeAll(): string[] {
  return FIXTURE_NAMES.map((name) => writeFixtureAgent(temp.path, name).id).sort();
}

describe('loading a library', () => {
  it('loads every fixture, with matching counts and ids', () => {
    const ids = writeAll();
    const change = registry.reloadAll();

    expect(registry.list()).toHaveLength(FIXTURE_NAMES.length);
    expect(registry.list().map((agent) => agent.definition.id)).toEqual(ids);
    expect(change.changed).toBe(true);
    expect(change.agentIds).toEqual(ids);
    expect(registry.diagnostics()).toEqual([]);
  });

  it('reports no change when nothing on disk moved', () => {
    writeAll();
    registry.reloadAll();
    expect(registry.reloadAll()).toEqual({ changed: false, agentIds: [] });
  });

  it('is empty, and does not throw, against a library with no agents/ at all', () => {
    rmSync(join(temp.path, 'agents'), { recursive: true, force: true });
    expect(registry.reloadAll().changed).toBe(false);
    expect(registry.list()).toEqual([]);
  });
});

describe('one corrupt definition (§2.3)', () => {
  it('removes exactly that agent, adds one diagnostic, and leaves the rest', () => {
    const ids = writeAll();
    registry.reloadAll();

    writeFileSync(join(temp.path, 'agents', 'priya-bugfix', 'agent.json'), '{ broken', 'utf8');
    const change = registry.reloadAll();

    expect(change.agentIds).toEqual(['priya-bugfix']);
    expect(registry.get('priya-bugfix')).toBeUndefined();
    expect(registry.list().map((agent) => agent.definition.id)).toEqual(
      ids.filter((id) => id !== 'priya-bugfix'),
    );
    expect(registry.diagnostics()).toHaveLength(1);
    expect(registry.diagnostics()[0]?.code).toBe('roster.invalid-definition');
    expect(registry.diagnostics()[0]?.agentId).toBe('priya-bugfix');
  });

  it('still knows the broken id exists, so it can never be minted again', () => {
    writeFixtureAgent(temp.path, 'coder');
    writeFileSync(join(temp.path, 'agents', 'priya-bugfix', 'agent.json'), 'nonsense', 'utf8');
    registry.reloadAll();

    expect(registry.get('priya-bugfix')).toBeUndefined();
    expect(registry.knows('priya-bugfix')).toBe(true);
  });

  it('does not re-announce a broken file that is still broken the same way', () => {
    writeFixtureAgent(temp.path, 'coder');
    writeFileSync(join(temp.path, 'agents', 'priya-bugfix', 'agent.json'), 'nonsense', 'utf8');
    expect(registry.reloadAll().changed).toBe(true);
    expect(registry.reloadAll().changed).toBe(false);
  });

  it('announces the repair when the file is fixed', () => {
    const definition = writeFixtureAgent(temp.path, 'coder');
    writeFileSync(join(temp.path, 'agents', definition.id, 'agent.json'), 'nonsense', 'utf8');
    registry.reloadAll();

    writeAgentFolder(temp.path, definition);
    const change = registry.reloadAll();

    expect(change.agentIds).toEqual([definition.id]);
    expect(registry.get(definition.id)?.definition.name).toBe(definition.name);
    expect(registry.diagnostics()).toEqual([]);
  });
});

describe('per-folder reload — the watcher’s path', () => {
  it('picks up an edited persona without rereading the library', () => {
    const definition = writeFixtureAgent(temp.path, 'coder', { persona: 'first' });
    registry.reloadAll();

    writeFileSync(join(temp.path, 'agents', definition.id, 'persona.md'), 'second', 'utf8');
    const change = registry.reload(definition.id);

    expect(change.agentIds).toEqual([definition.id]);
    expect(registry.get(definition.id)?.persona).toBe('second');
  });

  it('drops an agent whose folder was deleted', () => {
    const definition = writeFixtureAgent(temp.path, 'coder');
    registry.reloadAll();
    rmSync(join(temp.path, 'agents', definition.id), { recursive: true, force: true });

    expect(registry.reload(definition.id).agentIds).toEqual([definition.id]);
    expect(registry.get(definition.id)).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('says nothing about a folder that never existed', () => {
    expect(registry.reload('not-here')).toEqual({ changed: false, agentIds: [] });
  });
});

describe('archived agents (§9.3)', () => {
  it('are loaded, kept out of the listing, and readable by id', () => {
    const definition = writeFixtureAgent(temp.path, 'coder', { persona: 'archived body' });
    registry.reloadAll();
    store.archive(definition.id);
    registry.forget(definition.id);
    registry.refreshArchive();

    expect(registry.list()).toEqual([]);
    expect(registry.get(definition.id)).toBeUndefined();
    const archived = registry.getArchived(definition.id);
    expect(archived?.definition.name).toBe(definition.name);
    expect(archived?.persona).toBe('archived body');
    expect(archived?.archivedAt).toBe(NOW.toISOString());
    // An archived id is still issued, so a later create cannot reuse it.
    expect(registry.knows(definition.id)).toBe(true);
  });

  it('keeps only the most recent archive of an id', () => {
    const definition = loadFixture('coder');
    writeAgentFolder(temp.path, definition, { persona: 'life one' });
    const first = createRosterStore({
      root: temp.path,
      clock: () => new Date('2026-08-16T09:00:00.000Z'),
    });
    first.archive(definition.id);

    writeAgentFolder(temp.path, definition, { persona: 'life two' });
    store.archive(definition.id);

    registry.reloadAll();
    expect(registry.getArchived(definition.id)?.persona).toBe('life two');
  });
});

describe('apply and forget — the write path', () => {
  it('records a freshly written agent without a reread', () => {
    const definition = loadFixture('minimal');
    const written = store.write(definition, 'body');

    expect(registry.apply(written)).toEqual({ changed: true, agentIds: [definition.id] });
    expect(registry.get(definition.id)?.persona).toBe('body');
    // The same bytes twice is not a change, which is what keeps the watcher and
    // the writer from feeding each other.
    expect(registry.apply(written)).toEqual({ changed: false, agentIds: [] });
  });

  it('forgets an id exactly once', () => {
    const written = store.write(loadFixture('minimal'), '');
    registry.apply(written);

    expect(registry.forget('nils').changed).toBe(true);
    expect(registry.forget('nils').changed).toBe(false);
  });
});
