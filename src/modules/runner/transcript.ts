/**
 * The transcript writer (runner DESIGN §8).
 *
 * One append-only JSONL stream per session at foundation §1.5's layout,
 * `state/transcripts/<YYYY>/<MM>/<session-id>.jsonl`, "unchanged and
 * unextended". Foundation already owns the file handle, the fsync cadence and
 * `sessions.transcript_bytes`; this adds the four things §8 asks for on top of
 * it and nothing else:
 *
 * 1. **The line vocabulary and a monotonic `seq`** (§8.1). `seq` is per session,
 *    not per writer, so a pause/resume that reuses the same file continues the
 *    numbering rather than restarting it — the resumed writer reads the last
 *    line of the existing file to find where it left off.
 * 2. **Redaction on every line** (§8.2, foundation §3.5): "agent output can echo
 *    an environment variable". The scrubber runs over the whole entry before it
 *    is serialised, so a token in a nested tool result is caught as surely as
 *    one in a top-level field.
 * 3. **The `maxMb` cap** (§8.2). On reaching it the writer appends exactly one
 *    `error` line with `code: transcript_cap`, stops appending, and lets the
 *    session run on. "A single runaway session must not be able to fill the
 *    disk, and losing the tail of one transcript is a better outcome than losing
 *    the machine."
 * 4. **`fs.stat` reconciliation** (§8.2) for the file whose session did not
 *    close cleanly, because the last flush may have lagged the crash.
 *
 * ## `transcript_bytes`: once per append, not once per flush
 *
 * §8.2 says the column is updated "once per flush, not once per line".
 * Foundation §1.5 decided the opposite for the writer it ships — "a value that
 * is only right after a flush is a value every reader has to second-guess" —
 * and it is foundation's writer that owns the file descriptor. Runner consumes
 * that decision rather than re-implementing the writer to weaken it: the
 * per-append update is a strict superset of what §8.2 asks for (the column is
 * exact after every flush *and* between flushes), and §8.2's actual requirement
 * — that a failed update is an error rather than a warning, because an
 * unmaintained column silently disables projects' retention — is foundation's
 * behaviour already (`setTranscriptBytes` throws when the row is gone). Raised
 * in the milestone report rather than silently diverged from.
 */
import { statSync } from 'node:fs';

import { redactValue } from '../../logging/index.js';
import type {
  Clock,
  SessionsRepository,
  TranscriptStore,
  TranscriptWriter,
} from '../../storage/index.js';

import { SessionNotFoundError } from './errors.js';

/**
 * §8.1's line vocabulary.
 *
 * `tool_use` / `tool_result` are **derived by runner from assistant and user
 * content blocks** — SDK-NOTES G2: the SDK has no message types by those names,
 * they are content blocks, with the structured twin on
 * `SDKUserMessage.tool_use_result`. The vocabulary is the transcript's, not the
 * SDK's.
 */
export const TRANSCRIPT_LINE_TYPES = [
  'session.start',
  'system',
  'user',
  'assistant',
  'tool_use',
  'tool_result',
  'question',
  'answer',
  'steer',
  'usage',
  'error',
  'session.end',
] as const;

export type TranscriptLineType = (typeof TRANSCRIPT_LINE_TYPES)[number];

/** One line as it is written and as the reader parses it back. */
export interface TranscriptLine {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly [field: string]: unknown;
}

/** What {@link SessionTranscript.append} takes: everything but `seq` and `ts`. */
export type TranscriptEntryBody = Readonly<Record<string, unknown>>;

export interface SessionTranscript {
  readonly sessionId: string;
  /** As stored in `sessions.transcript_path`, relative to the transcripts root. */
  readonly relativePath: string;
  /** The absolute file. */
  readonly path: string;
  /** The `seq` the next appended line will carry. */
  nextSeq(): number;
  /** Bytes on disk — equal to the file's size and to `sessions.transcript_bytes`. */
  bytes(): number;
  /** True once §8.2's cap has been hit and appending has stopped. */
  capped(): boolean;
  /** Appends one line. A no-op once capped. Returns the `seq` written, or `undefined`. */
  append(type: TranscriptLineType, body?: TranscriptEntryBody): number | undefined;
  flush(): void;
  /** Flushes, reconciles the byte count from `fs.stat`, and releases the handle. */
  close(): void;
}

export interface OpenTranscriptOptions {
  /** §12's `runner.transcript.flushLines`. */
  readonly flushLines: number;
  /** §12's `runner.transcript.flushMs`. */
  readonly flushMs: number;
  /** §12's `runner.transcript.maxMb`. */
  readonly maxMb: number;
  /** The instant deciding a brand-new transcript's `<YYYY>/<MM>` folders. */
  readonly at?: Date;
}

export interface TranscriptFactoryOptions {
  readonly transcripts: TranscriptStore;
  readonly sessions: SessionsRepository;
  readonly clock: Clock;
  readonly log?: (
    level: 'debug' | 'warn',
    message: string,
    detail?: Record<string, unknown>,
  ) => void;
}

export interface TranscriptFactory {
  /** Opens (creating) the transcript for a session, continuing its `seq`. */
  open(sessionId: string, options: OpenTranscriptOptions): SessionTranscript;
  /**
   * §8.2's "on boot for any file whose session did not close cleanly,
   * `transcript_bytes` is reconciled from `fs.stat`".
   *
   * Returns the reconciled size, or `undefined` when the row names no file or
   * the file is gone — both of which are the pruned case, not an error.
   */
  reconcileBytes(sessionId: string): number | undefined;
}

export function createTranscriptFactory(options: TranscriptFactoryOptions): TranscriptFactory {
  const { transcripts, sessions, clock } = options;
  const log = options.log ?? ((): void => {});

  return {
    open(sessionId, open) {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new SessionNotFoundError(sessionId);

      const writer: TranscriptWriter = transcripts.open(sessionId, {
        fsyncEveryLines: open.flushLines,
        fsyncIntervalMs: open.flushMs,
        ...(open.at === undefined ? {} : { at: open.at }),
      });

      const capBytes = Math.floor(open.maxMb * 1024 * 1024);
      // The resumed writer's whole job in one line: pick up the numbering the
      // file already carries. A fresh file answers 0, so the first line is 1.
      let seq = lastSeqOf(transcripts, sessionId) ?? 0;
      let capped = writer.bytes() >= capBytes;
      let closed = false;

      function write(type: string, body: TranscriptEntryBody): number {
        seq += 1;
        const entry = {
          seq,
          ts: clock().toISOString(),
          type,
          // Redaction is over the *body*, so the three stamped fields cannot be
          // mangled by a scrubber that does not know they are ours.
          ...(redactValue(body) as Record<string, unknown>),
        };
        writer.append(entry);
        return seq;
      }

      return {
        sessionId,
        relativePath: writer.relativePath,
        path: writer.path,
        nextSeq: () => seq + 1,
        bytes: () => writer.bytes(),
        capped: () => capped,

        append(type, body = {}) {
          if (closed) throw new Error(`Transcript for session ${sessionId} is closed`);
          if (capped) return undefined;

          const written = write(type, body);
          if (writer.bytes() >= capBytes) {
            capped = true;
            // Exactly one cap line, written *after* the line that crossed the
            // threshold so the transcript never ends mid-record, and written
            // through the same path so it is redacted and sequenced like any
            // other.
            write('error', {
              code: 'transcript_cap',
              stage: 'transcript',
              message:
                `This transcript reached its ${String(open.maxMb)} MB cap and stopped recording. ` +
                'The session continues to run and to meter.',
              bytes: writer.bytes(),
            });
            writer.flush();
            log('warn', 'transcript cap reached; appending stopped', {
              sessionId,
              maxMb: open.maxMb,
            });
          }
          return written;
        },

        flush: () => writer.flush(),

        close() {
          if (closed) return;
          closed = true;
          writer.close();
          // The clean-close half of §8.2's reconciliation. The crash half is
          // `reconcileBytes`, called by the boot task.
          reconcile(transcripts, sessions, sessionId);
        },
      };
    },

    reconcileBytes: (sessionId) => reconcile(transcripts, sessions, sessionId),
  };
}

/** `fs.stat` → `sessions.transcript_bytes`. The pruned cases answer `undefined`. */
function reconcile(
  transcripts: TranscriptStore,
  sessions: SessionsRepository,
  sessionId: string,
): number | undefined {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new SessionNotFoundError(sessionId);
  if (session.transcriptPath === null) return undefined;

  let size: number;
  try {
    size = statSync(transcripts.absolutePath(session.transcriptPath)).size;
  } catch {
    return undefined;
  }
  if (size !== session.transcriptBytes) sessions.setTranscriptBytes(sessionId, size);
  return size;
}

/**
 * The `seq` of the last line already in a session's transcript, or `undefined`
 * for a file that has none.
 *
 * `seq` is monotonic per session, so the last parsable line carries the maximum
 * and one bounded read from the end answers the question — the file is never
 * scanned.
 */
export function lastSeqOf(transcripts: TranscriptStore, sessionId: string): number | undefined {
  const session = readSessionSize(transcripts, sessionId);
  if (session === undefined) return undefined;

  // 64 KB is comfortably more than any single line and is one read.
  const window = 65_536;
  for (let back = window; ; back *= 8) {
    const from = Math.max(0, session.size - back);
    const page = transcripts.tail(sessionId, { from, maxBytes: session.size - from });
    if (page.status !== 'ok') return undefined;
    for (let i = page.lines.length - 1; i >= 0; i -= 1) {
      const line = page.lines[i];
      if (line === undefined) continue;
      const seq = seqOf(line);
      if (seq !== undefined) return seq;
    }
    if (from === 0) return undefined;
  }
}

function seqOf(line: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const seq = (parsed as Record<string, unknown>)['seq'];
    return typeof seq === 'number' && Number.isFinite(seq) ? seq : undefined;
  } catch {
    return undefined;
  }
}

function readSessionSize(
  transcripts: TranscriptStore,
  sessionId: string,
): { readonly size: number } | undefined {
  const page = transcripts.tail(sessionId, { maxBytes: 0 });
  if (page.status !== 'ok') return undefined;
  return page.size === 0 ? undefined : { size: page.size };
}
