/**
 * IMPLEMENTATION M4 — the two overseer tools, and the scoping that makes them
 * safe.
 *
 * The four worker tools and their refusals are covered in `toolset.test.ts`,
 * which landed with M5/M6. What is asserted here is the half §4.1's table
 * reserves for a coordinator: who can call it, what it may see, what it may
 * create, and the caps that stop a tool loop.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { OVERSEER_TOOL_NAMES, WORKER_TOOL_NAMES, type ToolResult } from './toolset.js';
import { flush, makeHarness, PROJECT_ID, type Harness } from './__tests__/helpers.js';

let harness: Harness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const IRIS = { id: 'iris', name: 'Iris', roles: ['overseer' as const], overseer: true };
const ADA = {
  id: 'ada',
  name: 'Ada',
  roles: ['architect' as const, 'implementer' as const],
  specialty: 'documentation',
  tags: ['backend'],
};
const SAM = { id: 'sam', name: 'Sam', roles: ['skeptic' as const], specialty: 'code-review' };

function open(options: Parameters<typeof makeHarness>[0] = {}): Harness {
  harness = makeHarness({ agents: [IRIS, ADA, SAM], ...options });
  return harness;
}

function payloadOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

/** An overseer's own assignment — the parent every `create_assignment` needs. */
async function overseerAssignment(h: Harness, write = false): Promise<string> {
  const created = await h.service.createAssignment({
    projectId: PROJECT_ID,
    pattern: 'solo',
    goal: 'coordinate the billing work',
    members: [{ agentId: 'iris', role: 'overseer' }],
    write,
    tokenBudget: 500_000,
  });
  return created.assignmentId;
}

describe('the tool split is enforced by construction (§4.1)', () => {
  it('gives an overseer launch all six and a worker launch exactly four', async () => {
    const h = open();
    const assignmentId = await overseerAssignment(h);

    const overseer = h.toolset({ assignmentId, agentId: 'iris', isOverseer: true });
    const worker = h.toolset({ assignmentId, agentId: 'iris' });

    expect(overseer.toolNames).toEqual([...OVERSEER_TOOL_NAMES]);
    expect(worker.toolNames).toEqual([...WORKER_TOOL_NAMES]);
    expect(overseer.toolNames).toHaveLength(6);
  });

  it('refuses a worker naming an overseer tool, and says which rule refused', async () => {
    const h = open();
    const assignmentId = await overseerAssignment(h);
    const worker = h.toolset({ assignmentId, agentId: 'iris' });

    for (const tool of ['list_roster', 'create_assignment']) {
      const result = await worker.call(tool, {});
      expect(result.isError).toBe(true);
      expect(payloadOf(result)['code']).toBe('not_an_overseer');
    }
  });
});

describe('list_roster (§4.3)', () => {
  it('lists who could be delegated to, with load and availability', async () => {
    const h = open();
    const assignmentId = await overseerAssignment(h);
    const result = await h
      .toolset({ assignmentId, agentId: 'iris', isOverseer: true })
      .call('list_roster', { availableOnly: false });

    const agents = payloadOf(result)['agents'] as Record<string, unknown>[];
    expect(agents.map((agent) => agent['id']).sort()).toEqual(['ada', 'iris', 'sam']);
    const iris = agents.find((agent) => agent['id'] === 'iris');
    // Iris holds the seat in the assignment this launch is for.
    expect(iris?.['openAssignments']).toBe(1);
    expect(iris?.['overseer']).toBe(true);
  });

  it('never returns permissions, integrations or secret refs (roster §11)', async () => {
    const h = open();
    const assignmentId = await overseerAssignment(h);
    const result = await h
      .toolset({ assignmentId, agentId: 'iris', isOverseer: true })
      .call('list_roster', {});

    const text = result.content[0]?.text ?? '';
    for (const forbidden of ['permissions', 'integrations', 'secretRef', 'env', 'settingSources']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('filters by role, specialty and tag, and hides the loaded by default', async () => {
    const h = open({
      config: { assignment: { maxAgeHours: 24, maxConcurrentPerAgent: 1, maxNestingDepth: 1 } },
    });
    const assignmentId = await overseerAssignment(h);
    const overseer = h.toolset({ assignmentId, agentId: 'iris', isOverseer: true });

    const byRole = payloadOf(await overseer.call('list_roster', { role: 'skeptic' }))['agents'];
    expect((byRole as Record<string, unknown>[]).map((one) => one['id'])).toEqual(['sam']);

    const bySpecialty = payloadOf(
      await overseer.call('list_roster', { specialty: 'documentation' }),
    )['agents'];
    expect((bySpecialty as Record<string, unknown>[]).map((one) => one['id'])).toEqual(['ada']);

    const byTag = payloadOf(await overseer.call('list_roster', { tag: 'backend' }))['agents'];
    expect((byTag as Record<string, unknown>[]).map((one) => one['id'])).toEqual(['ada']);

    // `availableOnly` defaults true, and iris is at the cap of 1.
    const available = payloadOf(await overseer.call('list_roster', {}))['agents'];
    expect((available as Record<string, unknown>[]).map((one) => one['id'])).not.toContain('iris');
  });
});

describe('create_assignment (§4.3, §9)', () => {
  it('creates a child whose ids resolve, on the caller’s own project (M4 acceptance)', async () => {
    const h = open();
    const parentId = await overseerAssignment(h);

    const result = await h
      .toolset({ assignmentId: parentId, agentId: 'iris', isOverseer: true })
      .call('create_assignment', {
        pattern: 'pair',
        goal: 'Draft the migration plan',
        members: [
          { agentId: 'ada', role: 'architect' },
          { agentId: 'sam', role: 'skeptic' },
        ],
        scope: { paths: ['docs/billing/'], artifactPath: 'docs/billing/plan.md' },
        tokenBudget: 150_000,
        roundCap: 2,
      });

    const childId = payloadOf(result)['assignmentId'] as string;
    const child = h.service.get(childId);
    expect(child.parentAssignmentId).toBe(parentId);
    expect(child.projectId).toBe(PROJECT_ID);
    expect(child.createdBy).toBe('overseer:iris');
    expect(child.members.map((member) => member.agentId).sort()).toEqual(['ada', 'sam']);
    expect(child.tokenBudget).toBe(150_000);
  });

  it('teaches the agent every §9 rule that refused it, in one refusal ([A4])', async () => {
    const h = open();
    const parentId = await overseerAssignment(h);
    const result = await h
      .toolset({ assignmentId: parentId, agentId: 'iris', isOverseer: true })
      .call('create_assignment', {
        pattern: 'pair',
        goal: 'do something impossible',
        // Sam does not declare `architect`, and nobody named `ghost` exists.
        members: [
          { agentId: 'sam', role: 'architect' },
          { agentId: 'ghost', role: 'skeptic' },
        ],
        tokenBudget: 150_000,
      });

    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload['code']).toBe('refused');
    const codes = (payload['detail'] as { refusals: { code: string }[] }).refusals.map(
      (one) => one.code,
    );
    // Sam being seated as an architect is only a *warning* since the owner
    // decision of 2026-08-18 (§9-5); `ghost` not existing is still a rule.
    expect(codes).toContain('agent_not_found');
    expect(codes).not.toContain('role_not_declared');
  });

  it('refuses a budget bigger than the parent’s remainder (§9-8)', async () => {
    const h = open();
    const parentId = await overseerAssignment(h);
    const result = await h
      .toolset({ assignmentId: parentId, agentId: 'iris', isOverseer: true })
      .call('create_assignment', {
        pattern: 'solo',
        goal: 'spend more than exists',
        members: [{ agentId: 'ada', role: 'implementer' }],
        tokenBudget: 900_000,
      });

    const codes = (payloadOf(result)['detail'] as { refusals: { code: string }[] }).refusals.map(
      (one) => one.code,
    );
    expect(codes).toContain('budget_exceeds_parent');
  });

  it('starts nothing when write: true — the gate holds it at phase planned (§9-10)', async () => {
    const h = open();
    const parentId = await overseerAssignment(h, true);
    const before = h.runner.started.length;

    const result = await h
      .toolset({ assignmentId: parentId, agentId: 'iris', isOverseer: true })
      .call('create_assignment', {
        pattern: 'solo',
        goal: 'edit the docs',
        members: [{ agentId: 'ada', role: 'implementer' }],
        scope: { paths: ['docs/billing/'] },
        write: true,
        tokenBudget: 150_000,
        autoStart: true,
      });
    await flush();

    const payload = payloadOf(result);
    expect(payload['phase']).toBe('planned');
    expect(payload['gate']).toBeDefined();
    expect(h.runner.started.length).toBe(before);
  });

  it('caps creations per session and trips the flood breaker (§4.2, §8.1)', async () => {
    const h = open({
      config: {
        breakers: {
          denialsPerSession: 5,
          consecutiveFailures: 2,
          identicalTurns: 2,
          messagesPerTurn: 20,
          maxAssignmentsPerSession: 1,
          maxDecisionsPerSession: 3,
        },
      },
    });
    const parentId = await overseerAssignment(h);
    const overseer = h.toolset({ assignmentId: parentId, agentId: 'iris', isOverseer: true });

    const first = await overseer.call('create_assignment', {
      pattern: 'solo',
      goal: 'one',
      members: [{ agentId: 'ada', role: 'implementer' }],
      tokenBudget: 10_000,
    });
    expect(first.isError).toBeUndefined();

    const second = await overseer.call('create_assignment', {
      pattern: 'solo',
      goal: 'two',
      members: [{ agentId: 'sam', role: 'skeptic' }],
      tokenBudget: 10_000,
    });
    expect(second.isError).toBe(true);
    expect(payloadOf(second)['code']).toBe('rate_limited');

    // §8.1: the refusal is local and immediate; the halt is the engine's.
    await flush();
    expect(h.repository.get(parentId)?.phase).toBe('halted');
    expect(h.repository.get(parentId)?.haltReason).toBe('tool_flood');
  });
});

describe('scopeOf for an overseer (§4.2)', () => {
  it('reads its children’s mail and never a sibling assignment’s', async () => {
    const h = open();
    const parentId = await overseerAssignment(h);
    const child = payloadOf(
      await h
        .toolset({ assignmentId: parentId, agentId: 'iris', isOverseer: true })
        .call('create_assignment', {
          pattern: 'solo',
          goal: 'the child',
          members: [{ agentId: 'ada', role: 'implementer' }],
          tokenBudget: 50_000,
        }),
    )['assignmentId'] as string;

    // An unrelated assignment the overseer has nothing to do with.
    const stranger = await h.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      members: [{ agentId: 'sam', role: 'skeptic' }],
    });

    h.mailbox.send({
      assignmentId: child,
      fromAgentId: 'ada',
      broadcast: true,
      kind: 'status',
      body: 'child says hello',
    });
    h.mailbox.send({
      assignmentId: stranger.assignmentId,
      fromAgentId: 'sam',
      broadcast: true,
      kind: 'status',
      body: 'stranger says hello',
    });

    const result = await h
      .toolset({ assignmentId: parentId, agentId: 'iris', isOverseer: true })
      .call('read_mailbox', {});
    const bodies = (payloadOf(result)['messages'] as Record<string, unknown>[]).map(
      (message) => message['body'],
    );
    expect(bodies).toContain('child says hello');
    expect(bodies).not.toContain('stranger says hello');
  });
});
