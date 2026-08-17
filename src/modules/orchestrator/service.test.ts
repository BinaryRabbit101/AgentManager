/**
 * The assignment engine: §2.3's creation paths, §2.7's runner contract, §2.2's
 * close, and IMPLEMENTATION M1-6's boot reconciliation.
 *
 * Where a criterion of IMPLEMENTATION M1 is proven here, the test name says so.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { AssignmentRefusedError, RunnerUnavailableError } from './errors.js';
import { fakeRunner, makeHarness, PROJECT_ID, type Harness } from './__tests__/helpers.js';

let harness: Harness | undefined;

function open(options: Parameters<typeof makeHarness>[0] = {}): Harness {
  harness?.cleanup();
  harness = makeHarness(options);
  return harness;
}

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const ADA = { id: 'ada', roles: ['implementer', 'architect'] as const };
const SAM = { id: 'sam', roles: ['skeptic'] as const };

// ---------------------------------------------------------------------------
// §2.3 path 1 — the drag-and-drop launch
// ---------------------------------------------------------------------------

describe('createSolo — the drag-and-drop-equivalent launch (M1 acceptance 1)', () => {
  it('creates the assignment and starts a session in one call, returning both ids', async () => {
    const h = open({ agents: [ADA] });
    const result = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'Summarise the design docs.',
    });

    expect(result.assignmentId).toEqual(expect.any(String));
    expect(result.sessionId).toBe('session-1');

    const view = h.service.get(result.assignmentId);
    expect(view).toMatchObject({
      pattern: 'solo',
      status: 'open',
      phase: 'running',
      write: true,
      // §2.3 path 1's defaults: whole-project scope, uncapped, no round cap.
      scope: null,
      tokenBudget: null,
      roundCap: null,
      createdBy: 'user',
    });
    expect(view.members).toEqual([
      { agentId: 'ada', role: 'implementer', seatOrder: 0, joinedAt: expect.any(String) as string },
    ]);
  });

  it('passes the assignment id, the project, the prompt and the role to runner', async () => {
    const h = open({ agents: [ADA] });
    const result = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'Do the thing.',
    });

    expect(h.runner.started).toEqual([
      {
        assignmentId: result.assignmentId,
        agentId: 'ada',
        projectId: PROJECT_ID,
        prompt: 'Do the thing.',
        role: 'implementer',
        priority: 'normal',
      },
    ]);
  });

  it('resolves sessions.assignment_id back to the created row (M1 acceptance 1)', async () => {
    const h = open({ agents: [ADA] });
    const result = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    // Runner owns the `sessions` row; this test stands in for it writing one,
    // and asserts the join every element makes actually resolves.
    h.storage.store.sessions.create({
      id: result.sessionId,
      assignmentId: result.assignmentId,
      agentId: 'ada',
      projectId: PROJECT_ID,
      status: 'done',
    });
    const session = h.storage.store.sessions.get(result.sessionId);
    expect(session?.assignmentId).toBe(result.assignmentId);
    expect(h.service.get(session?.assignmentId ?? '').id).toBe(result.assignmentId);
  });

  it('emits assignment.created then assignment.started, both persisted', async () => {
    const h = open({ agents: [ADA] });
    await h.service.createSolo({ projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' });
    const types = h.events.map((event) => event.type);
    expect(types).toEqual(['assignment.created', 'assignment.started']);
    expect(h.events.every((event) => event.persist)).toBe(true);
    expect(h.events[0]?.payload).toMatchObject({
      pattern: 'solo',
      members: [{ agentId: 'ada', role: 'implementer' }],
      write: true,
      createdBy: 'user',
    });
  });

  describe('role defaulting (§2.3)', () => {
    it('defaults to implementer when the agent declares it', async () => {
      const h = open({ agents: [{ id: 'ada', roles: ['architect', 'implementer'] }] });
      await h.service.createSolo({ projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' });
      expect(h.runner.started[0]?.role).toBe('implementer');
    });

    it('falls back to capabilities.roles[0]', async () => {
      const h = open({ agents: [{ id: 'ada', roles: ['architect', 'reviewer'] }] });
      await h.service.createSolo({ projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' });
      expect(h.runner.started[0]?.role).toBe('architect');
    });

    it('falls back to implementer, which §9-5 then refuses for an agent declaring nothing', async () => {
      // §2.3's final fallback is `implementer`, and §9-5 refuses any role absent
      // from `capabilities.roles`. For an agent that declares **no** roles the
      // two meet: the fallback picks `implementer`, the rule refuses it by name,
      // and the launch is a named refusal rather than a session with a seat the
      // agent never claimed. Raised in the M1 report; §9-5 wins because it is a
      // rule and §2.3's fallback is a default.
      const h = open({ agents: [{ id: 'ada', roles: [] }] });
      await expect(
        h.service.createSolo({ projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' }),
      ).rejects.toBeInstanceOf(AssignmentRefusedError);
      await expect(
        h.service.createSolo({ projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' }),
      ).rejects.toMatchObject({ code: 'role_not_declared' });
    });

    it('honours an explicit role the agent declares', async () => {
      const h = open({ agents: [ADA] });
      await h.service.createSolo({
        projectId: PROJECT_ID,
        agentId: 'ada',
        prompt: 'go',
        role: 'architect',
      });
      expect(h.runner.started[0]?.role).toBe('architect');
    });
  });

  it('refuses an empty prompt before anything is written', async () => {
    const h = open({ agents: [ADA] });
    await expect(
      h.service.createSolo({ projectId: PROJECT_ID, agentId: 'ada', prompt: '   ' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(h.service.list()).toEqual([]);
  });

  it('refuses runner_unavailable, creating nothing, when runner cannot launch', async () => {
    // The shape of a build before runner M3: a `RunnerService` with no
    // `startSession`. An assignment created for a session that can never start
    // is a row the user has to clean up by hand.
    const h = open({ agents: [ADA], launchable: false });
    await expect(
      h.service.createSolo({ projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' }),
    ).rejects.toBeInstanceOf(RunnerUnavailableError);
    expect(h.service.list()).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('closes the assignment when startSession throws, leaving no orphan', async () => {
    const h = open({
      agents: [ADA],
      runner: fakeRunner({
        onStart: () => {
          throw new Error('queue_full');
        },
      }),
    });
    await expect(
      h.service.createSolo({ projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' }),
    ).rejects.toThrow('queue_full');

    const rows = h.service.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'closed', closeReason: 'failed', phase: 'closed' });
  });

  it('goes through the same §9 validator as every other path', async () => {
    const h = open({ agents: [{ id: 'ada', roles: ['skeptic'] }] });
    await expect(
      h.service.createSolo({
        projectId: PROJECT_ID,
        agentId: 'ada',
        prompt: 'go',
        role: 'implementer',
      }),
    ).rejects.toMatchObject({ code: 'role_not_declared' });
  });
});

// ---------------------------------------------------------------------------
// §2.3 path 2 — pattern
// ---------------------------------------------------------------------------

describe('createAssignment — the pattern path', () => {
  it('creates a pair at phase: running with §7.2’s defaults', async () => {
    const h = open({ agents: [ADA, SAM] });
    const result = await h.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'pair',
      goal: 'Draft the design',
      members: [
        { agentId: 'ada', role: 'architect' },
        { agentId: 'sam', role: 'skeptic' },
      ],
      scope: { paths: ['docs/'], artifactPath: 'docs/DESIGN.md' },
    });

    const view = h.service.get(result.assignmentId);
    expect(view).toMatchObject({
      pattern: 'pair',
      phase: 'running',
      tokenBudget: 400_000,
      roundCap: 3,
      artifactPath: 'docs/DESIGN.md',
      leadAgentId: 'ada',
    });
    expect(view.members.map((member) => member.seatOrder)).toEqual([0, 1]);
    expect(result.gate).toBeUndefined();
    // Since M5 the engine takes it from here: `assignment.created` on a pattern
    // with a driver plans the first turn, and the drafting seat leads (§3.3).
    expect(h.runner.started).toEqual([
      expect.objectContaining({ assignmentId: result.assignmentId, agentId: 'ada' }),
    ]);
  });

  it('parks a machine-created write-capable assignment at phase: planned behind a gate', async () => {
    const h = open({ agents: [ADA] });
    const result = await h.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      members: [{ agentId: 'ada', role: 'implementer' }],
      write: true,
      tokenBudget: 100_000,
      createdBy: 'overseer:ove',
    });
    expect(result.phase).toBe('planned');
    // M7-3: the gate is a real card now, not only a reason — so the result
    // carries the question the assignment is waiting on.
    expect(result.gate?.reason).toBe('write-capable assignment created by an overseer');
    expect(result.gate?.questionId).toEqual(expect.any(String));
  });

  it('sits at phase: planned when autoStart is false', async () => {
    const h = open({ agents: [ADA] });
    const result = await h.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      members: [{ agentId: 'ada', role: 'implementer' }],
      autoStart: false,
    });
    expect(result.phase).toBe('planned');
  });

  it('returns warnings without refusing (§2.6, §7.2)', async () => {
    const h = open({ agents: [ADA, SAM] });
    await h.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      members: [{ agentId: 'ada', role: 'implementer' }],
      scope: { paths: ['docs/'] },
      write: true,
    });
    const second = await h.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      members: [{ agentId: 'sam', role: 'skeptic' }],
      scope: { paths: ['docs/orchestrator/'] },
      write: true,
    });
    expect(second.warnings.map((warning) => warning.code)).toContain('scope_overlap');
    expect(second.warnings[0]?.message).toContain('both are write-capable');
    expect(h.service.get(second.assignmentId).status).toBe('open');
  });

  it('counts an agent’s open assignments toward §9-7 across creates', async () => {
    const h = open({ agents: [ADA] });
    const request = {
      projectId: PROJECT_ID,
      pattern: 'solo' as const,
      members: [{ agentId: 'ada', role: 'implementer' as const }],
    };
    await h.service.createAssignment(request);
    await h.service.createAssignment(request);
    await expect(h.service.createAssignment(request)).rejects.toMatchObject({
      code: 'member_at_capacity',
    });
  });
});

// ---------------------------------------------------------------------------
// §2.7 — the runner contract (M1 acceptance 2)
// ---------------------------------------------------------------------------

describe('getAssignmentContext — runner launch-chain step 3 (M1 acceptance 2)', () => {
  it('returns exactly runner §15.1-3’s shape', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });

    const context = await h.service.getAssignmentContext(assignmentId);
    expect(Object.keys(context).sort()).toEqual(
      [
        'id',
        'pattern',
        'role',
        'roundCap',
        'roundsUsed',
        'scopeRules',
        'status',
        'tokenBudget',
        'tokensUsed',
        'write',
      ].sort(),
    );
    expect(context).toEqual({
      id: assignmentId,
      pattern: 'solo',
      status: 'open',
      role: 'implementer',
      write: true,
      scopeRules: {},
      tokenBudget: null,
      tokensUsed: 0,
      roundCap: null,
      roundsUsed: 0,
    });
  });

  it('emits the scope rules of §2.5 for a scoped write assignment', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId } = await h.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      members: [{ agentId: 'ada', role: 'implementer' }],
      scope: { paths: ['docs/', 'src/x.ts'] },
      write: true,
    });
    const context = await h.service.getAssignmentContext(assignmentId);
    expect(context.scopeRules).toEqual({ allow: ['Edit(./docs/**)', 'Edit(./src/x.ts)'] });
    expect(context.write).toBe(true);
  });

  it('emits no scope rules for a read-only assignment — write is the flag', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId } = await h.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      members: [{ agentId: 'ada', role: 'implementer' }],
      scope: { paths: ['docs/'] },
      write: false,
    });
    const context = await h.service.getAssignmentContext(assignmentId);
    expect(context).toMatchObject({ write: false, scopeRules: {} });
  });

  it('names the seat by agent for a multi-seat assignment, and no seat without one', async () => {
    const h = open({ agents: [ADA, SAM] });
    const { assignmentId } = await h.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'pair',
      members: [
        { agentId: 'ada', role: 'architect' },
        { agentId: 'sam', role: 'skeptic' },
      ],
      scope: { paths: ['docs/'], artifactPath: 'docs/D.md' },
    });
    expect((await h.service.getAssignmentContext(assignmentId, { agentId: 'sam' })).role).toBe(
      'skeptic',
    );
    // A guessed seat compiles the wrong role addendum into a prompt, so a
    // multi-seat assignment asked without an agent gets no role at all.
    expect((await h.service.getAssignmentContext(assignmentId)).role).toBeUndefined();
  });

  it('reports status: closed so runner refuses admission (M1 acceptance 2)', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    await h.service.closeAssignment(assignmentId, 'user_closed');

    const context = await h.service.getAssignmentContext(assignmentId);
    expect(context.status).toBe('closed');
    // And a *new* solo launch onto a closed assignment is impossible by
    // construction: `createSolo` always mints a fresh one, so the only way to
    // start on a closed assignment is runner's own admission check, which reads
    // this field.
  });

  it('throws assignment_not_found for an unknown id rather than answering', async () => {
    const h = open({ agents: [ADA] });
    await expect(h.service.getAssignmentContext('nope')).rejects.toMatchObject({
      code: 'assignment_not_found',
      status: 404,
    });
  });

  it('reports the tokens runner metered, never a re-derived total', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    // Runner's arithmetic, through foundation's repository, in its own
    // transaction (§7.1). Orchestrator reads the column and adds nothing.
    h.storage.store.assignments.addTokensUsed(assignmentId, 1234);
    expect((await h.service.getAssignmentContext(assignmentId)).tokensUsed).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// §2.2 — closing (M1 acceptance 3)
// ---------------------------------------------------------------------------

describe('closeAssignment (M1 acceptance 3)', () => {
  it('emits assignment.closed — the event runner releases the lease on', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    h.events.length = 0;

    await h.service.closeAssignment(assignmentId, 'user_closed');

    const closed = h.events.find((event) => event.type === 'assignment.closed');
    expect(closed).toBeDefined();
    expect(closed?.persist).toBe(true);
    expect(closed?.ids).toMatchObject({ assignmentId, projectId: PROJECT_ID });
    expect(closed?.payload).toMatchObject({ closeReason: 'user_closed', rounds: 0, tokens: 0 });
  });

  it('cancels the assignment’s open questions', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    const question = h.storage.store.questions.open({
      assignmentId,
      prompt: 'Postgres or SQLite?',
    });

    await h.service.closeAssignment(assignmentId, 'user_closed');
    expect(h.storage.store.questions.get(question.id)?.status).toBe('cancelled');
  });

  it('stops every live session and leaves terminal ones alone (R6)', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    for (const status of ['running', 'paused', 'queued', 'done'] as const) {
      h.storage.store.sessions.create({
        id: `s-${status}`,
        assignmentId,
        agentId: 'ada',
        projectId: PROJECT_ID,
        status,
      });
    }

    await h.service.closeAssignment(assignmentId, 'user_closed');
    expect(h.runner.stopped.map((entry) => entry.sessionId).sort()).toEqual([
      's-paused',
      's-queued',
      's-running',
    ]);
    expect(h.runner.stopped[0]?.reason).toContain('user_closed');
  });

  it('is idempotent — a second close changes nothing and emits nothing', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    await h.service.closeAssignment(assignmentId, 'user_closed');
    h.events.length = 0;
    await h.service.closeAssignment(assignmentId, 'breaker');

    expect(h.events).toEqual([]);
    expect(h.service.get(assignmentId).closeReason).toBe('user_closed');
  });

  it('refuses to close an assignment that does not exist', async () => {
    const h = open({ agents: [ADA] });
    await expect(h.service.closeAssignment('nope', 'user_closed')).rejects.toMatchObject({
      code: 'assignment_not_found',
    });
  });
});

// ---------------------------------------------------------------------------
// §2.3 work-item linking (M1 acceptance 4)
// ---------------------------------------------------------------------------

describe('work-item linking (M1 acceptance 4, R4)', () => {
  const workItems = new Map([
    ['wi-1', { id: 'wi-1', projectId: PROJECT_ID }],
    ['wi-other', { id: 'wi-other', projectId: 'proj-2' }],
  ]);

  it('links on create and unlinks on close', async () => {
    const h = open({ agents: [ADA], workItems });
    const { assignmentId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
      workItemIds: ['wi-1'],
    });
    expect(h.projects.linked.get(assignmentId)).toEqual(['wi-1']);

    await h.service.closeAssignment(assignmentId, 'user_closed');
    expect(h.projects.unlinked).toContain(assignmentId);
  });

  it('refuses an id from another project by name, and creates nothing', async () => {
    const h = open({ agents: [ADA], workItems });
    await expect(
      h.service.createSolo({
        projectId: PROJECT_ID,
        agentId: 'ada',
        prompt: 'go',
        workItemIds: ['wi-other'],
      }),
    ).rejects.toMatchObject({ code: 'work_item_cross_project' });
    expect(h.service.list()).toEqual([]);
    expect(h.projects.linked.size).toBe(0);
  });

  it('refuses an unknown id rather than dropping it silently', async () => {
    const h = open({ agents: [ADA], workItems });
    await expect(
      h.service.createSolo({
        projectId: PROJECT_ID,
        agentId: 'ada',
        prompt: 'go',
        workItemIds: ['ghost'],
      }),
    ).rejects.toMatchObject({ code: 'work_item_not_found' });
  });

  it('writes no rows when no ids are passed', async () => {
    const h = open({ agents: [ADA], workItems });
    await h.service.createSolo({ projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' });
    expect(h.projects.linked.size).toBe(0);
  });

  it('refuses rather than dropping the link when projects cannot link yet', async () => {
    // A build before projects M8. R4 exists precisely because a dropped link
    // means a work item that never leaves `open`.
    const h = open({ agents: [ADA] });
    await expect(
      h.service.createSolo({
        projectId: PROJECT_ID,
        agentId: 'ada',
        prompt: 'go',
        workItemIds: ['wi-1'],
      }),
    ).rejects.toMatchObject({ code: 'work_item_not_found' });
  });
});

// ---------------------------------------------------------------------------
// IMPLEMENTATION M1-6 — the boot task (M1 acceptance 6)
// ---------------------------------------------------------------------------

describe('reconcileOnBoot (M1 acceptance 6)', () => {
  it('leaves phase: running alone while a session is still live', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId, sessionId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    h.storage.store.sessions.create({
      id: sessionId,
      assignmentId,
      agentId: 'ada',
      projectId: PROJECT_ID,
      status: 'running',
    });

    const result = await h.service.reconcileOnBoot();
    expect(result.phaseReconciled).toEqual([]);
    expect(h.service.get(assignmentId).phase).toBe('running');
  });

  it('leaves no orphan phase: running with no live session', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId, sessionId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    // The core died mid-session and the session was reconciled to `orphaned` by
    // runner's own boot task, which runs in the same phase.
    h.storage.store.sessions.create({
      id: sessionId,
      assignmentId,
      agentId: 'ada',
      projectId: PROJECT_ID,
      status: 'orphaned',
    });

    const result = await h.service.reconcileOnBoot();
    expect(result.phaseReconciled).toEqual([assignmentId]);
    // Open, awaiting a turn nothing is taking — not a spinner that never stops.
    expect(h.service.get(assignmentId)).toMatchObject({ status: 'open', phase: 'planned' });
  });

  it('closes assignments whose project is archived', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    // Projects archived it while the core was down.
    h.projects.setStatus(PROJECT_ID, 'archived');

    const result = await h.service.reconcileOnBoot();
    expect(result.closedForArchivedProject).toEqual([assignmentId]);
    expect(h.service.get(assignmentId)).toMatchObject({
      status: 'closed',
      closeReason: 'project_archived',
    });
  });

  it('says nothing when it cannot judge — an unanswerable project is not a reason to close work', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    h.projects.forget(PROJECT_ID);

    const result = await h.service.reconcileOnBoot();
    expect(result.closedForArchivedProject).toEqual([]);
    expect(h.service.get(assignmentId).status).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('reads and patches', () => {
  it('refuses a patch on a closed assignment', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    await h.service.closeAssignment(assignmentId, 'user_closed');
    expect(() => h.service.update(assignmentId, { tokenBudget: 10 })).toThrow(/closed/i);
  });

  it('patches budget, cap and goal on an open one', async () => {
    const h = open({ agents: [ADA] });
    const { assignmentId } = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    expect(h.service.update(assignmentId, { tokenBudget: 50_000, goal: 'new' })).toMatchObject({
      tokenBudget: 50_000,
      goal: 'new',
    });
  });
});
