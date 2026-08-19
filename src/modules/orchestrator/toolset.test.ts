/**
 * The in-process MCP toolset (DESIGN §4; the M4 slice M5/M6 need).
 *
 * Two halves, mirroring the M0 spike's own split:
 *
 * 1. **Through the handlers**, which is how the engine and the prompt's
 *    instructions actually reach them, and how every scoping rule of §4.2 is
 *    asserted;
 * 2. **Through the MCP server object** — a real `createSdkMcpServer` instance
 *    driven over the same loopback transport the spike uses — so [A1], [A2] and
 *    G2's single-use rule are proved against *this* toolset rather than a probe.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAILBOX_TEMPO } from './prompt.js';
import {
  TOOLSET_SERVER_KEY,
  WORKER_TOOL_NAMES,
  type SessionToolset,
  type ToolResult,
} from './toolset.js';
import { makeHarness, PROJECT_ID, type Harness } from './__tests__/helpers.js';

let harness: Harness;
let assignmentId: string;

const AGENTS = [
  { id: 'ada', roles: ['architect' as const] },
  { id: 'sam', roles: ['skeptic' as const] },
  { id: 'kim', roles: ['implementer' as const] },
];

beforeEach(async () => {
  harness = makeHarness({ agents: AGENTS, attachEngine: false });
  const created = await harness.service.createAssignment({
    projectId: PROJECT_ID,
    pattern: 'pair',
    goal: 'Write the design',
    members: [
      { agentId: 'ada', role: 'architect' },
      { agentId: 'sam', role: 'skeptic' },
    ],
    scope: { paths: ['docs/x/'], artifactPath: 'docs/x/DESIGN.md' },
    autoStart: false,
  });
  assignmentId = created.assignmentId;
});

afterEach(() => {
  harness.cleanup();
});

function toolsetFor(agentId: string, assignment = assignmentId): SessionToolset {
  return harness.toolset({ assignmentId: assignment, agentId });
}

function payloadOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

/** Plans and starts a turn the way the engine would, so a report has a target. */
function startTurn(seat: string, agentId: string, sessionId: string): string {
  const turn = harness.turns.plan({ assignmentId, round: 1, seat, agentId });
  return harness.turns.start(turn.id, sessionId).id;
}

describe('the launch identity is a closure, not an argument (§4.1, [A2])', () => {
  it('exposes the four worker tools and takes no assignment id anywhere', () => {
    const toolset = toolsetFor('ada');
    expect(toolset.toolNames).toEqual([...WORKER_TOOL_NAMES]);
    expect(toolset.server.name).toBe(TOOLSET_SERVER_KEY);
    expect(toolset.server.type).toBe('sdk');
  });

  it('builds a fresh instance per launch — SDK-NOTES G2’s single-use rule', () => {
    const first = toolsetFor('ada');
    const second = toolsetFor('sam');
    const again = toolsetFor('ada');
    expect(first.server.instance).not.toBe(second.server.instance);
    // Even for the *same* identity: two concurrent sessions of one agent are two
    // launches, and a reused instance is a session that gets no answers.
    expect(first.server.instance).not.toBe(again.server.instance);
  });

  it('refuses an unknown tool by name, listing what this build has', async () => {
    const result = await toolsetFor('ada').call('summon_a_pony', {});
    expect(result.isError).toBe(true);
    expect(payloadOf(result)['message']).toContain('report_status');
  });
});

describe('§4.2 — enforcement lives in the tool', () => {
  it('refuses an agent that holds no seat in the assignment', async () => {
    const result = await toolsetFor('kim').call('read_mailbox', {});
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ code: 'agent_not_in_assignment' });
  });

  it('refuses every call once the assignment is closed, rather than queueing it', async () => {
    await harness.service.closeAssignment(assignmentId, 'user_closed');
    const result = await toolsetFor('ada').call('report_status', {
      state: 'done',
      headline: 'too late',
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ code: 'assignment_closed' });
  });

  it('refuses an assignment that does not exist', async () => {
    const result = await toolsetFor('ada', 'nope').call('read_mailbox', {});
    expect(payloadOf(result)).toMatchObject({ code: 'assignment_out_of_scope' });
  });

  it('names the rule *and* the remedy, so the agent learns instead of retrying', async () => {
    const result = await toolsetFor('ada').call('send_to_agent', {
      to: 'kim',
      kind: 'note',
      body: 'hello',
    });
    const payload = payloadOf(result);
    expect(payload['code']).toBe('agent_not_in_assignment');
    expect(String(payload['message'])).toContain('sam (skeptic)');
  });
});

describe('report_status — the structured completion channel (§4.3)', () => {
  it('writes the verdict onto the calling session’s turn row and echoes the room left', async () => {
    const turnId = startTurn('critic', 'sam', 'session-critic-1');
    const result = await toolsetFor('sam').call('report_status', {
      state: 'done',
      headline: 'Two blocking issues',
      artifacts: [{ path: 'docs/x/DESIGN.md', kind: 'doc' }],
      verdict: {
        decision: 'revise',
        blocking: [{ severity: 'high', summary: 'No rollback path' }],
        nonBlocking: ['naming nit'],
      },
    });

    expect(result.isError).toBeUndefined();
    expect(payloadOf(result)).toMatchObject({
      recorded: true,
      round: 1,
      roundsRemaining: 2,
      tokensRemaining: 400_000,
    });
    const turn = harness.turns.get(turnId);
    expect(turn?.report).toMatchObject({
      state: 'done',
      headline: 'Two blocking issues',
      verdict: { decision: 'revise', blocking: [{ summary: 'No rollback path' }] },
    });
    expect(
      harness.events.filter((event) => event.type === 'assignment.turn.reported'),
    ).toHaveLength(1);
  });

  it('refuses when there is no turn in flight for the caller', async () => {
    const result = await toolsetFor('ada').call('report_status', {
      state: 'done',
      headline: 'nothing to report against',
    });
    expect(payloadOf(result)).toMatchObject({ code: 'no_active_turn' });
  });

  it('refuses a state outside the vocabulary, and a report with no headline', async () => {
    startTurn('drafter', 'ada', 'session-1');
    expect(
      payloadOf(
        await toolsetFor('ada').call('report_status', { state: 'finished', headline: 'x' }),
      ),
    ).toMatchObject({ code: 'invalid_arguments' });
    expect(
      payloadOf(await toolsetFor('ada').call('report_status', { state: 'done', headline: '' })),
    ).toMatchObject({ code: 'invalid_arguments' });
  });

  it('does not let one seat report against another seat’s turn', async () => {
    startTurn('drafter', 'ada', 'session-1');
    const result = await toolsetFor('sam').call('report_status', {
      state: 'done',
      headline: 'not mine',
    });
    expect(payloadOf(result)).toMatchObject({ code: 'no_active_turn' });
  });
});

describe('send_to_agent and read_mailbox (§4.3, §5.1)', () => {
  it('delivers to a co-member and tells the sender the truth about delivery', async () => {
    const sent = await toolsetFor('ada').call('send_to_agent', {
      to: 'sam',
      kind: 'handoff',
      body: 'Draft is at docs/x/DESIGN.md.',
    });
    expect(payloadOf(sent)).toMatchObject({
      delivery: 'mailbox',
      recipientWillSeeIt: 'at its next turn in this assignment',
    });
    // The tool's answer and the prompt's tempo sentence are the same claim, so
    // they have to agree: an agent told two different things about when its mail
    // arrives will believe the one that suits it and wait for a mid-turn reply.
    expect(MAILBOX_TEMPO).toContain('next turn');

    const read = await toolsetFor('sam').call('read_mailbox', {});
    const payload = payloadOf(read) as {
      messages: { from: string; body: string }[];
      unreadRemaining: number;
    };
    expect(payload.messages).toEqual([
      expect.objectContaining({ from: 'ada', body: 'Draft is at docs/x/DESIGN.md.' }),
    ]);
    expect(payload.unreadRemaining).toBe(0);
  });

  it('never returns mail from another assignment sharing one agent (§4.2)', async () => {
    const other = await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'pair',
      members: [
        { agentId: 'kim', role: 'implementer' },
        { agentId: 'sam', role: 'skeptic' },
      ],
      autoStart: false,
    });
    await harness
      .toolset({ assignmentId: other.assignmentId, agentId: 'kim' })
      .call('send_to_agent', { to: 'sam', kind: 'note', body: 'from the other assignment' });
    await toolsetFor('ada').call('send_to_agent', { to: 'sam', kind: 'note', body: 'from mine' });

    const read = await toolsetFor('sam').call('read_mailbox', {});
    const payload = payloadOf(read) as { messages: { body: string }[] };
    expect(payload.messages.map((message) => message.body)).toEqual(['from mine']);
  });

  it('caps sends per session and refuses past the cap', async () => {
    const toolset = toolsetFor('ada');
    const cap = harness.config.breakers.messagesPerTurn;
    for (let index = 0; index < cap; index += 1) {
      const result = await toolset.call('send_to_agent', {
        to: 'sam',
        kind: 'note',
        body: `note ${String(index)}`,
      });
      expect(result.isError).toBeUndefined();
    }
    const refused = await toolset.call('send_to_agent', {
      to: 'sam',
      kind: 'note',
      body: 'one more',
    });
    expect(payloadOf(refused)).toMatchObject({ code: 'rate_limited' });
    // The cap is per launch, so a fresh session is not punished for it.
    const fresh = await toolsetFor('ada').call('send_to_agent', {
      to: 'sam',
      kind: 'note',
      body: 'new session',
    });
    expect(fresh.isError).toBeUndefined();
  });

  it('marks read by default and only delivered when asked not to', async () => {
    await toolsetFor('ada').call('send_to_agent', { to: 'sam', kind: 'note', body: 'peek' });
    await toolsetFor('sam').call('read_mailbox', { markRead: false });
    expect(harness.mailbox.unreadCount('sam', assignmentId)).toBe(1);
    await toolsetFor('sam').call('read_mailbox', {});
    expect(harness.mailbox.unreadCount('sam', assignmentId)).toBe(0);
  });
});

describe('request_user_decision (§4.3, §4.4)', () => {
  it('returns the answer inline when it lands inside the hold', async () => {
    const pending = toolsetFor('ada').call('request_user_decision', {
      question: 'Disk or DB?',
      options: [
        { id: 'disk', label: 'On disk' },
        { id: 'db', label: 'In SQLite' },
      ],
      recommendation: { optionId: 'disk', strength: 'strong', rationale: 'simpler' },
    });
    // The card exists the moment `ask()` writes the row.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const card = harness.inbox.list({ assignmentId, status: 'open' })[0];
    expect(card?.recommendations).toEqual([
      expect.objectContaining({ agentId: 'ada', stance: 'disk', strength: 'strong' }),
    ]);
    harness.inbox.answer(card?.id ?? '', { optionIds: ['disk'], answeredVia: 'local' });

    expect(payloadOf(await pending)).toMatchObject({
      status: 'answered',
      answer: { optionIds: ['disk'] },
    });
  });

  it('past the hold it instructs the agent to stop — it never parks the session', async () => {
    const result = await toolsetFor('ada').call('request_user_decision', {
      question: 'Something nobody answers',
    });
    const payload = payloadOf(result);
    expect(payload['status']).toBe('pending');
    expect(String(payload['instruction'])).toContain('state "blocked"');
    expect(String(payload['instruction'])).toContain('end your turn');
  });

  it('refuses a recommendation with no strength — never a number, never a percentage', async () => {
    const result = await toolsetFor('ada').call('request_user_decision', {
      question: 'Disk or DB?',
      recommendation: { optionId: 'disk', rationale: 'simpler' },
    });
    expect(payloadOf(result)).toMatchObject({ code: 'invalid_arguments' });
  });

  it('caps decisions per session', async () => {
    const toolset = toolsetFor('ada');
    for (let index = 0; index < harness.config.breakers.maxDecisionsPerSession; index += 1) {
      await toolset.call('request_user_decision', { question: `q${String(index)}` });
    }
    expect(
      payloadOf(await toolset.call('request_user_decision', { question: 'one too many' })),
    ).toMatchObject({ code: 'rate_limited' });
  });
});

// ---------------------------------------------------------------------------
// Through a real MCP transport — the spike's loopback, applied to this toolset
// ---------------------------------------------------------------------------

type Frame = Record<string, unknown>;

class LoopbackTransport {
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((message: Frame, extra?: unknown) => void) | undefined;
  readonly sent: Frame[] = [];

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(message: Frame): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }

  deliver(frame: Frame): void {
    this.onmessage?.(frame);
  }

  async awaitResponse(id: number, timeoutMs = 5_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.sent.find((frame) => frame['id'] === id);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`no response for ${String(id)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

type Instance = SessionToolset['server']['instance'];
type ConnectArg = Parameters<Instance['connect']>[0];

async function connect(instance: Instance): Promise<LoopbackTransport> {
  const transport = new LoopbackTransport();
  await instance.connect(transport as unknown as ConnectArg);
  transport.deliver({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agentmanager-test', version: '0.0.0' },
    },
  });
  await transport.awaitResponse(1);
  transport.deliver({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return transport;
}

function textOf(frame: Frame): string {
  const result = frame['result'] as { content?: { text?: string }[] } | undefined;
  return (result?.content ?? []).map((block) => block.text ?? '').join('');
}

describe('driven as a real MCP server (SDK-NOTES [A1], [A2], C3)', () => {
  it('lists the four tools and reaches the handler from the closed-over identity', async () => {
    startTurn('drafter', 'ada', 'session-mcp');
    const toolset = toolsetFor('ada');
    const transport = await connect(toolset.server.instance);

    transport.deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await transport.awaitResponse(2);
    const tools = (listed['result'] as { tools?: { name: string }[] } | undefined)?.tools ?? [];
    expect(tools.map((entry) => entry.name).sort()).toEqual([...WORKER_TOOL_NAMES].sort());

    // C3: `alwaysLoad` must be stamped, or `report_status` defers behind tool
    // search and the `no_report` breaker fires on a wiring bug.
    const reportTool = tools.find((entry) => entry.name === 'report_status') as
      { _meta?: Record<string, unknown> } | undefined;
    expect(reportTool?._meta?.['anthropic/alwaysLoad']).toBe(true);

    transport.deliver({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'report_status',
        arguments: { state: 'done', headline: 'Draft complete', artifacts: [] },
      },
    });
    const called = await transport.awaitResponse(3);
    expect(JSON.parse(textOf(called))).toMatchObject({ recorded: true, round: 1 });
    // The write landed on the row this launch owns, without the model naming it.
    expect(harness.turns.findBySession('session-mcp')?.report?.headline).toBe('Draft complete');
  });

  it('delivers a refusal as readable text rather than crashing the turn ([A4])', async () => {
    const transport = await connect(toolsetFor('kim').server.instance);
    transport.deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'read_mailbox', arguments: {} },
    });
    const called = await transport.awaitResponse(2);
    expect((called['result'] as { isError?: boolean }).isError).toBe(true);
    expect(JSON.parse(textOf(called))).toMatchObject({ code: 'agent_not_in_assignment' });
  });
});
