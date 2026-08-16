/**
 * The element migration and the typed repository (projects IMPLEMENTATION M1).
 *
 * Acceptance covered here:
 *
 * - "The element migration applies after foundation's core set, is idempotent on
 *   re-run, and registers in `schema_migrations` under module `projects`" —
 *   *the element migration*;
 * - "Round-trip create/read/update/delete unit tests pass; `defaults_json` and
 *   `retention_json` parse into typed objects with defaults applied for missing
 *   fields" — *CRUD round trip*;
 * - the identity half of "a second registration of any of them is rejected" —
 *   the database's `local_path_key UNIQUE`, with the typed refusal above it
 *   proven in `registration.test.ts`.
 *
 * Everything runs against a real SQLite file under a temp data root, with the
 * real `migrations/` tree — a fixture schema would prove nothing about the SQL
 * that ships.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RecordNotFoundError, type Storage } from '../../storage/index.js';

import { createProjectRepository, type ProjectRepository } from './repository.js';
import { BUILT_IN_RETENTION_DEFAULTS } from './types.js';
import { makeTempDir, openTestStorage, type TempDir } from './__tests__/helpers.js';

let temp: TempDir;
let storage: Storage | undefined;
let repository: ProjectRepository;

/** The element's own tables, exactly as `migrations/projects/0001_registry.sql` names them. */
const ELEMENT_TABLES = [
  'project_default_agents',
  'work_items',
  'work_item_assignments',
  'workspace_leases',
];

function open(): Storage {
  const opened = openTestStorage(temp.path);
  storage = opened;
  repository = createProjectRepository({
    db: opened.db,
    projects: opened.store.projects,
    retentionDefaults: BUILT_IN_RETENTION_DEFAULTS,
    clock: () => new Date('2026-08-16T10:00:00.000Z'),
  });
  return opened;
}

function close(): void {
  storage?.close();
  storage = undefined;
}

function tableNames(open: Storage): string[] {
  return open.db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
}

/** A minimal registrable project. Paths are strings here; canonicalisation is `paths.ts`'s. */
function sampleInput(overrides: Partial<Parameters<ProjectRepository['create']>[0]> = {}) {
  return {
    name: 'App',
    slug: 'app',
    localPath: 'C:\\Code\\App',
    localPathKey: 'c:\\code\\app',
    vcs: 'git' as const,
    ...overrides,
  };
}

beforeEach(() => {
  temp = makeTempDir('agentmanager-projects-repo-');
});

afterEach(() => {
  close();
  temp.cleanup();
});

describe('the element migration', () => {
  it('creates this element’s four tables after foundation’s core set', () => {
    const opened = open();
    const names = tableNames(opened);

    for (const table of ELEMENT_TABLES) expect(names).toContain(table);
    // Foundation's, applied first — this element codes against it rather than
    // shipping it (§1.3, §1.4).
    expect(names).toContain('projects');
    expect(opened.schemaVersion).toBeGreaterThan(0);
  });

  it('registers in schema_migrations under module "projects"', () => {
    const opened = open();
    const rows = opened.db
      .prepare<[], { module: string; version: number; applied_at: string }>(
        'SELECT module, version, applied_at FROM schema_migrations ORDER BY module, version',
      )
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.module).toBe('projects');
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(opened.setVersions['projects']).toBe(1);
  });

  it('is idempotent: a second open applies nothing further', () => {
    const first = open();
    expect(first.applied.filter((entry) => entry.setId === 'projects')).toHaveLength(1);
    close();

    const second = open();
    expect(second.applied).toHaveLength(0);
    expect(second.setVersions['projects']).toBe(1);
    for (const table of ELEMENT_TABLES) expect(tableNames(second)).toContain(table);
    expect(
      second.db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM schema_migrations WHERE module = 'projects'",
        )
        .get()?.n,
    ).toBe(1);
  });

  it('cascades this element’s rows when a project row goes away', () => {
    const opened = open();
    const project = repository.create(sampleInput({ defaults: { agentIds: ['architect'] } }));
    opened.db
      .prepare<[string, string, string, string, string]>(
        'INSERT INTO workspace_leases (id, project_id, assignment_id, kind, path, "write", acquired_at) ' +
          "VALUES (?, ?, ?, 'primary', ?, 1, ?)",
      )
      .run('lease-1', project.id, 'assignment-1', project.localPath, '2026-08-16T10:00:00.000Z');

    expect(repository.delete(project.id)).toBe(true);
    expect(
      opened.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM workspace_leases').get()?.n,
    ).toBe(0);
    expect(
      opened.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM project_default_agents').get()
        ?.n,
    ).toBe(0);
  });
});

describe('CRUD round trip', () => {
  it('creates and reads a project back fully typed', () => {
    open();
    const created = repository.create(
      sampleInput({
        repoUrl: 'https://example.invalid/app.git',
        defaultBranch: 'main',
        notes: '# App\n\nNotes.',
      }),
    );

    expect(created.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(created.slug).toBe('app');
    expect(created.localPathKey).toBe('c:\\code\\app');
    expect(created.vcs).toBe('git');
    expect(created.status).toBe('active');
    expect(created.workspacePolicy).toBe('auto');
    expect(created.defaults).toEqual({ agentIds: [] });
    // NULL retention means "inherit the globals", not "no retention" (§3.3).
    expect(created.retention).toBeNull();
    expect(created.archivedAt).toBeNull();

    expect(repository.get(created.id)).toEqual(created);
    expect(repository.getBySlug('app')).toEqual(created);
    expect(repository.getByPathKey('c:\\code\\app')).toEqual(created);
    expect(repository.list()).toEqual([created]);
  });

  it('applies defaults for every field a stored retention blob omits', () => {
    const opened = open();
    const created = repository.create(sampleInput());
    // Written through foundation's repository, the way a partial blob actually
    // arrives: an older build, a newer one, or a hand edit in a DB browser.
    opened.store.projects.update(created.id, { retentionJson: '{"transcriptDays":30}' });

    expect(repository.get(created.id)?.retention).toEqual({
      transcriptDays: 30,
      transcriptCapMb: 500,
      keepPinned: true,
    });
  });

  it('reads a project whose defaults_json is corrupt, reporting rather than failing', () => {
    const opened = open();
    const warnings: string[] = [];
    const created = repository.create(sampleInput());
    opened.store.projects.update(created.id, { defaultsJson: '{not json' });

    const tolerant = createProjectRepository({
      db: opened.db,
      projects: opened.store.projects,
      retentionDefaults: BUILT_IN_RETENTION_DEFAULTS,
      clock: () => new Date('2026-08-16T10:00:00.000Z'),
      onWarning: (_id, message) => warnings.push(message),
    });

    expect(tolerant.get(created.id)?.defaults).toEqual({ agentIds: [] });
    expect(warnings[0]).toContain('not parseable');
  });

  it('updates name, notes, policy, defaults and retention', () => {
    open();
    const created = repository.create(sampleInput());
    const updated = repository.update(created.id, {
      name: 'Renamed',
      notes: 'now with notes',
      workspacePolicy: 'worktree',
      defaults: { agentIds: ['architect', 'skeptic'], setupCommand: 'npm ci' },
      retention: { transcriptDays: 14, transcriptCapMb: 100, keepPinned: false },
    });

    expect(updated.name).toBe('Renamed');
    expect(updated.notes).toBe('now with notes');
    expect(updated.workspacePolicy).toBe('worktree');
    expect(updated.defaults.setupCommand).toBe('npm ci');
    expect(updated.defaults.agentIds).toEqual(['architect', 'skeptic']);
    expect(updated.retention).toEqual({
      transcriptDays: 14,
      transcriptCapMb: 100,
      keepPinned: false,
    });
    // Identity is untouched by a rename — the whole point of §7.4.
    expect(updated.id).toBe(created.id);
    expect(updated.localPathKey).toBe(created.localPathKey);
    expect(repository.get(created.id)).toEqual(updated);
  });

  it('takes `retention: null` as "go back to inheriting the globals"', () => {
    open();
    const created = repository.create(
      sampleInput({ retention: { transcriptDays: 14, transcriptCapMb: 100, keepPinned: false } }),
    );
    expect(repository.update(created.id, { retention: null }).retention).toBeNull();
  });

  it('archives without deleting, and excludes archived from the default list', () => {
    open();
    const created = repository.create(sampleInput());
    const archived = repository.archive(created.id);

    expect(archived.archivedAt).not.toBeNull();
    expect(repository.list()).toEqual([]);
    expect(repository.list({ includeArchived: true })).toHaveLength(1);
  });

  it('deletes, and refuses to update a project that is gone', () => {
    open();
    const created = repository.create(sampleInput());
    expect(repository.delete(created.id)).toBe(true);
    expect(repository.get(created.id)).toBeUndefined();
    expect(repository.list({ includeArchived: true })).toEqual([]);
    expect(() => repository.update(created.id, { name: 'x' })).toThrow(RecordNotFoundError);
  });

  it('stamps lastActivityAt on touch', () => {
    open();
    const created = repository.create(sampleInput());
    expect(created.lastActivityAt).toBeNull();
    repository.touch(created.id, '2026-08-16T12:00:00.000Z');
    expect(repository.get(created.id)?.lastActivityAt).toBe('2026-08-16T12:00:00.000Z');
  });
});

describe('default agents', () => {
  it('keeps the declared order and collapses duplicates', () => {
    open();
    const project = repository.create(sampleInput());
    repository.setDefaultAgents(project.id, ['skeptic', 'architect', 'skeptic', 'reviewer']);

    expect(repository.defaultAgents(project.id)).toEqual(['skeptic', 'architect', 'reviewer']);
    expect(repository.get(project.id)?.defaults.agentIds).toEqual([
      'skeptic',
      'architect',
      'reviewer',
    ]);
  });

  it('is replaced wholesale, not merged', () => {
    open();
    const project = repository.create(sampleInput({ defaults: { agentIds: ['a', 'b'] } }));
    repository.setDefaultAgents(project.id, ['c']);
    expect(repository.get(project.id)?.defaults.agentIds).toEqual(['c']);
  });

  it('never appears in defaults_json — the list is relational (§1.2)', () => {
    const opened = open();
    const project = repository.create(sampleInput({ defaults: { agentIds: ['architect'] } }));
    const stored = opened.store.projects.get(project.id)?.defaultsJson;
    expect(stored).toBe('{}');
  });
});

describe('slug allocation', () => {
  it('produces app, app-2, app-3 against the live registry', () => {
    open();
    expect(repository.allocateSlug('App')).toBe('app');
    repository.create(sampleInput({ slug: 'app', localPathKey: 'c:\\a' }));
    expect(repository.allocateSlug('App')).toBe('app-2');
    repository.create(sampleInput({ slug: 'app-2', localPathKey: 'c:\\b' }));
    expect(repository.allocateSlug('App')).toBe('app-3');
  });
});

describe('path identity in the database', () => {
  it('refuses a second row for the same local_path_key', () => {
    open();
    repository.create(sampleInput());
    expect(() => repository.create(sampleInput({ slug: 'app-2' }))).toThrow(/UNIQUE/i);
  });

  it('refuses a second row for the same slug', () => {
    open();
    repository.create(sampleInput());
    expect(() => repository.create(sampleInput({ localPathKey: 'c:\\code\\other' }))).toThrow(
      /UNIQUE/i,
    );
  });
});
