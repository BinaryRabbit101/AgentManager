/**
 * `RunnerService` — the in-process face of runner DESIGN §11.2, as far as M1,
 * M2 and M3 take it.
 *
 * §11.2's full interface also carries `steer`, `pause`, `resume`,
 * `continueFrom`, `stop`, `queueState` and `usageWindows`. Those need session
 * control (M6), the scheduler (M5) and metering (M4), and are **absent rather
 * than stubbed**: a method that resolves without doing anything is a contract
 * another element can build against and then discover is a lie.
 *
 * What is here is exactly what M1–M3 make true — the launch path, the session
 * record, and the two transcript reads that §11.1 and §11.2 insist are one
 * reader.
 */
import type { SessionStatus } from '../../storage/index.js';

import { LaunchUnavailableError } from './errors.js';
import type { LaunchChain, StartSessionRequest, StartSessionResult } from './launch.js';
import { TERMINAL_STATUSES } from './status.js';
import type { RunnerSessionRecord, SessionRepository } from './repository.js';
import type { ReadForwardOptions, TranscriptPage, TranscriptReader } from './transcriptReader.js';

export type { StartSessionRequest, StartSessionResult };

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
  /** The session row, §3.5's columns included. */
  getSession(sessionId: string): Promise<RunnerSessionRecord | undefined>;
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
  const { sessions, transcripts } = options;

  function launchChain(): LaunchChain {
    if (options.launch === undefined) {
      throw new LaunchUnavailableError();
    }
    return options.launch;
  }

  return {
    startSession: (request) => Promise.resolve().then(() => launchChain().startSession(request)),

    awaitSettled: (sessionId) =>
      Promise.resolve().then(() => launchChain().awaitSettled(sessionId)),

    getSession: (sessionId) => Promise.resolve(sessions.get(sessionId)),

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
