/**
 * `RunnerService` — the in-process face of runner DESIGN §11.2, as far as M1–M6
 * take it.
 *
 * §11.2's full interface also carries `continueFrom` and `usageWindows`. Those
 * need crash recovery (M9) and usage windows (M11), and are **absent rather than
 * stubbed**: a method that resolves without doing anything is a contract another
 * element can build against and then discover is a lie.
 *
 * ## Why `stop` landing here changes something elsewhere
 *
 * Orchestrator's `hasLauncher()` probes for `startSession` **and** `stop`
 * together (orchestrator `ports.ts`), so this milestone is the one that turns
 * `POST /api/assignments/solo` from a `503 runner_unavailable` into a real
 * launch, and turns `closeAssignment` into something that actually stops the
 * sessions it closes. That is asserted end to end from orchestrator's side.
 */
import type { SessionStatus } from '../../storage/index.js';

import { LaunchUnavailableError } from './errors.js';
import type {
  LaunchChain,
  SessionControlResult,
  StartSessionRequest,
  StartSessionResult,
  SteerOptions,
  SteerResult,
} from './launch.js';
import type { ExitReason } from './status.js';
import { bandRank, type QueueEntry, type QueueState } from './scheduler.js';
import { TERMINAL_STATUSES } from './status.js';
import type { RunnerSessionRecord, SessionRepository } from './repository.js';
import type { ReadForwardOptions, TranscriptPage, TranscriptReader } from './transcriptReader.js';
import type { SessionUsageTotals, UsageRepository } from './usage.js';

export type { SessionControlResult, StartSessionRequest, StartSessionResult, SteerResult };

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

  return {
    startSession: (request) => Promise.resolve().then(() => launchChain().startSession(request)),

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
  };
}
