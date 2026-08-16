/**
 * `RunnerService` — the in-process face of runner DESIGN §11.2, as far as M1
 * and M2 take it.
 *
 * §11.2's full interface also carries `startSession`, `steer`, `pause`,
 * `resume`, `continueFrom`, `stop`, `queueState` and `usageWindows`. Those need
 * the launch chain (M3), the scheduler (M5) and session control (M6), and are
 * **absent rather than stubbed**: a method that resolves without doing anything
 * is a contract another element can build against and then discover is a lie.
 *
 * What is here is exactly what M1 and M2 make true — the session record, and
 * the two transcript reads that §11.1 and §11.2 insist are one reader.
 */
import type { SessionStatus } from '../../storage/index.js';

import { TERMINAL_STATUSES } from './status.js';
import type { RunnerSessionRecord, SessionRepository } from './repository.js';
import type { ReadForwardOptions, TranscriptPage, TranscriptReader } from './transcriptReader.js';

export interface RunnerService {
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
}

const ACTIVE_STATUSES: readonly SessionStatus[] = ['queued', 'running', 'paused'];

export function createRunnerService(options: RunnerServiceOptions): RunnerService {
  const { sessions, transcripts } = options;

  return {
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
