/**
 * The in-process MCP toolset — DESIGN §4, IMPLEMENTATION M4 **complete**.
 *
 * ## The six tools, and which launch sees which
 *
 * Four of them landed with M5/M6, because the pair's convergence rule reads
 * `report_status`'s structured `verdict` (§3.3) and has no other channel: "the
 * engine never parses prose for a verdict." M4 closes the set with the two
 * §4.1's table reserves for an overseer:
 *
 * | Tool | Overseer | Worker |
 * |---|---|---|
 * | `list_roster` | ✔ | ✖ |
 * | `create_assignment` | ✔ | ✖ |
 * | `send_to_agent` | ✔ | ✔ (own assignment) |
 * | `read_mailbox` | ✔ | ✔ (own assignment) |
 * | `report_status` | ✔ | ✔ |
 * | `request_user_decision` | ✔ | ✔ |
 *
 * The split is enforced **twice, on purpose**: roster compiles allow rules for
 * exactly the names this instance mounts (roster §11), and the server built for a
 * worker launch does not construct the two overseer tools at all. Neither is
 * redundant — a rule is a statement about a tool that exists, and a tool absent
 * from an instance cannot be called even by a launch whose rules were composed
 * wrongly.
 *
 * **Who is an overseer is a question about the seat** (owner decision,
 * 2026-08-18; §3.5, §9-6). The two coordinator tools go to a launch that
 * declares `capabilities.overseer` **or** holds the lead seat of an `overseer`
 * assignment, because that seat's job is to create the children. Capabilities
 * rank candidates in the create dialog; they do not decide who may hold a seat.
 *
 * ## The caps are the breaker's teeth, not its bookkeeping
 *
 * §4.2's per-session caps — `messagesPerTurn`, `maxAssignmentsPerSession`,
 * `maxDecisionsPerSession` — refuse the call *and* trip §8.1's `tool_flood`,
 * "because a tool loop is exactly the runaway shape circuit breakers exist for".
 * The refusal is immediate and local; the halt is the engine's, reached through
 * {@link ToolsetOptions.onCapExceeded}, because §8.1 says `tool_flood` is the
 * one breaker that also stops the running session and only the engine may do
 * that (R6).
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
import { AssignmentRefusedError } from './errors.js';
import type { MailboxRepository } from './messages.js';
import { hasOverseerRoster, type RosterPort } from './ports.js';
import type { QuestionInbox } from './questions.js';
import { QUESTION_STRENGTHS } from './questions.js';
import type { AssignmentRepository } from './repository.js';
import { isReportState, type TurnRepository, type TurnReport, type TurnVerdict } from './turns.js';
import { ASSIGNMENT_ROLES, type AssignmentRole, type AssignmentService } from './types.js';

/** DESIGN §4.1: the record key roster mounts the toolset under. */
export const TOOLSET_SERVER_KEY = 'agentmanager';

/** R1b's worker grant: four, and none of them creates work or reveals the roster. */
export const WORKER_TOOL_NAMES = [
  'send_to_agent',
  'read_mailbox',
  'report_status',
  'request_user_decision',
] as const;

/** §4.1's overseer column — the worker four plus the coordinator's two. */
export const OVERSEER_TOOL_NAMES = [
  'list_roster',
  'create_assignment',
  ...WORKER_TOOL_NAMES,
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
  /** The caller's launch is not an overseer's — §4.1's table, enforced in the tool. */
  'not_an_overseer',
  /** §9's validator refused; the refusals ride in `detail`, named rule by rule. */
  'refused',
  /** A capability this build does not have (roster's projection, the service). */
  'unavailable',
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
  /**
   * The assignment service, for `create_assignment` (§4.3).
   *
   * Lazy and by reference for the same reason the inbox is: the toolset is built
   * after the service and the service holds the toolset factory. Going through
   * the service rather than the repository is the whole point of §9 — "every
   * proposal passes through the same `createAssignment` validator as a human's".
   */
  readonly service?: (() => AssignmentService | undefined) | undefined;
  /** Roster, for `list_roster` (§4.3). Resolved at call time, never at build. */
  readonly roster?: (() => RosterPort | undefined) | undefined;
  /**
   * §8.1's `tool_flood`: a per-session cap was exceeded.
   *
   * The refusal happens here; the halt and the `RunnerService.stop` are the
   * engine's, because it owns the assignment's phase and R6 makes stopping a
   * session its call rather than a tool's.
   */
  readonly onCapExceeded?: (
    launch: LaunchIdentity,
    cap: 'messagesPerTurn' | 'maxAssignmentsPerSession' | 'maxDecisionsPerSession',
  ) => void;
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

const LIST_ROSTER_SHAPE = {
  role: z.enum(ASSIGNMENT_ROLES as [AssignmentRole, ...AssignmentRole[]]).optional(),
  specialty: z.string().optional(),
  tag: z.string().optional(),
  availableOnly: z.boolean().optional(),
};

const CREATE_ASSIGNMENT_SHAPE = {
  pattern: z.enum(['solo', 'pair']),
  goal: z.string().min(1),
  members: z
    .array(
      z.object({
        agentId: z.string().min(1),
        role: z.enum(ASSIGNMENT_ROLES as [AssignmentRole, ...AssignmentRole[]]),
      }),
    )
    .min(1),
  scope: z
    .object({
      paths: z.array(z.string()).optional(),
      description: z.string().optional(),
      artifactPath: z.string().optional(),
    })
    .optional(),
  write: z.boolean().optional(),
  // §7.2: "**Any** assignment created by an overseer — required, non-null."
  // Typed as required here as well as refused by §9-8, so the model is told what
  // to send rather than being refused after guessing.
  tokenBudget: z.number().int().positive(),
  roundCap: z.number().int().positive().optional(),
  workItemIds: z.array(z.string()).optional(),
  autoStart: z.boolean().optional(),
};

// ---------------------------------------------------------------------------

export function createToolsetFactory(options: ToolsetOptions): ToolsetFactory {
  const { assignments, turns, mailbox, bus, config } = options;

  /**
   * §3.5, and the **owner decision of 2026-08-18**: the coordinator's two tools
   * are granted by the **seat**, not by a roster flag.
   *
   * Whoever holds the lead seat of an `overseer` assignment needs
   * `list_roster` and `create_assignment` — that seat's entire job is to
   * decompose a goal into child assignments, and a lead that cannot create one
   * is a lead in name only. `capabilities.overseer` remains what it now is
   * everywhere: a ranking hint for *suggesting* leads, never a gate on the
   * user's seating choice.
   *
   * Workers are untouched by this: a member of a child assignment, or a seat in
   * a pair, holds no lead seat of an overseer assignment and gets the four
   * (§4.1's table). Roster's compiled allow rules follow the mount, so the
   * grant and the mount cannot disagree.
   */
  function leadsAnOverseerAssignment(launch: LaunchIdentity): boolean {
    const row = assignments.get(launch.assignmentId);
    if (row === undefined || row.pattern !== 'overseer') return false;
    if (row.leadAgentId !== null) return row.leadAgentId === launch.agentId;
    // No lead recorded (a row from before the column was written): the seat
    // order the pattern fixed is the fallback, never "any member".
    const first = [...assignments.listMembers(launch.assignmentId)].sort(
      (a, b) => a.seatOrder - b.seatOrder,
    )[0];
    return first?.agentId === launch.agentId;
  }

  return function getSessionToolset(launch: LaunchIdentity): SessionToolset {
    // Per-launch counters — §4.2's caps. In-process on purpose: they bound one
    // *session*, and a session does not outlive the process that runs it.
    const used = { sends: 0, decisions: 0, creates: 0 };
    const overseer = launch.isOverseer === true || leadsAnOverseerAssignment(launch);

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

    /**
     * §4.2's `scopeOf(identity)`.
     *
     * ```
     * worker:   exactly its own assignment.
     * overseer: its own assignment + assignments whose parent is its own.
     * ```
     *
     * Recomputed per call rather than closed over: an overseer that creates a
     * child mid-turn must be able to read that child's mail on its next call,
     * and a set captured at launch would not contain it.
     */
    function scopeOf(): ReadonlySet<string> {
      if (!overseer) return new Set([launch.assignmentId]);
      return new Set([
        launch.assignmentId,
        ...assignments.listChildren(launch.assignmentId).map((child) => child.id),
      ]);
    }

    /** §4.1's table: the two coordinator tools refuse a worker launch by name. */
    function overseerOnly(tool: string): ToolResult | undefined {
      if (overseer) return undefined;
      return refuse(
        'not_an_overseer',
        `${tool} is an overseer's tool and this session was not launched as one. Report what you ` +
          'would have done and let the assignment’s lead act on it.',
      );
    }

    /**
     * §4.2's caps, in one place so every one of them both refuses *and* trips
     * §8.1's `tool_flood`.
     */
    function capped(
      cap: 'messagesPerTurn' | 'maxAssignmentsPerSession' | 'maxDecisionsPerSession',
      current: number,
      advice: string,
    ): ToolResult | undefined {
      const limit = config.breakers[cap];
      if (current < limit) return undefined;
      options.onCapExceeded?.(launch, cap);
      return refuse(
        'rate_limited',
        `This session has reached its cap of ${String(limit)} (orchestrator.breakers.${cap}). ` +
          advice,
        { cap, limit },
      );
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
      const flooded = capped(
        'messagesPerTurn',
        used.sends,
        'Say what remains in your report instead.',
      );
      if (flooded !== undefined) return flooded;

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

      // Scoped to `scopeOf(identity)` — for a worker exactly its own assignment,
      // for an overseer its own plus its children (§4.2). The identity is closed
      // over, so no argument can widen it.
      const scope = [...scopeOf()];
      const messages = scope
        .flatMap((assignmentId) =>
          mailbox.mailbox(launch.agentId, {
            assignmentId,
            unreadOnly: parsed.data.unreadOnly ?? true,
            ...(parsed.data.since === undefined ? {} : { since: parsed.data.since }),
          }),
        )
        // Oldest first across the whole scope, then the caller's own limit — a
        // per-assignment limit would silently starve the second mailbox.
        .sort((a, b) =>
          a.createdAt === b.createdAt
            ? a.id.localeCompare(b.id)
            : a.createdAt.localeCompare(b.createdAt),
        )
        .slice(0, parsed.data.limit ?? Number.MAX_SAFE_INTEGER);

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
          // Present only when it could be anything but the calling assignment,
          // so a worker's result shape is exactly §4.3's.
          ...(overseer ? { assignmentId: message.assignmentId } : {}),
        })),
        unreadRemaining: scope.reduce(
          (total, assignmentId) => total + mailbox.unreadCount(launch.agentId, assignmentId),
          0,
        ),
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
      const flooded = capped(
        'maxDecisionsPerSession',
        used.decisions,
        'Decide what you can and record the rest in your report.',
      );
      if (flooded !== undefined) return flooded;
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
          // The urgency rides on the card, because §10's `minLevel` reads it at
          // notification time — long after this call returned — to decide
          // whether a plain question is worth waking someone for.
          context: {
            toolName: 'mcp__agentmanager__request_user_decision',
            toolInput: { urgency: parsed.data.urgency ?? 'advisory' },
          },
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

    // -----------------------------------------------------------------------
    // list_roster (§4.3) — overseer only
    // -----------------------------------------------------------------------

    async function listRoster(args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
      await Promise.resolve();
      const wrongLaunch = overseerOnly('list_roster');
      if (wrongLaunch !== undefined) return wrongLaunch;
      const refused = guard();
      if (refused !== undefined) return refused;

      const parsed = z.object(LIST_ROSTER_SHAPE).safeParse(args);
      if (!parsed.success) {
        return refuse('invalid_arguments', parsed.error.issues.map((i) => i.message).join('; '));
      }

      const roster = options.roster?.();
      if (!hasOverseerRoster(roster)) {
        // Never fall back to the registry: it carries permissions, integrations
        // and secret refs, and §4.3 is explicit that this tool "never returns"
        // them. An honest refusal beats a projection built twice.
        return refuse(
          'unavailable',
          'The roster cannot be read on this build, so there is nobody to delegate to. Work the ' +
            'assignment you have.',
        );
      }

      const limit = config.assignment.maxConcurrentPerAgent;
      const availableOnly = parsed.data.availableOnly ?? true;
      const agents = roster
        .overseerRoster()
        .map((entry) => {
          const openAssignments = assignments.countOpenForAgent(entry.id);
          return {
            id: entry.id,
            name: entry.name,
            specialty: entry.specialty,
            tagline: entry.tagline,
            tags: entry.tags,
            roles: entry.capabilities.roles,
            overseer: entry.capabilities.overseer,
            openAssignments,
            available: openAssignments < limit,
          };
        })
        .filter((entry) => {
          if (parsed.data.role !== undefined && !entry.roles.includes(parsed.data.role))
            return false;
          if (parsed.data.specialty !== undefined && entry.specialty !== parsed.data.specialty) {
            return false;
          }
          if (parsed.data.tag !== undefined && !entry.tags.includes(parsed.data.tag)) return false;
          return !availableOnly || entry.available;
        });

      return ok({ agents });
    }

    // -----------------------------------------------------------------------
    // create_assignment (§4.3, §9) — overseer only
    // -----------------------------------------------------------------------

    async function createAssignment(args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
      const wrongLaunch = overseerOnly('create_assignment');
      if (wrongLaunch !== undefined) return wrongLaunch;
      const refused = guard();
      if (refused !== undefined) return refused;

      const parsed = z.object(CREATE_ASSIGNMENT_SHAPE).safeParse(args);
      if (!parsed.success) {
        return refuse('invalid_arguments', parsed.error.issues.map((i) => i.message).join('; '));
      }
      const flooded = capped(
        'maxAssignmentsPerSession',
        used.creates,
        'Finish or report on the work you have already created.',
      );
      if (flooded !== undefined) return flooded;

      const service = options.service?.();
      if (service === undefined) {
        return refuse('unavailable', 'This build cannot create assignments.');
      }
      const parent = assignments.get(launch.assignmentId);
      if (parent === undefined) {
        return refuse('assignment_out_of_scope', 'Your own assignment could not be read.');
      }

      used.creates += 1;
      try {
        const result = await service.createAssignment({
          // §9-2: the project is the caller's, never an argument. An overseer
          // cannot reach across projects, and the way to guarantee that is to
          // give it no way to say which project it means.
          projectId: parent.projectId,
          pattern: parsed.data.pattern,
          goal: parsed.data.goal,
          members: parsed.data.members.map((member) => ({
            agentId: member.agentId,
            role: member.role,
          })),
          ...(parsed.data.scope === undefined
            ? {}
            : {
                scope: {
                  paths: parsed.data.scope.paths ?? [],
                  ...(parsed.data.scope.description === undefined
                    ? {}
                    : { description: parsed.data.scope.description }),
                  ...(parsed.data.scope.artifactPath === undefined
                    ? {}
                    : { artifactPath: parsed.data.scope.artifactPath }),
                },
              }),
          write: parsed.data.write ?? false,
          tokenBudget: parsed.data.tokenBudget,
          ...(parsed.data.roundCap === undefined ? {} : { roundCap: parsed.data.roundCap }),
          ...(parsed.data.workItemIds === undefined
            ? {}
            : { workItemIds: parsed.data.workItemIds }),
          ...(parsed.data.autoStart === undefined ? {} : { autoStart: parsed.data.autoStart }),
          createdBy: `overseer:${launch.agentId}`,
          parentAssignmentId: launch.assignmentId,
        });

        return ok({
          assignmentId: result.assignmentId,
          status: result.status,
          phase: result.phase,
          warnings: result.warnings.map((warning) => warning.message),
          ...(result.gate === undefined
            ? {}
            : {
                gate: {
                  reason: result.gate.reason,
                  note:
                    'No session starts until a human approves this. Do not wait on it — report ' +
                    'what you have and end your turn.',
                },
              }),
        });
      } catch (error) {
        if (error instanceof AssignmentRefusedError) {
          // [A4]: "a structured refusal teaches the agent rather than crashing
          // the turn". Every §9 rule that fired is named, so one retry can fix
          // all of them rather than discovering them one at a time.
          return refuse(
            'refused',
            `The assignment was refused: ${error.refusals.map((one) => one.message).join(' ')}`,
            { refusals: error.refusals.map((one) => ({ code: one.code, message: one.message })) },
          );
        }
        return refuse(
          'refused',
          error instanceof Error ? error.message : 'The assignment could not be created.',
        );
      }
    }

    const handlers = new Map<
      string,
      (args: Readonly<Record<string, unknown>>) => Promise<ToolResult>
    >([
      ['report_status', reportStatus],
      ['send_to_agent', sendToAgent],
      ['read_mailbox', readMailbox],
      ['request_user_decision', requestUserDecision],
      ...(overseer
        ? ([
            ['list_roster', listRoster],
            ['create_assignment', createAssignment],
          ] as const)
        : []),
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
        // §4.1's table, enforced by construction: a worker's instance does not
        // contain these, so a mis-composed rule set still cannot reach them.
        ...(overseer
          ? [
              tool(
                'list_roster',
                'List the agents you could delegate to: names, specialties, tags, the roles they ' +
                  'declare, and how loaded they are. Never their credentials.',
                LIST_ROSTER_SHAPE,
                (args) => listRoster(args as Record<string, unknown>),
                { annotations: { readOnlyHint: true } },
              ),
              tool(
                'create_assignment',
                'Create a child assignment on your own project: a pattern, members in named ' +
                  'roles, a scope and a token budget taken from your remaining one. Every ' +
                  'proposal passes the same rules a human’s does, and a write-capable one waits ' +
                  'for a human to approve it.',
                CREATE_ASSIGNMENT_SHAPE,
                (args) => createAssignment(args as Record<string, unknown>),
              ),
            ]
          : []),
      ],
    });

    const exposed: readonly string[] = overseer ? [...OVERSEER_TOOL_NAMES] : [...WORKER_TOOL_NAMES];

    return {
      server,
      toolNames: exposed,
      call(name, args) {
        const handler = handlers.get(name);
        if (handler === undefined) {
          // A worker naming an overseer tool is told *why* rather than that it
          // does not exist: §4.2's whole argument is that an agent which learns
          // the rule stops retrying.
          if ((OVERSEER_TOOL_NAMES as readonly string[]).includes(name)) {
            return Promise.resolve(refuse('not_an_overseer', `${name} is an overseer's tool.`));
          }
          return Promise.resolve(
            refuse(
              'invalid_arguments',
              `There is no ${name} tool in this build. Available: ${exposed.join(', ')}.`,
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
