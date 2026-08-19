/**
 * The Start work decisions, without a DOM (DESIGN §6, §10.4; orchestrator §3.5).
 *
 * Everything asserted here is a rule the dialog cannot restate: which shapes a
 * count offers, who takes which seat, what each request body is, and the one
 * sentence an overseer's goal carries about the workers the user picked. They
 * are unit tests because the rules are pure, and because a rule proven through
 * a rendered dialog is proven once for the path that dialog happened to take.
 */

import { describe, expect, it } from 'vitest';

import { anAgent, aProject } from '../../test/harness';
import type { AgentView, AssignmentView, SeatDefinition } from '../api/types';
import { anAssignment } from '../assignments/fixtures';

import {
  connectorChips,
  connectorsNeedAttention,
  declaresAny,
  goalWithWorkers,
  launchableProjects,
  openAssignmentCounts,
  patternFor,
  patternRequest,
  rankForSeats,
  refusedProjects,
  roleForSeat,
  scopePathList,
  seatMembers,
  soloRequest,
  startBlocker,
  suggestedWorkersLine,
  teamworkFor,
  teamworkOptions,
} from './model';

/** An agent that declares roles — the harness's fixture never does. */
function declaring(id: string, roles: readonly string[]): AgentView {
  const base = anAgent({ id, name: id });
  return {
    ...base,
    definition: { ...base.definition, capabilities: { roles } },
  };
}

const PAIR_SEATS: readonly SeatDefinition[] = [
  { key: 'drafter', roles: ['architect', 'implementer'], required: true, write: true },
  { key: 'critic', roles: ['skeptic'], required: true, write: false },
];

describe('the shape of the work is the count’s question (§6)', () => {
  it('offers exactly what the count allows', () => {
    expect(teamworkOptions(0)).toEqual(['solo']);
    expect(teamworkOptions(1)).toEqual(['solo']);
    expect(teamworkOptions(2)).toEqual(['pair', 'independent']);
    expect(teamworkOptions(5)).toEqual(['team', 'independent']);
  });

  it('keeps a choice that is still on offer, and falls back when it is not', () => {
    // Adding a third agent to a pair does not silently keep "pair".
    expect(teamworkFor(3, 'pair')).toBe('team');
    // …but it does keep "independent", which every count above one offers.
    expect(teamworkFor(3, 'independent')).toBe('independent');
    expect(teamworkFor(2, null)).toBe('pair');
    expect(teamworkFor(1, 'team')).toBe('solo');
  });

  it('maps each shape onto the pattern it posts, or onto solos', () => {
    expect(patternFor('pair')).toBe('pair');
    expect(patternFor('team')).toBe('overseer');
    expect(patternFor('solo')).toBeNull();
    expect(patternFor('independent')).toBeNull();
  });
});

describe('seating ranks, it never gates (owner decision 2026-08-18)', () => {
  it('puts the agent that declares the seat’s role in it, whatever the pick order', () => {
    const skeptic = declaring('sam', ['skeptic']);
    const architect = declaring('ada', ['architect']);
    // Picked skeptic-first: the ranking still drafts with the architect.
    const seated = rankForSeats(PAIR_SEATS, [skeptic, architect]);
    expect(seated.map((agent) => agent.definition.id)).toEqual(['ada', 'sam']);
  });

  it('seats agents that declare nothing rather than leaving a seat empty', () => {
    const nobody = [anAgent({ id: 'a' }), anAgent({ id: 'b' })];
    const seated = rankForSeats(PAIR_SEATS, nobody);
    expect(seated.map((agent) => agent.definition.id)).toEqual(['a', 'b']);
    // …and each carries the seat's first allowed role, which is what makes the
    // server answer `role_not_declared` rather than refusing the create.
    expect(seatMembers(PAIR_SEATS, seated)).toEqual([
      { agentId: 'a', role: 'architect' },
      { agentId: 'b', role: 'skeptic' },
    ]);
  });

  it('reads a declared role for the seat where there is one', () => {
    expect(roleForSeat(['architect', 'implementer'], ['implementer'])).toBe('implementer');
    expect(roleForSeat(['skeptic'], ['architect'])).toBe('skeptic');
    expect(declaresAny(declaring('x', ['skeptic']), ['skeptic', 'reviewer'])).toBe(true);
    expect(declaresAny(anAgent({ id: 'x' }), ['skeptic'])).toBe(false);
  });
});

describe('the projects a flow may point at (§5.3)', () => {
  const active = aProject({ id: 'lpm' });
  const archived = aProject({ id: 'old', status: 'archived' });

  it('offers the launchable ones and names the rest with their reason', () => {
    expect(launchableProjects([active, archived]).map((one) => one.id)).toEqual(['lpm']);
    const refused = refusedProjects([active, archived]);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.project.id).toBe('old');
    expect(refused[0]?.refusal).toContain('archived');
  });
});

describe('the open-assignment count on each row (§10.4)', () => {
  it('counts a seat per assignment, per agent', () => {
    const assignments: readonly AssignmentView[] = [
      anAssignment({ id: 'a', status: 'open' }),
      anAssignment({
        id: 'b',
        status: 'open',
        members: [
          { agentId: 'ada', role: 'architect', seatOrder: 0, joinedAt: '2026-08-17T09:00:00.000Z' },
        ],
      }),
    ];
    const counts = openAssignmentCounts(assignments);
    expect(counts.get('ada')).toBe(2);
    expect(counts.get('sam')).toBe(1);
    expect(counts.get('nobody')).toBeUndefined();
  });
});

describe('the request bodies (§16.7, §10.4)', () => {
  it('sends orchestrator §16.7’s solo body and nothing beside it', () => {
    expect(
      soloRequest({
        projectId: 'lpm',
        agentId: 'ada',
        prompt: 'go',
        role: undefined,
        write: false,
        workItemIds: [],
        confirmRemoteAccess: false,
      }),
    ).toEqual({ projectId: 'lpm', agentId: 'ada', prompt: 'go' });

    expect(
      soloRequest({
        projectId: 'lpm',
        agentId: 'ada',
        prompt: 'go',
        role: 'implementer',
        write: true,
        workItemIds: ['wi_1'],
        confirmRemoteAccess: true,
      }),
    ).toEqual({
      projectId: 'lpm',
      agentId: 'ada',
      prompt: 'go',
      role: 'implementer',
      write: true,
      workItemIds: ['wi_1'],
      confirmRemoteAccess: true,
    });
  });

  it('always parks a pattern create, so the warnings can be read first', () => {
    const body = patternRequest({
      projectId: 'lpm',
      pattern: 'overseer',
      members: [{ agentId: 'rio', role: 'overseer' }],
      goal: 'ship it',
      scopePaths: ['src'],
      artifactPath: '',
      roundCap: '3',
      tokenBudget: '900000',
      confirmRemoteAccess: false,
    });
    expect(body.autoStart).toBe(false);
    expect(body.scope).toEqual({ paths: ['src'] });
    expect(body.roundCap).toBe(3);
    expect(body.tokenBudget).toBe(900_000);
    // An empty numeric field is *absent*, never `0` or `null`: the server's own
    // default is the honest fallback, and `0` would be a cap nobody chose.
    const empty = patternRequest({
      projectId: 'lpm',
      pattern: 'pair',
      members: [],
      goal: '',
      scopePaths: [],
      artifactPath: 'docs/d.md',
      roundCap: '',
      tokenBudget: '',
      confirmRemoteAccess: false,
    });
    expect(empty).not.toHaveProperty('roundCap');
    expect(empty).not.toHaveProperty('tokenBudget');
    expect(empty).not.toHaveProperty('goal');
    expect(empty.scope).toEqual({ paths: [], artifactPath: 'docs/d.md' });
  });

  it('trims scope paths and drops the empties', () => {
    expect(scopePathList(' src/import , , docs ')).toEqual(['src/import', 'docs']);
    expect(scopePathList('')).toEqual([]);
  });
});

describe('the overseer’s suggested workers are guidance, and say so (§3.5)', () => {
  it('names them with their ids and hands the decision to the lead', () => {
    const line = suggestedWorkersLine([
      { id: 'ada', name: 'Ada' },
      { id: 'sam', name: 'Sam' },
    ]);
    // Ids, because `create_assignment` takes agent ids.
    expect(line).toContain('Ada (ada)');
    expect(line).toContain('Sam (sam)');
    // And the sentence that keeps it from reading as a contract.
    expect(line).toContain('the final split is yours');
    expect(line).toContain('list_roster');
  });

  it('adds nothing when the lead is the only agent picked', () => {
    expect(suggestedWorkersLine([])).toBe('');
    expect(goalWithWorkers('ship it', [])).toBe('ship it');
  });

  it('keeps the user’s brief first, and the suggestion after it', () => {
    const goal = goalWithWorkers('ship it', [{ id: 'ada', name: 'Ada' }]);
    expect(goal.startsWith('ship it\n\n')).toBe(true);
    expect(goal).toContain('Prefer seating these agents in child assignments');
  });
});

describe('the only client-side refusals, and why each one is honest (§10.4)', () => {
  const base = {
    hasOrchestrator: true,
    projectId: 'lpm',
    agentCount: 1,
    task: 'go',
    teamwork: 'solo' as const,
    tokenBudget: '',
    requiresTokenBudget: false,
  };

  it('lets a complete solo through', () => {
    expect(startBlocker(base)).toBeUndefined();
  });

  it('names the missing field rather than disabling silently', () => {
    expect(startBlocker({ ...base, projectId: null })).toBe('Choose a project.');
    expect(startBlocker({ ...base, agentCount: 0 })).toBe('Choose at least one agent.');
    expect(startBlocker({ ...base, task: '   ' })).toBe('Describe the task.');
    expect(startBlocker({ ...base, hasOrchestrator: false })).toContain('orchestrator');
  });

  it('holds an overseer to a token budget, and holds nothing else to one', () => {
    const team = { ...base, agentCount: 3, teamwork: 'team' as const, requiresTokenBudget: true };
    expect(startBlocker(team)).toContain('token budget');
    expect(startBlocker({ ...team, tokenBudget: '900000' })).toBeUndefined();
    // A `pair` with no budget is accepted by `validate.ts`, so it is accepted
    // here: the client refuses nothing the server would take (§10.4).
    expect(
      startBlocker({ ...base, agentCount: 2, teamwork: 'pair', requiresTokenBudget: false }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Connector preflight (roster §10, WO6 item 2)
// ---------------------------------------------------------------------------

describe('the connector chips', () => {
  const withConnectors = (id: string, rows: NonNullable<AgentView['integrations']>): AgentView =>
    anAgent({ id, name: id, integrationStates: rows });

  const row = (
    integration: string,
    state: 'ready' | 'needs-auth' | 'missing-secret',
  ): NonNullable<AgentView['integrations']>[number] => ({
    integration,
    transport: 'http',
    auth: state === 'needs-auth' ? 'oauth' : 'credentials',
    toolPrefix: `mcp__${integration}__`,
    state,
    credentials: [],
    missingSecretRefs: state === 'missing-secret' ? [`mcp.${integration}.token`] : [],
    required: false,
    detail: `${integration} is ${state}`,
  });

  it('renders one chip per declared integration, per agent, worst first', () => {
    const chips = connectorChips([
      withConnectors('priya', [row('files', 'ready'), row('todo', 'needs-auth')]),
      withConnectors('sam', [row('gmail', 'missing-secret')]),
    ]);
    expect(chips.map((chip) => `${chip.agentId}:${chip.integration}:${chip.state}`)).toEqual([
      'priya:todo:needs-auth',
      'priya:files:ready',
      'sam:gmail:missing-secret',
    ]);
    expect(connectorsNeedAttention(chips)).toBe(true);
  });

  it('links a missing secret to settings and a missing connector to the agent editor', () => {
    const chips = connectorChips(
      [withConnectors('sam', [row('gmail', 'missing-secret')])],
      ['todo'],
    );
    const secret = chips.find((chip) => chip.state === 'missing-secret');
    expect(secret?.action).toEqual({
      kind: 'secrets',
      label: 'Set the secret…',
      to: '/settings',
    });

    // WO5's `requiredIntegrations`: a connector the task needs and the agent
    // does not declare is `not-attached`, and the fix is the integrations panel.
    const attach = chips.find((chip) => chip.integration === 'todo');
    expect(attach?.state).toBe('not-attached');
    expect(attach?.action).toEqual({
      kind: 'editor',
      label: 'Add the connector…',
      to: '/agents/sam',
    });
  });

  it('offers no action for a ready or OAuth connector — there is nothing to press', () => {
    const chips = connectorChips([withConnectors('priya', [row('todo', 'needs-auth')])]);
    // The SDK has no headless authorize call, so a button here would be a lie;
    // the link is raised by the session (runner/mcpAuth.ts).
    expect(chips[0]?.action).toBeUndefined();
    expect(chips[0]?.label).toBe('needs authorising');
  });

  it('says nothing at all for an agent with no integrations', () => {
    expect(connectorChips([anAgent({ id: 'priya' })])).toEqual([]);
    expect(connectorsNeedAttention([])).toBe(false);
  });
});
