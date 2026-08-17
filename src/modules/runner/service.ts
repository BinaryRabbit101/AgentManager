/**
 * `RunnerService` — the in-process face of runner DESIGN §11.2, as far as M1–M10
 * take it.
 *
 * §11.2's full interface also carries `usageWindows`, which needs the rolling
 * `usage_events` sums of M11 and is **absent rather than stubbed**: a method
 * that resolves without doing anything is a contract another element can build
 * against and then discover is a lie.
 *
 * ## Why `stop` and `continueFrom` landing here change something elsewhere
 *
 * Orchestrator's `hasLauncher()` probes for `startSession` **and** `stop`
 * together, and `hasContinuation()` probes for `continueFrom` (orchestrator
 * `ports.ts`). The first turned `POST /api/assignments/solo` from a
 * `503 runner_unavailable` into a real launch; the second is M9's, and it is
 * what makes a seat's second turn resume its own prior conversation instead of
 * starting a stranger — "not an optimisation detail" (orchestrator §3.2), and
 * asserted end to end from orchestrator's side.
 */
import type { SessionStatus } from '../../storage/index.js';

import { LaunchUnavailableError } from './errors.js';
import type {
  ContinueOptions,
  LaunchChain,
  SessionControlResult,
  StartSessionRequest,
  StartSessionResult,
  SteerOptions,
  SteerResult,
} from './launch.js';
import type { Recovery } from './recovery.js';
import type { ExitReason } from './status.js';
import { bandRank, type QueueEntry, type QueueState } from './scheduler.js';
import { TERMINAL_STATUSES } from './status.js';
import type { ListSessionsQuery, RunnerSessionRecord, SessionRepository } from './repository.js';
import type { ReadForwardOptions, TranscriptPage, TranscriptReader } from './transcriptReader.js';
import type { SessionUsageTotals, UsageRepository } from './usage.js';

export type {
  ContinueOptions,
  SessionControlResult,
  StartSessionRequest,
  StartSessionResult,
  SteerResult,
};

/** What `GET /api/sessions/:id` answers with (§11.1: "record + usage + queue position"). */
export interface SessionDetail {
  readonly session: RunnerSessionRecord;
  /**
   * The `session_usage` rollup, or `null` for a session that has spent nothing.
   *
   * `costUsdEstimate` carries §7.3's rule in its name: `total_cost_usd` is a
   * client-side estimate from a price table bundled into the SDK, and under
   * subscription auth it corresponds to no dollar charge at all. Nothing may
   * render it as spend.
   */
  readonly usage: SessionUsageTotals | null;
  /** Position in the admission order; `null` once the session has started. */
  readonly queuePosition: number | null;
  /** §11.1's "resume affordances", computed from §9.3's honest answer. */
  readonly affordances: SessionAffordances;
}

/**
 * Which of §11.1's controls this session actually supports (§9.3, §11.1).
 *
 * The list is computed rather than inferred by the client, because §9.3's three
 * "not resumable" cases — no `sdk_session_id`, a workspace that is gone, a
 * deleted SDK session file — are all facts only the server can check, and a
 * Continue button that leads to a fresh conversation the user thought was a
 * resumption is worse than no button.
 */
export interface SessionAffordances {
  readonly canSteer: boolean;
  readonly canPause: boolean;
  /** §9.4 path 1 — the same row. Only ever true for a `paused` session. */
  readonly canResume: boolean;
  /** §9.4 path 2 — a new row with `resumed_from`, replaying the conversation. */
  readonly canContinue: boolean;
  /** A finished session whose conversation is gone: start again, from nothing. */
  readonly canRelaunch: boolean;
  readonly canStop: boolean;
  /** §9.3's answer, and why, for the tooltip next to a missing Continue. */
  readonly resumable: boolean;
  readonly notResumable?: string | undefined;
  readonly notResumableReason?: string | undefined;
}

export interface RunnerService {
  /**
   * §3.1's launch chain, from admission to `running` (M3).
   *
   * Refuses before any row exists when the assignment is closed or missing, the
   * agent is unknown or archived, the project is not `active`, or the queue is
   * full (§3.1 step 0, §6.2). Everything after that is asynchronous: the
   * returned `sessionId` is a `queued` row whose progress arrives as events and
   * transcript lines.
   */
  startSession(request: StartSessionRequest): Promise<StartSessionResult>;
  /**
   * Resolves when a session reaches a status it will not leave on its own.
   *
   * Not in §11.2's pinned list — it is the programmatic seam that makes "launch
   * a session and inspect what happened" a single `await` for a test, for the
   * M3 checkpoint demo, and for a caller that genuinely wants to block. The
   * launch path does not depend on anyone calling it.
   */
  awaitSettled(sessionId: string): Promise<RunnerSessionRecord>;
  /**
   * §4.3: deliver a message into a running session, optionally superseding the
   * turn in flight. A non-`running` session is a typed 409 — the one control
   * verb that is deliberately **not** idempotent, because a steer that silently
   * went nowhere is a message the user believes landed.
   *
   * Returns more than §11.2's `Promise<void>`: SDK-NOTES **G4**'s `still_queued`
   * receipt is a fact no other call can surface.
   */
  steer(sessionId: string, text: string, options?: SteerOptions): Promise<SteerResult>;
  /**
   * §2.2's `running → paused`: `interrupt()` + `close()`, the slot released, the
   * workspace lease kept, `sdk_session_id` already recorded. Idempotent.
   */
  pause(sessionId: string, reason?: ExitReason): Promise<SessionControlResult>;
  /** §9.4 path 1: the same row, the same transcript, `resume`. Idempotent. */
  resume(sessionId: string): Promise<SessionControlResult>;
  /**
   * §9.4 path 2 — Continue: a **new** session row with `resumed_from`, a new
   * transcript, and a first message stating what happened to the session it
   * continues.
   *
   * Orchestrator's `hasContinuation()` probes for exactly this method, and uses
   * it for every seat turn after the first so the skeptic keeps the memory of
   * its own prior critique (orchestrator §3.2). `prompt` is what the caller
   * wants said next; the interruption statement is prepended by runner, because
   * only runner can read the transcript that says what was in flight (§9.3).
   */
  continueFrom(
    sessionId: string,
    prompt?: string,
    options?: ContinueOptions,
  ): Promise<StartSessionResult>;
  /**
   * Stop, from any live status: `interrupted` / `user_stopped` for a running or
   * paused session, `user_cancelled` for one that never started. Idempotent, and
   * it leaves no subprocess behind (§9.1).
   *
   * Orchestrator calls this on the sessions of an assignment it is closing
   * (orchestrator R6); the reason it passes is recorded, never interpreted.
   */
  stop(sessionId: string, reason?: string): Promise<SessionControlResult>;
  /** `POST /api/sessions/:id/pin` — projects' retention exemption (§11.1). */
  setPinned(sessionId: string, pinned: boolean): SessionControlResult;
  /** The session row, §3.5's columns included. */
  getSession(sessionId: string): Promise<RunnerSessionRecord | undefined>;
  /** §11.1's `GET /api/sessions/:id`: the record, its usage, its queue position. */
  getSessionDetail(sessionId: string): Promise<SessionDetail | undefined>;
  /** §11.2's `queueState()` — the five numbers the queue panel renders. */
  queueState(): QueueState;
  /** The queue panel's rows (`GET /api/runner/queue`). */
  queueEntries(): readonly QueueEntry[];
  /**
   * `PUT /api/runner/capacity` (§6.1): the runtime cap, clamped to 1..8 and
   * written to foundation's `settings` rather than to config, which is immutable
   * per process. Returns the value actually stored.
   *
   * Not in §11.2's pinned list — that list predates the route, and a route that
   * had to reach past the service to the launch chain would make the service
   * decorative.
   */
  setCapacity(maxConcurrent: number): number;
  /**
   * The last `maxBytes` of a transcript, whole JSONL lines only (§11.2).
   *
   * Byte-identical to `GET /api/sessions/:id/transcript?tail=<maxBytes>` because
   * it is the same reader. Orchestrator's post-restart recovery path calls this
   * rather than making an HTTP call into its own process. Read-only.
   */
  getTranscriptTail(sessionId: string, options?: { maxBytes?: number }): Promise<TranscriptPage>;
  /** The forward, offset-paged face of the same reader (§11.1). */
  readTranscript(sessionId: string, options?: ReadForwardOptions): Promise<TranscriptPage>;
  /** Sessions in a non-terminal status: `queued`, `running` or `paused`. */
  listActive(): readonly RunnerSessionRecord[];
  /** §11.1's `GET /api/sessions` listing, newest first. */
  listSessions(query?: ListSessionsQuery): readonly RunnerSessionRecord[];
}

export interface RunnerServiceOptions {
  readonly sessions: SessionRepository;
  readonly usage: UsageRepository;
  readonly transcripts: TranscriptReader;
  /**
   * M3's launch chain.
   *
   * Optional so a caller that only reads sessions and transcripts — the M1/M2
   * harness, and any consumer that predates the launch path — can build the
   * service without wiring roster, projects and the SDK. Calling
   * {@link RunnerService.startSession} without it is a typed refusal, not a
   * crash.
   */
  readonly launch?: LaunchChain | undefined;
  /**
   * M9's §9.3 reader, for `GET /api/sessions/:id`'s resume affordances.
   *
   * Absent, every finished session reports `resumable` from its
   * `sdk_session_id` alone — the one check that needs no filesystem — which is
   * the honest degradation for a build that has not wired recovery.
   */
  readonly recovery?: Pick<Recovery, 'resumability'> | undefined;
}

const ACTIVE_STATUSES: readonly SessionStatus[] = ['queued', 'running', 'paused'];

export function createRunnerService(options: RunnerServiceOptions): RunnerService {
  const { sessions, transcripts, usage } = options;

  function launchChain(): LaunchChain {
    if (options.launch === undefined) {
      throw new LaunchUnavailableError();
    }
    return options.launch;
  }

  /** How many admissible sessions are ahead of this one (§6.2's ordering). */
  function queuePosition(session: RunnerSessionRecord): number | null {
    if (session.status !== 'queued') return null;
    return (
      sessions.list({ status: 'queued' }).filter((other) => {
        if (other.id === session.id) return false;
        const band = bandRank(other.priority) - bandRank(session.priority);
        if (band !== 0) return band < 0;
        return (other.queuedAt ?? '') <= (session.queuedAt ?? '');
      }).length + 1
    );
  }

  /** §9.3 + §11.1: which controls this row actually supports, and why not. */
  function affordancesFor(session: RunnerSessionRecord): SessionAffordances {
    const terminal = TERMINAL_STATUSES.has(session.status);
    const state = terminal
      ? (options.recovery?.resumability(session) ?? {
          resumable: session.sdkSessionId !== null,
        })
      : { resumable: session.sdkSessionId !== null };
    return {
      canSteer: session.status === 'running',
      canPause: session.status === 'running',
      canResume: session.status === 'paused' && session.sdkSessionId !== null,
      // §9.3: "the UI offers *Relaunch*, not *Resume*" for a session with no
      // conversation to replay — so Continue is offered only when there is one.
      canContinue: terminal && state.resumable,
      canRelaunch: terminal && !state.resumable,
      canStop: !terminal,
      resumable: state.resumable,
      ...('code' in state && state.code !== undefined ? { notResumable: state.code } : {}),
      ...('reason' in state && state.reason !== undefined
        ? { notResumableReason: state.reason }
        : {}),
    };
  }

  return {
    startSession: (request) => Promise.resolve().then(() => launchChain().startSession(request)),

    continueFrom: (sessionId, prompt, continueOptions) =>
      Promise.resolve().then(() => launchChain().continueFrom(sessionId, prompt, continueOptions)),

    awaitSettled: (sessionId) =>
      Promise.resolve().then(() => launchChain().awaitSettled(sessionId)),

    steer: (sessionId, text, steerOptions) =>
      Promise.resolve().then(() => launchChain().steer(sessionId, text, steerOptions)),
    pause: (sessionId, reason) =>
      Promise.resolve().then(() => launchChain().pause(sessionId, reason)),
    resume: (sessionId) => Promise.resolve().then(() => launchChain().resume(sessionId)),
    stop: (sessionId, reason) =>
      Promise.resolve().then(() => launchChain().stop(sessionId, reason)),
    setPinned: (sessionId, pinned) => launchChain().setPinned(sessionId, pinned),

    getSession: (sessionId) => Promise.resolve(sessions.get(sessionId)),

    getSessionDetail: (sessionId) =>
      Promise.resolve().then(() => {
        const session = sessions.get(sessionId);
        if (session === undefined) return undefined;
        return {
          session,
          usage: usage.totals(sessionId) ?? null,
          queuePosition: queuePosition(session),
          affordances: affordancesFor(session),
        };
      }),

    queueState: () => launchChain().queueState(),
    queueEntries: () => launchChain().queueEntries(),
    setCapacity: (maxConcurrent) => launchChain().setCapacity(maxConcurrent),

    getTranscriptTail: (sessionId, tail = {}) =>
      Promise.resolve(
        transcripts.tail(sessionId, tail.maxBytes === undefined ? {} : { maxBytes: tail.maxBytes }),
      ),

    readTranscript: (sessionId, forward = {}) =>
      Promise.resolve(transcripts.read(sessionId, forward)),

    listActive: () =>
      ACTIVE_STATUSES.flatMap((status) => sessions.list({ status })).filter(
        (session) => !TERMINAL_STATUSES.has(session.status),
      ),

    listSessions: (query = {}) => sessions.list(query),
  };
}
