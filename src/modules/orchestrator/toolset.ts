/**
 * The in-process MCP toolset — DESIGN §4, and **the minimum of IMPLEMENTATION M4
 * that M5 and M6 cannot be proved without**.
 *
 * ## Why part of M4 is here at all
 *
 * M6's convergence rule reads `report_status`'s structured `verdict` (§3.3), and
 * its acceptance scenario is "the skeptic critiques it with blocking issues …
 * the skeptic accepts". There is no other channel: "the engine never parses prose
 * for a verdict. A turn either reported structurally or it did not." Likewise
 * §3.2's prompt inlines unread mail, which needs a mailbox agents can actually
 * write to. So four tools land here:
 *
 * | Built now | Why |
 * |---|---|
 * | `report_status` | the convergence rule's only input (§3.3, M6-3) |
 * | `send_to_agent` | inter-agent handoffs in the pair (§5, M6's conversation) |
 * | `read_mailbox` | the other half of the mailbox the prompt advertises (§3.2-4) |
 * | `request_user_decision` | §6.4's stance solicitation, which M6-5 requires |
 *
 * **Left to M4, deliberately**: `list_roster` and `create_assignment` (both
 * overseer-only, and v1 ships no overseer pattern — §8.2 notes their gate "does
 * not fire in the v1 slice at all"), and §4.2's per-session call caps as breaker
 * *inputs*, which are M7's counters. The caps themselves are enforced here
 * because a tool loop is exactly the runaway a cap exists to stop; what is
 * missing is the halt they should trip, and that absence is stated rather than
 * faked.
 *
 * ## One server instance per launch, and that is load-bearing
 *
 * SDK-NOTES **G2**: a `createSdkMcpServer` instance is **single-use** —
 * `Protocol.connect()` throws on a second transport and the SDK swallows the
 * rejection, "so a reused instance yields a session that believes it has the
 * toolset and gets no answers". {@link createToolsetFactory} therefore builds a
 * fresh instance per call, and the launch identity is a closure over it rather
 * than an argument, because SDK-NOTES **[A2]** confirmed `extra` carries no
 * session identity ([A2]). That closure *is* the scoping design (§4.2): the tool
 * does not ask who is calling, it already knows.
 *
 * SDK-NOTES **C3**: MCP tools defer behind tool search by default, so the server
 * is created with `alwaysLoad: true` — without it `report_status` is invisible and
 * the `no_report` breaker fires on a wiring bug rather than on a model's
 * behaviour.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { EventBus } from '../types.js';
import type { Clock } from '../../storage/index.js';

import type { OrchestratorConfig } from './config.js';
import type { MailboxRepository } from './messages.js';
import type { QuestionInbox } from './questions.js';
import { QUESTION_STRENGTHS } from './questions.js';
import type { AssignmentRepository } from './repository.js';
import { isReportState, type TurnRepository, type TurnReport, type TurnVerdict } from './turns.js';
import type { AssignmentRole } from './types.js';

/** DESIGN §4.1: the record key roster mounts the toolset under. */
export const TOOLSET_SERVER_KEY = 'agentmanager';

/** R1b's worker grant. The two overseer tools are M4's (see the file header). */
export const WORKER_TOOL_NAMES = [
  'send_to_agent',
  'read_mailbox',
  'report_status',
  'request_user_decision',
] as const;

export interface LaunchIdentity {
  readonly assignmentId: string;
  readonly agentId: string;
  /** Known at launch; when absent the active turn resolves the seat instead. */
  readonly sessionId?: string | undefined;
  readonly role?: AssignmentRole | undefined;
  readonly isOverseer?: boolean | undefined;
}

/** §4.2's refusal vocabulary — the codes an agent is *taught* by. */
export const TOOL_REFUSAL_CODES = [
  'assignment_out_of_scope',
  'agent_not_in_assignment',
  'assignment_closed',
  'no_active_turn',
  'rate_limited',
  'invalid_arguments',
] as const;

export type ToolRefusalCode = (typeof TOOL_REFUSAL_CODES)[number];

/**
 * What a tool answers with: a JSON text block, and `isError` for a refusal.
 *
 * Every response is a **text** block holding JSON, because MCP has no JSON
 * content-block type (SDK-NOTES, and the M0 spike's `TOOL_SHAPE` note).
 *
 * The mutable array and the index signature are not looseness for its own sake:
 * MCP's `CallToolResult` is an open, mutable record, and a `readonly`/closed shape
 * here would not assign into the handler signature `tool()` demands. The two
 * fields orchestrator actually uses are named, so a typo in either is still a
 * compile error.
 */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  readonly isError?: boolean;
  [key: string]: unknown;
}

export interface SessionToolset {
  /** The value roster places at `options.mcpServers.agentmanager` (R1). */
  readonly server: McpSdkServerConfigWithInstance;
  readonly toolNames: readonly string[];
  /**
   * The same handlers, reachable in process.
   *
   * Not a convenience: roster's mount (R1, roster M7) has not shipped, so this is
   * how the engine's own tests drive a seat's report through the real service
   * instead of pretending an SDK client exists. When the mount lands, the agent's
   * `tools/call` reaches the identical handler.
   */
  call(name: string, args: Readonly<Record<string, unknown>>): Promise<ToolResult>;
}

export type ToolsetFactory = (launch: LaunchIdentity) => SessionToolset;

export interface ToolsetOptions {
  readonly assignments: AssignmentRepository;
  readonly turns: TurnRepository;
  readonly mailbox: MailboxRepository;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly config: OrchestratorConfig;
  /** Resolved lazily — the inbox is built after the service that owns it. */
  readonly inbox: () => QuestionInbox | undefined;
  /** `runner.question.holdMs`, **read** from runner's config rather than copied (§12). */
  readonly holdMs: number;
  /** `runner.question.expireHours`, likewise. */
  readonly expireHours: number;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Argument schemas (§4.3)
// ---------------------------------------------------------------------------

const artifactShape = z.object({ path: z.string().min(1), kind: z.string().optional() });

const verdictShape = z.object({
  decision: z.enum(['accept', 'revise']),
  blocking: z
    .array(z.object({ severity: z.string().min(1), summary: z.string().min(1) }))
    .optional(),
  nonBlocking: z.array(z.string()).optional(),
});

const REPORT_STATUS_SHAPE = {
  state: z.enum(['working', 'blocked', 'needs_review', 'done']),
  headline: z.string().min(1),
  detail: z.string().optional(),
  artifacts: z.array(artifactShape).optional(),
  verdict: verdictShape.optional(),
};

const SEND_TO_AGENT_SHAPE = {
  to: z.string().optional(),
  broadcast: z.boolean().optional(),
  kind: z.enum(['note', 'handoff', 'question', 'answer', 'status']),
  body: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
};

const READ_MAILBOX_SHAPE = {
  unreadOnly: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
  since: z.string().optional(),
  markRead: z.boolean().optional(),
};

const REQUEST_USER_DECISION_SHAPE = {
  question: z.string().min(1),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .optional(),
  recommendation: z
    .object({
      optionId: z.string().optional(),
      // §4.3: "an agent may decline to recommend, but it may not recommend
      // without saying how hard it is recommending."
      strength: z.enum(QUESTION_STRENGTHS),
      rationale: z.string().optional(),
    })
    .optional(),
  urgency: z.enum(['blocking', 'advisory']).optional(),
  multiSelect: z.boolean().optional(),
  allowFreeText: z.boolean().optional(),
};

// ---------------------------------------------------------------------------

export function createToolsetFactory(options: ToolsetOptions): ToolsetFactory {
  const { assignments, turns, mailbox, bus, config } = options;

  return function getSessionToolset(launch: LaunchIdentity): SessionToolset {
    // Per-launch counters — §4.2's caps. In-process on purpose: they bound one
    // *session*, and a session does not outlive the process that runs it.
    const used = { sends: 0, decisions: 0 };

    function ok(payload: unknown): ToolResult {
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }

    /**
     * §4.2 / [A4]: a structured refusal naming the rule that refused.
     *
     * "An agent that learns *why* it was refused stops retrying; a generic
     * failure produces three more attempts and a breaker trip."
     */
    function refuse(code: ToolRefusalCode, message: string, detail?: unknown): ToolResult {
      options.log?.('an orchestrator tool call was refused', {
        code,
        assignmentId: launch.assignmentId,
        agentId: launch.agentId,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              refused: true,
              code,
              message,
              ...(detail === undefined ? {} : { detail }),
            }),
          },
        ],
        isError: true,
      };
    }

    /** Every scoped tool starts here (§4.2). */
    function guard(): ToolResult | undefined {
      const assignment = assignments.get(launch.assignmentId);
      if (assignment === undefined) {
        return refuse(
          'assignment_out_of_scope',
          `Assignment ${launch.assignmentId} does not exist; this session's tools act only on ` +
            'the assignment it was launched under.',
        );
      }
      if (assignment.status !== 'open') {
        // "A tool call from a session whose assignment closed while it was
        // running is refused, not queued."
        return refuse(
          'assignment_closed',
          `Assignment ${launch.assignmentId} is closed. Finish your turn; nothing more will be ` +
            'recorded against it.',
        );
      }
      const members = assignments.listMembers(launch.assignmentId);
      if (!members.some((member) => member.agentId === launch.agentId)) {
        return refuse(
          'agent_not_in_assignment',
          `${launch.agentId} holds no seat in assignment ${launch.assignmentId}.`,
        );
      }
      return undefined;
    }

    /**
     * The turn this session is taking.
     *
     * Resolved by session id when the launch carried one, and otherwise by the
     * assignment's single `planned`-or-`running` turn — which is unambiguous
     * because `assignment_turns_active` makes it so (§2.1). R1's mount signature
     * has no `sessionId`, so the second path is the one production takes.
     */
    function activeTurn(): ReturnType<TurnRepository['active']> {
      if (launch.sessionId !== undefined) {
        const bySession = turns.findBySession(launch.sessionId);
        if (bySession !== undefined) return bySession;
      }
      const active = turns.active(launch.assignmentId);
      return active !== undefined && active.agentId === launch.agentId ? active : undefined;
    }

    // -----------------------------------------------------------------------
    // report_status (§4.3) — the structured completion channel
    // -----------------------------------------------------------------------

    async function reportStatus(args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
      await Promise.resolve();
      const refused = guard();
      if (refused !== undefined) return refused;

      const parsed = z.object(REPORT_STATUS_SHAPE).safeParse(args);
      if (!parsed.success) {
        return refuse('invalid_arguments', parsed.error.issues.map((i) => i.message).join('; '));
      }
      const turn = activeTurn();
      if (turn === undefined) {
        return refuse(
          'no_active_turn',
          'This assignment has no turn in flight for you, so there is nothing to report against.',
        );
      }
      if (!isReportState(parsed.data.state)) {
        return refuse('invalid_arguments', '"state" is outside its vocabulary.');
      }

      const verdict: TurnVerdict | undefined =
        parsed.data.verdict === undefined
          ? undefined
          : {
              decision: parsed.data.verdict.decision,
              blocking: parsed.data.verdict.blocking ?? [],
              nonBlocking: parsed.data.verdict.nonBlocking ?? [],
            };
      const report: TurnReport = {
        state: parsed.data.state,
        headline: parsed.data.headline,
        ...(parsed.data.detail === undefined ? {} : { detail: parsed.data.detail }),
        artifacts: (parsed.data.artifacts ?? []).map((artifact) => ({
          path: artifact.path,
          ...(artifact.kind === undefined ? {} : { kind: artifact.kind }),
        })),
        ...(verdict === undefined ? {} : { verdict }),
        at: options.clock().toISOString(),
      };
      turns.report(turn.id, report);

      const assignment = assignments.get(launch.assignmentId);
      bus.emit({
        type: 'assignment.turn.reported',
        ids: {
          assignmentId: launch.assignmentId,
          agentId: launch.agentId,
          ...(turn.sessionId === null ? {} : { sessionId: turn.sessionId }),
          ...(assignment === undefined ? {} : { projectId: assignment.projectId }),
        },
        persist: true,
        payload: {
          turnId: turn.id,
          round: turn.round,
          seat: turn.seat,
          state: report.state,
          headline: report.headline,
          verdict: verdict ?? null,
        },
      });

      // "Echoed back with the remaining budget and rounds — which is cheap, and
      // is the only honest way an agent learns how much room it has left."
      return ok({
        recorded: true,
        round: turn.round,
        roundsRemaining:
          assignment?.roundCap === null || assignment === undefined
            ? null
            : Math.max(0, assignment.roundCap - turn.round),
        tokensRemaining:
          assignment?.tokenBudget === null || assignment === undefined
            ? null
            : Math.max(0, assignment.tokenBudget - assignment.tokensUsed),
      });
    }

    // -----------------------------------------------------------------------
    // send_to_agent (§4.3)
    // -----------------------------------------------------------------------

    async function sendToAgent(args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
      await Promise.resolve();
      const refused = guard();
      if (refused !== undefined) return refused;

      const parsed = z.object(SEND_TO_AGENT_SHAPE).safeParse(args);
      if (!parsed.success) {
        return refuse('invalid_arguments', parsed.error.issues.map((i) => i.message).join('; '));
      }
      if (used.sends >= config.breakers.messagesPerTurn) {
        // §4.2: exceeding a cap refuses the call. Tripping the breaker that
        // should follow is M7's; the refusal is not deferred with it, because a
        // tool loop that is merely *counted* still runs.
        return refuse(
          'rate_limited',
          `This session has already sent ${String(config.breakers.messagesPerTurn)} messages, ` +
            'which is its cap. Say what remains in your report instead.',
        );
      }

      const broadcast = parsed.data.broadcast === true;
      const to = parsed.data.to;
      if (!broadcast) {
        if (to === undefined) {
          return refuse('invalid_arguments', 'Name a recipient with "to", or set broadcast: true.');
        }
        const members = assignments.listMembers(launch.assignmentId);
        if (!members.some((member) => member.agentId === to)) {
          return refuse(
            'agent_not_in_assignment',
            `${to} holds no seat in your assignment, so it has no mailbox you may write to. ` +
              `Your co-members are: ${members
                .filter((member) => member.agentId !== launch.agentId)
                .map((member) => `${member.agentId} (${member.role})`)
                .join(', ')}.`,
          );
        }
      }

      used.sends += 1;
      const message = mailbox.send({
        assignmentId: launch.assignmentId,
        fromAgentId: launch.agentId,
        ...(broadcast ? { broadcast: true } : { toAgentId: to }),
        kind: parsed.data.kind,
        body: parsed.data.body,
        ...(parsed.data.payload === undefined ? {} : { payload: parsed.data.payload }),
      });

      bus.emit({
        type: 'assignment.message',
        ids: { assignmentId: launch.assignmentId, agentId: launch.agentId },
        // §11.4: not persisted — "body lives in the table", and the conversation
        // endpoint is its record.
        persist: false,
        payload: {
          messageId: message.id,
          from: launch.agentId,
          to: message.toAgentId,
          kind: message.kind,
        },
      });

      // "The tool tells the agent the truth about delivery rather than letting it
      // assume a live channel."
      return ok({
        messageId: message.id,
        delivery: 'mailbox',
        recipientWillSeeIt: 'at its next turn in this assignment',
      });
    }

    // -----------------------------------------------------------------------
    // read_mailbox (§4.3)
    // -----------------------------------------------------------------------

    async function readMailbox(args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
      await Promise.resolve();
      const refused = guard();
      if (refused !== undefined) return refused;

      const parsed = z.object(READ_MAILBOX_SHAPE).safeParse(args);
      if (!parsed.success) {
        return refuse('invalid_arguments', parsed.error.issues.map((i) => i.message).join('; '));
      }

      const messages = mailbox.mailbox(launch.agentId, {
        // Scoped to `scopeOf(identity)`, which for a worker is exactly its own
        // assignment — the whole point of the closed-over identity (§4.2).
        assignmentId: launch.assignmentId,
        unreadOnly: parsed.data.unreadOnly ?? true,
        ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
        ...(parsed.data.since === undefined ? {} : { since: parsed.data.since }),
      });

      if (parsed.data.markRead !== false) {
        for (const message of messages) mailbox.markRead(message.id, launch.agentId);
      } else {
        // §5.1: `delivered_at` is set when a message is *returned* by
        // `read_mailbox`, whether or not the caller marked it read.
        for (const message of messages) mailbox.markDelivered(message.id);
      }

      return ok({
        messages: messages.map((message) => ({
          id: message.id,
          from: message.fromAgentId,
          kind: message.kind,
          body: message.body,
          payload: message.payload ?? null,
          createdAt: message.createdAt,
        })),
        unreadRemaining: mailbox.unreadCount(launch.agentId, launch.assignmentId),
      });
    }

    // -----------------------------------------------------------------------
    // request_user_decision (§4.3, §4.4)
    // -----------------------------------------------------------------------

    async function requestUserDecision(
      args: Readonly<Record<string, unknown>>,
    ): Promise<ToolResult> {
      const refused = guard();
      if (refused !== undefined) return refused;

      const parsed = z.object(REQUEST_USER_DECISION_SHAPE).safeParse(args);
      if (!parsed.success) {
        return refuse('invalid_arguments', parsed.error.issues.map((i) => i.message).join('; '));
      }
      if (used.decisions >= config.breakers.maxDecisionsPerSession) {
        return refuse(
          'rate_limited',
          `This session has already raised ${String(config.breakers.maxDecisionsPerSession)} ` +
            'decisions, which is its cap.',
        );
      }
      const inbox = options.inbox();
      if (inbox === undefined) {
        return refuse(
          'no_active_turn',
          'This build has no question inbox, so a decision cannot be raised. Record the choice ' +
            'you would have asked about in your report and continue.',
        );
      }

      used.decisions += 1;
      const now = options.clock().getTime();
      const recommendation = parsed.data.recommendation;
      const outcome = await Promise.race([
        inbox.ask({
          sessionId: launch.sessionId ?? null,
          assignmentId: launch.assignmentId,
          agentId: launch.agentId,
          kind: 'question',
          prompt: parsed.data.question,
          ...(parsed.data.options === undefined ? {} : { options: parsed.data.options }),
          multiSelect: parsed.data.multiSelect ?? false,
          allowFreeText: parsed.data.allowFreeText ?? true,
          holdUntil: new Date(now + options.holdMs).toISOString(),
          expiresAt: new Date(now + options.expireHours * 3_600_000).toISOString(),
          ...(recommendation === undefined
            ? {}
            : {
                recommendation: {
                  agentId: launch.agentId,
                  stance: recommendation.optionId ?? null,
                  strength: recommendation.strength,
                  ...(recommendation.rationale === undefined
                    ? {}
                    : { rationale: recommendation.rationale }),
                },
              }),
          // §6.4: the join window is waived for a solicited stance, because the
          // card is explicitly waiting for it. An unsolicited ask joins only
          // inside the window.
          solicited: true,
        }),
        hold(options.holdMs),
      ]);

      if (outcome === HELD || outcome.status !== 'answered') {
        // §4.4: past the hold this **never parks the session**. The turn ends
        // cleanly and the engine re-drives the seat with the answer, because two
        // systems resuming one session is the bug runner §15.1-7 warns about.
        return ok({
          status: 'pending',
          instruction:
            'No answer yet. Stop here, call ' +
            'mcp__agentmanager__report_status with state "blocked", and end your turn. You will ' +
            'be continued with the answer.',
        });
      }

      return ok({
        status: 'answered',
        answer: {
          optionIds: outcome.answer.optionIds ?? [],
          text: outcome.answer.text ?? null,
        },
        answeredVia: outcome.answeredVia,
      });
    }

    const handlers = new Map<
      string,
      (args: Readonly<Record<string, unknown>>) => Promise<ToolResult>
    >([
      ['report_status', reportStatus],
      ['send_to_agent', sendToAgent],
      ['read_mailbox', readMailbox],
      ['request_user_decision', requestUserDecision],
    ]);

    // A fresh instance per launch — SDK-NOTES G2, and the basis of §4.2.
    const server = createSdkMcpServer({
      name: TOOLSET_SERVER_KEY,
      version: '1.0.0',
      instructions:
        'These tools act on the assignment this session was launched under. They take no ' +
        'assignment id: it is implicit, and a call naming someone else’s work is refused.',
      // SDK-NOTES C3: without this, MCP tools defer behind tool search and
      // `report_status` is invisible.
      alwaysLoad: true,
      tools: [
        tool(
          'report_status',
          'Report your structured status for this turn: state, a one-line headline, the ' +
            'artifacts you touched, and — for a critic or reviewer seat — your verdict.',
          REPORT_STATUS_SHAPE,
          (args) => reportStatus(args as Record<string, unknown>),
        ),
        tool(
          'send_to_agent',
          'Send a message to a co-member of your assignment, or broadcast to all of them. ' +
            'Delivery is a mailbox, not a live channel.',
          SEND_TO_AGENT_SHAPE,
          (args) => sendToAgent(args as Record<string, unknown>),
          { annotations: { readOnlyHint: false } },
        ),
        tool(
          'read_mailbox',
          'Read the messages addressed to you in this assignment.',
          READ_MAILBOX_SHAPE,
          (args) => readMailbox(args as Record<string, unknown>),
          { annotations: { readOnlyHint: true } },
        ),
        tool(
          'request_user_decision',
          'Ask the user to decide something, with your own recommendation and how hard you are ' +
            'recommending it. Holds briefly, then tells you to stop and be continued.',
          REQUEST_USER_DECISION_SHAPE,
          (args) => requestUserDecision(args as Record<string, unknown>),
        ),
      ],
    });

    return {
      server,
      toolNames: [...WORKER_TOOL_NAMES],
      call(name, args) {
        const handler = handlers.get(name);
        if (handler === undefined) {
          return Promise.resolve(
            refuse(
              'invalid_arguments',
              `There is no ${name} tool in this build. Available: ${WORKER_TOOL_NAMES.join(', ')}.`,
            ),
          );
        }
        return handler(args);
      },
    };
  };
}

/** The sentinel {@link hold} resolves with, so `undefined` stays a real answer. */
const HELD = Symbol('held');

function hold(ms: number): Promise<typeof HELD> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(HELD), ms);
    // Never hold the process open for a hold nobody is waiting on: a 15-minute
    // timer on the event loop would keep a shutting-down service alive.
    timer.unref?.();
  });
}
