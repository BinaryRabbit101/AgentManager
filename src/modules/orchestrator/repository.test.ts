/**
 * `AssignmentRepository` against a real database with the real migration set
 * (IMPLEMENTATION M1-1, and M0-3's "migrations apply and re-apply cleanly").
 *
 * The point of these tests is the *seam*: foundation owns `status`,
 * `tokens_used` and `rounds_used`, this element owns `phase`, `write` and the
 * rest, and the two must stay one row that nobody half-writes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Storage } from '../../storage/index.js';

import { createAssignmentRepository, type AssignmentRepository } from './repository.js';
import { makeTempDir, openTestStorage, type TempDir } from './__tests__/helpers.js';

let dir: TempDir;
let storage: Storage;
let repository: AssignmentRepository;

beforeEach(() => {
  dir = makeTempDir('agentmanager-orchestrator-repo-');
  storage = openTestStorage(dir.path);
  storage.store.projects.create({ id: 'proj-1', slug: 'proj', name: 'Proj', status: 'active' });
  repository = createAssignmentRepository({
    db: storage.db,
    assignments: storage.store.assignments,
    clock: () => new Date(),
  });
});

afterEach(() => {
  storage.close();
  dir.cleanup();
});

function create(overrides: Partial<Parameters<AssignmentRepository['create']>[0]> = {}) {
  return repository.create({
    projectId: 'proj-1',
    pattern: 'solo',
    write: true,
    phase: 'running',
    createdBy: 'user',
    tokenBudget: null,
    roundCap: null,
    members: [{ agentId: 'ada', role: 'implementer', seatOrder: 0 }],
    ...overrides,
  });
}

describe('migrations/orchestrator/0001_orchestrator.sql', () => {
  it('adds every §2.1 column to assignments', () => {
    const columns = (
      storage.db.prepare('PRAGMA table_info(assignments)').all() as { name: string }[]
    ).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'created_by',
        'parent_assignment_id',
        'lead_agent_id',
        'write',
        'artifact_path',
        'pattern_config_json',
        'phase',
        'halt_reason',
        'updated_at',
      ]),
    );
  });

  it('adds seat_order and joined_at to assignment_members', () => {
    const columns = (
      storage.db.prepare('PRAGMA table_info(assignment_members)').all() as { name: string }[]
    ).map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining(['seat_order', 'joined_at']));
  });

  it('creates assignment_turns and message_reads as STRICT tables', () => {
    const rows = storage.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
      .all('assignment_turns', 'message_reads') as { name: string; sql: string }[];
    expect(rows.map((row) => row.name).sort()).toEqual(['assignment_turns', 'message_reads']);
    for (const row of rows) expect(row.sql).toContain('STRICT');
  });

  it('creates the three indexes §2.1 names', () => {
    const names = (
      storage.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'assignments_open',
        'assignment_turns_read',
        'assignment_turns_active',
      ]),
    );
  });

  it('records the set under "orchestrator" in schema_migrations', () => {
    expect(Object.keys(storage.setVersions)).toContain('orchestrator');
  });

  it('re-applies cleanly on an existing database (M0 acceptance)', () => {
    storage.close();
    // The second open re-runs the migration *runner*, which must find the set
    // already at its latest version and change nothing. Three files now: 0001's
    // columns, 0002's `permission_denials` (§8.1's `tool_denials` input) and
    // 0003's `exit_reason` (§11.2's "why did this turn fail").
    const reopened = openTestStorage(dir.path);
    expect(reopened.setVersions['orchestrator']).toBe(3);
    const columns = (
      reopened.db.prepare('PRAGMA table_info(assignments)').all() as { name: string }[]
    ).filter((row) => row.name === 'phase');
    expect(columns).toHaveLength(1);
    reopened.close();
    storage = openTestStorage(dir.path);
  });

  it('refuses a second planned-or-running turn for one assignment', () => {
    const row = create();
    const insert = storage.db.prepare(
      'INSERT INTO assignment_turns (id, assignment_id, round, seat, agent_id, status) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('turn-1', row.id, 1, 'solo', 'ada', 'planned');
    // The crash-safe guard of §2.1: the database says at most one, not an
    // in-process flag a restart forgets.
    expect(() => insert.run('turn-2', row.id, 1, 'solo', 'ada', 'running')).toThrow(/UNIQUE/i);
    // …and a finished turn frees the slot.
    storage.db
      .prepare("UPDATE assignment_turns SET status = 'reported' WHERE id = ?")
      .run('turn-1');
    expect(() => insert.run('turn-2', row.id, 2, 'solo', 'ada', 'planned')).not.toThrow();
  });
});

describe('create', () => {
  it('writes the base columns and this element’s in one transaction', () => {
    const row = create({
      goal: 'draft the plan',
      scope: { paths: ['docs/'], artifactPath: 'docs/PLAN.md' },
      write: false,
      phase: 'planned',
      createdBy: 'overseer:ove',
      leadAgentId: 'ada',
      artifactPath: 'docs/PLAN.md',
      patternConfig: { roundCap: 3 },
      tokenBudget: 400_000,
      roundCap: 3,
    });

    expect(row).toMatchObject({
      projectId: 'proj-1',
      pattern: 'solo',
      status: 'open',
      phase: 'planned',
      goal: 'draft the plan',
      write: false,
      createdBy: 'overseer:ove',
      leadAgentId: 'ada',
      artifactPath: 'docs/PLAN.md',
      tokenBudget: 400_000,
      roundCap: 3,
      tokensUsed: 0,
      roundsUsed: 0,
    });
    expect(JSON.parse(row.scopeJson ?? '{}')).toEqual({
      paths: ['docs/'],
      artifactPath: 'docs/PLAN.md',
    });
    expect(JSON.parse(row.patternConfigJson)).toEqual({ roundCap: 3 });
    expect(row.updatedAt).not.toBeNull();
  });

  it('stores seat order from the pattern, not from insertion order', () => {
    const row = create({
      pattern: 'pair',
      members: [
        { agentId: 'sam', role: 'skeptic', seatOrder: 1 },
        { agentId: 'ada', role: 'architect', seatOrder: 0 },
      ],
    });
    expect(repository.listMembers(row.id).map((member) => member.agentId)).toEqual(['ada', 'sam']);
    expect(repository.listMembers(row.id)[0]?.joinedAt).not.toBeNull();
  });

  it('defaults phase to planned for a row written without one', () => {
    // The column default, exercised through foundation's own repository — the
    // path anything that does not know about phases would take.
    const base = storage.store.assignments.create({ projectId: 'proj-1', pattern: 'solo' });
    expect(repository.get(base.id)?.phase).toBe('planned');
    expect(repository.get(base.id)?.write).toBe(true);
  });
});

describe('reads', () => {
  it('counts only open assignments toward an agent’s concurrency', () => {
    const one = create();
    create();
    expect(repository.countOpenForAgent('ada')).toBe(2);
    repository.close(one.id, 'user_closed');
    expect(repository.countOpenForAgent('ada')).toBe(1);
    expect(repository.countOpenForAgent('nobody')).toBe(0);
  });

  it('totals only the open children’s budgets (§9-8)', () => {
    const parent = create({ tokenBudget: 100_000 });
    create({ parentAssignmentId: parent.id, tokenBudget: 30_000 });
    const closedChild = create({ parentAssignmentId: parent.id, tokenBudget: 20_000 });
    expect(repository.openChildBudgetTotal(parent.id)).toBe(50_000);
    repository.close(closedChild.id, 'user_closed');
    expect(repository.openChildBudgetTotal(parent.id)).toBe(30_000);
  });

  it('filters by project, status, phase and agent', () => {
    const running = create();
    const closed = create();
    repository.close(closed.id, 'user_closed');

    expect(repository.list({ projectId: 'proj-1' })).toHaveLength(2);
    expect(repository.list({ status: 'open' }).map((row) => row.id)).toEqual([running.id]);
    expect(repository.list({ phase: 'running' }).map((row) => row.id)).toEqual([running.id]);
    expect(repository.list({ agentId: 'ada' })).toHaveLength(2);
    expect(repository.list({ limit: 1 })).toHaveLength(1);
  });
});

describe('mutations', () => {
  it('setPhase records a halt reason and touches updated_at', () => {
    const row = create();
    const before = repository.get(row.id)?.updatedAt;
    const halted = repository.setPhase(row.id, 'halted', 'no_progress');
    expect(halted.phase).toBe('halted');
    expect(halted.haltReason).toBe('no_progress');
    expect(halted.updatedAt).not.toBe(undefined);
    expect(before).not.toBeNull();
  });

  it('update changes only budget, cap and goal', () => {
    const row = create();
    const updated = repository.update(row.id, { tokenBudget: 50_000, roundCap: 2, goal: 'new' });
    expect(updated).toMatchObject({ tokenBudget: 50_000, roundCap: 2, goal: 'new' });
    expect(updated.pattern).toBe('solo');
  });

  it('close sets status, closed_at, close_reason and phase: closed', () => {
    const row = create();
    const closed = repository.close(row.id, 'user_closed');
    expect(closed).toMatchObject({
      status: 'closed',
      closeReason: 'user_closed',
      phase: 'closed',
    });
    expect(closed.closedAt).not.toBeNull();
  });

  it('§2.2’s one exception: a converged close sets phase: converged', () => {
    const row = create();
    const closed = repository.close(row.id, 'converged');
    // `status` is `closed` either way — which is all runner reads.
    expect(closed.status).toBe('closed');
    expect(closed.phase).toBe('converged');
  });
});
