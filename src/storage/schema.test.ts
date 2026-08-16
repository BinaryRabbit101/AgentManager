/**
 * The core schema of DESIGN §1.4, pinned.
 *
 * IMPLEMENTATION §5: "Every table, index, and FK from §1.4 exists; a schema
 * snapshot test guards against accidental drift. **The snapshot covers
 * foundation-owned tables only** — element migrations vary by which modules are
 * enabled, so including them would make the snapshot a flapping test of module
 * configuration."
 *
 * The snapshot is written out longhand rather than captured by
 * `toMatchSnapshot`, deliberately: a captured snapshot is one `-u` away from
 * recording whatever the schema happens to be, and this file is supposed to be
 * the contract other elements code against. Changing it should require typing
 * the new contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStorage, type Storage } from './storage.js';
import { makeTempRoot, type TempRoot } from './__tests__/helpers.js';

interface TableShape {
  readonly columns: readonly string[];
  readonly indexes: readonly string[];
  readonly foreignKeys: readonly string[];
}

/**
 * The tables foundation owns. Anything else in `sqlite_master` belongs to a
 * module's own set and is out of scope here by IMPLEMENTATION §5.
 */
const FOUNDATION_TABLES = [
  'agents',
  'assignment_members',
  'assignments',
  'events',
  'messages',
  'projects',
  'question_recommendations',
  'questions',
  'remote_tokens',
  'schema_meta',
  'schema_migrations',
  'session_usage',
  'sessions',
  'settings',
  'usage_events',
] as const;

const EXPECTED: Readonly<Record<(typeof FOUNDATION_TABLES)[number], TableShape>> = {
  agents: {
    columns: [
      'id TEXT NOT NULL PK1',
      'name TEXT NOT NULL',
      'specialty TEXT',
      'model TEXT',
      'is_overseer INTEGER NOT NULL DEFAULT 0',
      'archived_at TEXT',
      'source_path TEXT',
      'content_hash TEXT',
      'indexed_at TEXT NOT NULL',
    ],
    indexes: [],
    // No FK from anywhere into `agents`, and none out: it is a rebuildable
    // index of the library, not a record of fact (§1.4).
    foreignKeys: [],
  },
  assignment_members: {
    columns: [
      'assignment_id TEXT NOT NULL PK1',
      'agent_id TEXT NOT NULL PK2',
      'role TEXT NOT NULL',
    ],
    indexes: ['assignment_members_agent_idx (agent_id)'],
    foreignKeys: ['assignment_id -> assignments.id ON DELETE CASCADE'],
  },
  assignments: {
    columns: [
      'id TEXT NOT NULL PK1',
      'project_id TEXT NOT NULL',
      'pattern TEXT NOT NULL',
      'scope_json TEXT',
      'goal TEXT',
      "status TEXT NOT NULL DEFAULT 'open'",
      'token_budget INTEGER',
      'tokens_used INTEGER NOT NULL DEFAULT 0',
      'round_cap INTEGER',
      'rounds_used INTEGER NOT NULL DEFAULT 0',
      'created_at TEXT NOT NULL',
      'closed_at TEXT',
      'close_reason TEXT',
    ],
    indexes: ['assignments_project_idx (project_id, created_at)'],
    foreignKeys: ['project_id -> projects.id ON DELETE RESTRICT'],
  },
  events: {
    columns: [
      'id TEXT NOT NULL PK1',
      'ts TEXT NOT NULL',
      'type TEXT NOT NULL',
      'session_id TEXT',
      'assignment_id TEXT',
      'project_id TEXT',
      'agent_id TEXT',
      'payload_json TEXT',
    ],
    indexes: ['events_ts_idx (ts, id)', 'events_type_idx (type, id)'],
    // Deliberately none: an event about a project must neither block deleting
    // it nor vanish with it.
    foreignKeys: [],
  },
  messages: {
    columns: [
      'id TEXT NOT NULL PK1',
      'assignment_id TEXT NOT NULL',
      'from_agent_id TEXT',
      'to_agent_id TEXT',
      'kind TEXT NOT NULL',
      'body TEXT',
      'payload_json TEXT',
      'created_at TEXT NOT NULL',
      'delivered_at TEXT',
      'read_at TEXT',
    ],
    indexes: [
      'messages_assignment_idx (assignment_id, created_at)',
      'messages_mailbox_idx (to_agent_id, read_at, created_at)',
    ],
    foreignKeys: ['assignment_id -> assignments.id ON DELETE CASCADE'],
  },
  projects: {
    columns: [
      'id TEXT NOT NULL PK1',
      'slug TEXT NOT NULL',
      'name TEXT NOT NULL',
      'local_path TEXT',
      'local_path_key TEXT',
      'repo_url TEXT',
      'default_branch TEXT',
      'vcs TEXT',
      'notes TEXT',
      "status TEXT NOT NULL DEFAULT 'active'",
      'workspace_policy TEXT',
      'defaults_json TEXT',
      'retention_json TEXT',
      'created_at TEXT NOT NULL',
      'updated_at TEXT NOT NULL',
      'last_activity_at TEXT',
      'archived_at TEXT',
    ],
    indexes: [
      'sqlite_autoindex_projects_2 UNIQUE (slug)',
      'sqlite_autoindex_projects_3 UNIQUE (local_path_key)',
    ],
    foreignKeys: [],
  },
  question_recommendations: {
    columns: [
      'question_id TEXT NOT NULL PK1',
      'agent_id TEXT NOT NULL PK2',
      'stance TEXT NOT NULL',
      'rationale TEXT',
      'strength TEXT',
    ],
    indexes: [],
    foreignKeys: ['question_id -> questions.id ON DELETE CASCADE'],
  },
  questions: {
    columns: [
      'id TEXT NOT NULL PK1',
      'assignment_id TEXT NOT NULL',
      'session_id TEXT',
      'kind TEXT NOT NULL',
      "status TEXT NOT NULL DEFAULT 'open'",
      'prompt TEXT NOT NULL',
      'options_json TEXT',
      'created_at TEXT NOT NULL',
      'answered_at TEXT',
      'answer_json TEXT',
      'answered_via TEXT',
    ],
    indexes: [
      'questions_assignment_idx (assignment_id, created_at)',
      'questions_open_idx PARTIAL (created_at)',
    ],
    foreignKeys: [
      'assignment_id -> assignments.id ON DELETE CASCADE',
      'session_id -> sessions.id ON DELETE CASCADE',
    ],
  },
  remote_tokens: {
    columns: [
      'id TEXT NOT NULL PK1',
      'label TEXT NOT NULL',
      'device TEXT',
      'token_hash TEXT NOT NULL',
      'token_prefix TEXT NOT NULL',
      'created_at TEXT NOT NULL',
      'last_used_at TEXT',
      'expires_at TEXT',
      'revoked_at TEXT',
    ],
    indexes: ['sqlite_autoindex_remote_tokens_2 UNIQUE (token_hash)'],
    foreignKeys: [],
  },
  schema_meta: {
    columns: ['key TEXT NOT NULL PK1', 'value TEXT NOT NULL'],
    indexes: [],
    foreignKeys: [],
  },
  schema_migrations: {
    columns: [
      'module TEXT NOT NULL PK1',
      'version INTEGER NOT NULL PK2',
      'applied_at TEXT NOT NULL',
    ],
    indexes: [],
    foreignKeys: [],
  },
  session_usage: {
    columns: [
      'session_id TEXT NOT NULL PK1',
      'input_tokens INTEGER NOT NULL DEFAULT 0',
      'output_tokens INTEGER NOT NULL DEFAULT 0',
      'cache_read_tokens INTEGER NOT NULL DEFAULT 0',
      'cache_creation_tokens INTEGER NOT NULL DEFAULT 0',
      'total_tokens INTEGER NOT NULL DEFAULT 0',
      'events INTEGER NOT NULL DEFAULT 0',
      'updated_at TEXT NOT NULL',
    ],
    indexes: [],
    foreignKeys: ['session_id -> sessions.id ON DELETE CASCADE'],
  },
  sessions: {
    columns: [
      'id TEXT NOT NULL PK1',
      'assignment_id TEXT NOT NULL',
      'agent_id TEXT NOT NULL',
      'project_id TEXT NOT NULL',
      "status TEXT NOT NULL DEFAULT 'queued'",
      'sdk_session_id TEXT',
      'model TEXT',
      'permission_mode TEXT',
      "origin TEXT NOT NULL DEFAULT 'local'",
      'transcript_path TEXT',
      'transcript_bytes INTEGER NOT NULL DEFAULT 0',
      'summary TEXT',
      'pinned INTEGER NOT NULL DEFAULT 0',
      'started_at TEXT',
      'ended_at TEXT',
      'exit_reason TEXT',
    ],
    indexes: [
      'sessions_agent_idx (agent_id)',
      'sessions_assignment_idx (assignment_id)',
      'sessions_project_idx (project_id, transcript_bytes)',
      'sessions_status_idx (status)',
    ],
    // `agent_id` is absent from this list on purpose (§1.4).
    foreignKeys: [
      'assignment_id -> assignments.id ON DELETE RESTRICT',
      'project_id -> projects.id ON DELETE RESTRICT',
    ],
  },
  settings: {
    columns: ['key TEXT NOT NULL PK1', 'value_json TEXT NOT NULL', 'updated_at TEXT NOT NULL'],
    indexes: [],
    foreignKeys: [],
  },
  usage_events: {
    columns: [
      'id TEXT NOT NULL PK1',
      'session_id TEXT NOT NULL',
      'ts TEXT NOT NULL',
      'input_tokens INTEGER NOT NULL DEFAULT 0',
      'output_tokens INTEGER NOT NULL DEFAULT 0',
      'cache_read_tokens INTEGER NOT NULL DEFAULT 0',
      'cache_creation_tokens INTEGER NOT NULL DEFAULT 0',
      'model TEXT',
    ],
    indexes: ['usage_events_session_idx (session_id, ts)'],
    foreignKeys: ['session_id -> sessions.id ON DELETE CASCADE'],
  },
};

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}
interface IndexInfo {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}
interface IndexColumn {
  name: string | null;
}
interface ForeignKeyInfo {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

let root: TempRoot;
let storage: Storage;

beforeEach(() => {
  root = makeTempRoot();
  storage = openStorage({ dataRoot: root.path, tightenAcl: false });
});

afterEach(() => {
  storage.close();
  root.cleanup();
});

function describeTable(table: string): TableShape {
  const db = storage.db;

  const columns = (db.pragma(`table_info(${table})`) as ColumnInfo[]).map((column) => {
    const bits = [column.name, column.type];
    if (column.notnull !== 0) bits.push('NOT NULL');
    if (column.dflt_value !== null) bits.push(`DEFAULT ${column.dflt_value}`);
    if (column.pk !== 0) bits.push(`PK${column.pk}`);
    return bits.join(' ');
  });

  const indexes = (db.pragma(`index_list(${table})`) as IndexInfo[])
    // `origin: 'pk'` is the implicit primary-key index, already described by
    // the `PKn` markers on the columns.
    .filter((index) => index.origin !== 'pk')
    .map((index) => {
      const cols = (db.pragma(`index_info(${index.name})`) as IndexColumn[]).map((c) => c.name);
      const flags = `${index.unique !== 0 ? ' UNIQUE' : ''}${index.partial !== 0 ? ' PARTIAL' : ''}`;
      return `${index.name}${flags} (${cols.join(', ')})`;
    })
    .sort();

  const foreignKeys = (db.pragma(`foreign_key_list(${table})`) as ForeignKeyInfo[])
    .map((fk) => `${fk.from} -> ${fk.table}.${fk.to} ON DELETE ${fk.on_delete}`)
    .sort();

  return { columns, indexes, foreignKeys };
}

describe('core schema (§1.4)', () => {
  it('contains exactly the foundation-owned tables, and no more', () => {
    const tables = storage.db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' " +
          "AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    expect(tables).toEqual([...FOUNDATION_TABLES]);
  });

  for (const table of FOUNDATION_TABLES) {
    it(`${table} matches its declared columns, indexes and foreign keys`, () => {
      expect(describeTable(table)).toEqual(EXPECTED[table]);
    });
  }

  it('is still at foundation schema version 1 — the core set is one migration', () => {
    expect(storage.schemaVersion).toBe(1);
    expect(storage.db.pragma('user_version', { simple: true })).toBe(1);
  });

  it('every table is STRICT, so a wrongly typed write fails at the write', () => {
    const definitions = storage.db
      .prepare<[], { name: string; sql: string }>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();

    for (const { name, sql } of definitions) {
      expect(sql.trimEnd().endsWith('STRICT'), `${name} should be STRICT`).toBe(true);
    }
  });

  it('enforces the enumerated vocabularies §1.4 fixes', () => {
    const project = storage.store.projects.create({ slug: 'p', name: 'P' });

    expect(() =>
      storage.store.assignments.create({
        projectId: project.id,
        pattern: 'mob' as never,
      }),
    ).toThrow(/CHECK constraint/);

    const assignment = storage.store.assignments.create({
      projectId: project.id,
      pattern: 'solo',
    });

    expect(() =>
      storage.store.assignments.addMember(assignment.id, {
        agentId: 'a',
        role: 'navigator' as never,
      }),
    ).toThrow(/CHECK constraint/);

    expect(() =>
      storage.store.sessions.create({
        assignmentId: assignment.id,
        agentId: 'a',
        projectId: project.id,
        status: 'zombie' as never,
      }),
    ).toThrow(/CHECK constraint/);
  });
});
