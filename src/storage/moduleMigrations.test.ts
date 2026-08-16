/**
 * Element-owned migrations (DESIGN §1.3), proven end to end through boot.
 *
 * IMPLEMENTATION §5: "A fixture module shipping `migrations/<moduleId>/0001_*.sql`
 * has its table created after the core set, in topological order relative to
 * its `dependsOn`; re-running the boot applies nothing further; and
 * `schema_migrations` carries one row naming the module and version."
 */
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MigrationError, MigrationSetError } from './errors.js';
import {
  moduleMigrationSets,
  schemaMigrationsTracker,
  type ModuleMigrations,
} from './migrations.js';
import { openStorage, type Storage } from './storage.js';
import { makeTempRoot, writeMigration, type TempRoot } from './__tests__/helpers.js';

let root: TempRoot;
let open: Storage[];

beforeEach(() => {
  root = makeTempRoot();
  open = [];
});

afterEach(() => {
  for (const storage of open) storage.close();
  root.cleanup();
});

/** Writes a fixture module's `migrations/<moduleId>/` directory. */
function fixtureModule(moduleId: string, files: Record<string, string>): ModuleMigrations {
  const dir = resolve(root.path, 'module-migrations', moduleId);
  for (const [filename, sql] of Object.entries(files)) writeMigration(dir, filename, sql);
  return { moduleId, dir };
}

function boot(moduleMigrations: readonly ModuleMigrations[]): Storage {
  const storage = openStorage({
    dataRoot: root.path,
    tightenAcl: false,
    moduleMigrations,
  });
  open.push(storage);
  return storage;
}

function close(storage: Storage): void {
  storage.close();
  open = open.filter((s) => s !== storage);
}

function tableExists(storage: Storage, name: string): boolean {
  return (
    storage.db
      .prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined
  );
}

interface LedgerRow {
  module: string;
  version: number;
  applied_at: string;
}

function ledger(storage: Storage): LedgerRow[] {
  return storage.db
    .prepare<[], LedgerRow>(
      'SELECT module, version, applied_at FROM schema_migrations ORDER BY module, version',
    )
    .all();
}

describe('element-owned migrations through boot', () => {
  it('creates a fixture module table after the core set and records it once', () => {
    const roster = fixtureModule('roster', {
      // References `agents`, which only exists if foundation's set ran first.
      '0001_agent_ui_state.sql':
        'CREATE TABLE agent_ui_state (agent_id TEXT PRIMARY KEY, collapsed INTEGER NOT NULL DEFAULT 0) STRICT;\n' +
        'INSERT INTO agent_ui_state (agent_id) SELECT id FROM agents WHERE 1 = 0;',
    });

    const storage = boot([roster]);

    expect(tableExists(storage, 'agent_ui_state')).toBe(true);
    // Foundation's set stays on `user_version`; the module's is in the ledger.
    expect(storage.schemaVersion).toBe(1);
    expect(storage.setVersions).toEqual({ foundation: 1, roster: 1 });
    expect(storage.applied).toEqual([
      { setId: 'foundation', version: 1, name: 'init' },
      { setId: 'roster', version: 1, name: 'agent_ui_state' },
    ]);

    const rows = ledger(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.module).toBe('roster');
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('applies module sets in the order given — the topological order of dependsOn', () => {
    // `projects` depends on nothing; `orchestrator` dependsOn ['projects'] and
    // its migration references a table `projects` creates. Given in topological
    // order, this works; the reverse order is the failure case below.
    const projects = fixtureModule('projects', {
      '0001_work_items.sql': 'CREATE TABLE work_items (id TEXT PRIMARY KEY) STRICT;',
    });
    const orchestrator = fixtureModule('orchestrator', {
      '0001_work_item_assignments.sql':
        'CREATE TABLE work_item_assignments (\n' +
        '  work_item_id TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,\n' +
        '  assignment_id TEXT NOT NULL REFERENCES assignments (id) ON DELETE CASCADE,\n' +
        '  PRIMARY KEY (work_item_id, assignment_id)\n' +
        ') STRICT;',
    });

    const storage = boot([projects, orchestrator]);

    expect(storage.applied.map((m) => `${m.setId}:${m.version}`)).toEqual([
      'foundation:1',
      'projects:1',
      'orchestrator:1',
    ]);
    expect(ledger(storage).map((r) => `${r.module}:${r.version}`)).toEqual([
      'orchestrator:1',
      'projects:1',
    ]);
  });

  it('fails when a dependent module is ordered before the one it depends on', () => {
    const projects = fixtureModule('projects', {
      '0001_work_items.sql': 'CREATE TABLE work_items (id TEXT PRIMARY KEY) STRICT;',
    });
    const orchestrator = fixtureModule('orchestrator', {
      // `work_items` does not exist yet in this order.
      '0001_link.sql': 'CREATE INDEX work_items_probe ON work_items (id);',
    });

    expect(() => boot([orchestrator, projects])).toThrow(MigrationError);
  });

  it('re-running the boot applies nothing further and adds no ledger row', () => {
    const roster = fixtureModule('roster', {
      '0001_agent_ui_state.sql': 'CREATE TABLE agent_ui_state (agent_id TEXT PRIMARY KEY) STRICT;',
    });

    const first = boot([roster]);
    expect(first.applied).toHaveLength(2);
    close(first);

    const second = boot([roster]);
    expect(second.applied).toEqual([]);
    expect(second.backupPath).toBeUndefined();
    expect(ledger(second)).toHaveLength(1);
    expect(tableExists(second, 'agent_ui_state')).toBe(true);
  });

  it('applies a module 0002 on a later boot, leaving user_version alone', () => {
    const roster = fixtureModule('roster', {
      '0001_agent_ui_state.sql': 'CREATE TABLE agent_ui_state (agent_id TEXT PRIMARY KEY) STRICT;',
    });
    close(boot([roster]));

    writeMigration(
      roster.dir,
      '0002_pin.sql',
      'ALTER TABLE agent_ui_state ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;',
    );

    const second = boot([roster]);
    expect(second.applied).toEqual([{ setId: 'roster', version: 2, name: 'pin' }]);
    expect(second.schemaVersion).toBe(1);
    expect(second.db.pragma('user_version', { simple: true })).toBe(1);
    expect(ledger(second).map((r) => r.version)).toEqual([1, 2]);
  });

  it('rolls a failing module migration back and leaves the module at its prior version', () => {
    const roster = fixtureModule('roster', {
      '0001_ok.sql': 'CREATE TABLE agent_ui_state (agent_id TEXT PRIMARY KEY) STRICT;',
    });
    close(boot([roster]));

    writeMigration(roster.dir, '0002_broken.sql', 'CREATE TABLE half (id TEXT); NOT SQL AT ALL;');
    expect(() => boot([roster])).toThrow(MigrationError);

    // A clean re-boot without the broken file finds the module still at 1.
    writeMigration(roster.dir, '0002_broken.sql', '-- fixed: intentionally empty');
    const recovered = boot([roster]);
    expect(tableExists(recovered, 'half')).toBe(false);
    expect(ledger(recovered).map((r) => r.version)).toEqual([1, 2]);
  });

  it('skips a module that ships no migrations directory at all', () => {
    const storage = boot([{ moduleId: 'http', dir: resolve(root.path, 'nope') }]);
    expect(storage.applied).toEqual([{ setId: 'foundation', version: 1, name: 'init' }]);
    expect(ledger(storage)).toEqual([]);
  });
});

describe('moduleMigrationSets', () => {
  it('refuses the reserved foundation set id — user_version must not contend', () => {
    const storage = boot([]);
    expect(() =>
      moduleMigrationSets(storage.db, [{ moduleId: 'foundation', dir: root.path }]),
    ).toThrow(MigrationSetError);
  });

  it('refuses the same module twice', () => {
    const storage = boot([]);
    expect(() =>
      moduleMigrationSets(storage.db, [
        { moduleId: 'roster', dir: root.path },
        { moduleId: 'roster', dir: root.path },
      ]),
    ).toThrow(/appears twice/);
  });

  it('preserves the order it is given rather than sorting it itself', () => {
    const storage = boot([]);
    const dirs = ['c', 'a', 'b'].map((id) => fixtureModule(id, { '0001_x.sql': '' }));
    expect(moduleMigrationSets(storage.db, dirs).map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('schemaMigrationsTracker', () => {
  it('starts at 0 for an unknown module and reports the highest applied version', () => {
    const storage = boot([]);
    const tracker = schemaMigrationsTracker(storage.db, 'roster');

    expect(tracker.current()).toBe(0);
    tracker.record({ version: 1, name: 'a', filename: '0001_a.sql', path: 'a' });
    tracker.record({ version: 4, name: 'b', filename: '0004_b.sql', path: 'b' });

    expect(tracker.current()).toBe(4);
    // Per-module, not global: another module's ledger is untouched.
    expect(schemaMigrationsTracker(storage.db, 'projects').current()).toBe(0);
  });
});
