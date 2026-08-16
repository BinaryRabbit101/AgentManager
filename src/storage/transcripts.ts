/**
 * Session transcripts: the layout, the append-only writer, and the tailing
 * reader (DESIGN §1.5).
 *
 * "One JSONL file per session, path
 * `state/transcripts/<YYYY>/<MM>/<session-id>.jsonl`, recorded in
 * `sessions.transcript_path`. **This layout is the single authority** — no
 * element addresses transcripts by any other scheme, and none derives a path
 * from a project slug or any other renameable thing."
 *
 * Three decisions that the design implies but does not spell out:
 *
 * 1. **The stored path is relative to the transcripts root**, not absolute. The
 *    root itself is relocatable (`dataRoot`, §1.2), and a column full of
 *    absolute paths turns "move the data root" into a database rewrite.
 *    {@link TranscriptStore.absolutePath} is the only thing that joins the two.
 * 2. **Bytes are written immediately; only the fsync is batched.** A reader
 *    tailing a live session must see the line the moment it is produced, so
 *    buffering the write itself would defeat the feature the byte offset exists
 *    for. The "fsync every N lines or 2 s" policy is about durability, which is
 *    the thing that can be traded, not visibility.
 * 3. **`sessions.transcript_bytes` is updated on every append**, not on flush.
 *    §1.5 makes it the column elements SUM instead of walking the tree, and a
 *    value that is only right after a flush is a value every reader has to
 *    second-guess. One indexed UPDATE by primary key is cheap enough that
 *    correctness is the better trade.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { RecordNotFoundError } from './errors.js';
import { silentLog, type LogFn } from './log.js';
import type { SessionsRepository } from './repositories/sessions.js';
import { isoTimestamp, systemClock, type Clock } from './time.js';

/** The extension every transcript carries. One line of JSON per SDK event. */
export const TRANSCRIPT_EXTENSION = '.jsonl';

/** Default fsync cadence (§1.5: "an fsync every N lines or 2 s, whichever first"). */
export const DEFAULT_FSYNC_EVERY_LINES = 50;
export const DEFAULT_FSYNC_INTERVAL_MS = 2000;

/**
 * The `<YYYY>/<MM>/<session-id>.jsonl` layout, relative to the transcripts
 * root. **The single authority of §1.5.**
 *
 * Forward slashes, deliberately: the value is stored in a database column and
 * served over an API, and `resolve` accepts them on Windows anyway. The
 * `<YYYY>/<MM>` split exists only to keep directory sizes sane — nothing may
 * infer the session's date from it, because a resumed session keeps the path it
 * was first given even across a month boundary.
 */
export function transcriptRelativePath(sessionId: string, at: Date = systemClock()): string {
  const year = at.getUTCFullYear().toString().padStart(4, '0');
  const month = (at.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${year}/${month}/${sessionId}${TRANSCRIPT_EXTENSION}`;
}

/** One appended line, before the writer stamps it. */
export type TranscriptEntry = Record<string, unknown>;

export interface TranscriptWriterOptions {
  /** Flush after this many lines. Default {@link DEFAULT_FSYNC_EVERY_LINES}. */
  readonly fsyncEveryLines?: number;
  /** Flush at most this long after the first unflushed line. Default 2000 ms. */
  readonly fsyncIntervalMs?: number;
  /** The instant used for the `<YYYY>/<MM>` folders of a brand-new transcript. */
  readonly at?: Date;
}

export interface TranscriptWriter {
  readonly sessionId: string;
  /** As stored in `sessions.transcript_path`. */
  readonly relativePath: string;
  /** The file on disk. */
  readonly path: string;
  /** Bytes written so far — always equal to the file's size and to the row's column. */
  bytes(): number;
  /** Lines appended by this writer instance (not the file's total). */
  linesWritten(): number;
  /** Appends one JSONL line. `ts` is stamped when the entry does not carry one. */
  append(entry: TranscriptEntry): void;
  /** Appends several lines with one write and one byte-count update. */
  appendMany(entries: readonly TranscriptEntry[]): void;
  /** fsyncs now and cancels any pending timer. */
  flush(): void;
  /** Flushes and releases the file descriptor. Idempotent. */
  close(): void;
}

/** Why a transcript could not be read. Both mean "pruned" to a caller. */
export type TranscriptPrunedReason =
  /** `sessions.transcript_path` is NULL — the pruner cleared it (§1.5). */
  | 'path-cleared'
  /** The row still names a file that is no longer on disk. */
  | 'file-missing';

export interface TranscriptTailOk {
  readonly status: 'ok';
  readonly sessionId: string;
  readonly relativePath: string;
  /** The offset the read started at. */
  readonly from: number;
  /**
   * Where to resume. Always just past the last complete line returned, so a
   * caller that keeps passing it back never sees half a JSON object.
   */
  readonly nextOffset: number;
  /** The file's size at the moment of the read. */
  readonly size: number;
  /** Complete lines only, without their trailing newline. */
  readonly lines: readonly string[];
}

export interface TranscriptTailPruned {
  readonly status: 'pruned';
  readonly sessionId: string;
  readonly reason: TranscriptPrunedReason;
}

/**
 * A tail result. A missing transcript is a **value**, not an exception (§1.5:
 * transcripts are "safe to delete out from under the DB… → UI shows 'transcript
 * pruned'"), because pruning is a normal outcome of retention and a caller must
 * render it rather than handle it.
 */
export type TranscriptTail = TranscriptTailOk | TranscriptTailPruned;

export interface TranscriptTailOptions {
  /** Byte offset to read from. Default 0. */
  readonly from?: number;
  /** Cap on bytes read in one call. Default: to the end of the file. */
  readonly maxBytes?: number;
}

export interface TranscriptStore {
  /** The transcripts root — `<dataRoot>/state/transcripts`. */
  readonly root: string;
  /** @see transcriptRelativePath */
  relativePathFor(sessionId: string, at?: Date): string;
  /** Joins a stored relative path onto the root. The only place the two meet. */
  absolutePath(relativePath: string): string;
  /**
   * Opens (creating) the transcript for a session.
   *
   * Reuses the path already in `sessions.transcript_path` when there is one, so
   * a writer restarted in a different month appends to the original file rather
   * than starting a second one. The byte count is initialised from the file's
   * actual size, which is what keeps `transcript_bytes` correct across a
   * restart.
   */
  open(sessionId: string, options?: TranscriptWriterOptions): TranscriptWriter;
  /** Reads complete lines from a byte offset. @see TranscriptTail */
  tail(sessionId: string, options?: TranscriptTailOptions): TranscriptTail;
  /**
   * Deletes the file and clears the row — §1.5's "the pruner that deletes a
   * transcript file NULLs the path in the same transaction".
   *
   * A filesystem delete cannot join a SQL transaction, so the order is chosen
   * instead: the file goes first, and an interruption between the two steps
   * leaves a row naming a file that is gone — which {@link TranscriptStore.tail}
   * already reports as `pruned`. The reverse order would leave an orphaned file
   * that nothing knows to collect.
   *
   * Returns `true` when there was something to prune.
   */
  prune(sessionId: string): boolean;
}

export interface TranscriptStoreOptions {
  /** `<dataRoot>/state/transcripts`, from {@link DataRootPaths}. */
  readonly root: string;
  readonly sessions: SessionsRepository;
  readonly clock?: Clock;
  readonly fsyncEveryLines?: number;
  readonly fsyncIntervalMs?: number;
  readonly log?: LogFn;
}

interface WriterDefaults {
  readonly fsyncEveryLines: number;
  readonly fsyncIntervalMs: number;
}

function createWriter(
  sessionId: string,
  relativePath: string,
  absolute: string,
  sessions: SessionsRepository,
  clock: Clock,
  defaults: WriterDefaults,
  options: TranscriptWriterOptions,
): TranscriptWriter {
  const everyLines = options.fsyncEveryLines ?? defaults.fsyncEveryLines;
  const intervalMs = options.fsyncIntervalMs ?? defaults.fsyncIntervalMs;

  mkdirSync(dirname(absolute), { recursive: true });
  const fd = openSync(absolute, 'a');

  // The restart case: whatever is already in the file is the truth, and the row
  // is corrected to match it before a single new byte is written.
  let bytes = existsSync(absolute) ? statSync(absolute).size : 0;
  let lines = 0;
  let pending = 0;
  let timer: NodeJS.Timeout | undefined;
  let open = true;

  sessions.setTranscript(sessionId, { path: relativePath, bytes });

  function cancelTimer(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function armTimer(): void {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (open && pending > 0) doFlush();
    }, intervalMs);
    // The service must be able to exit without waiting on a durability timer;
    // `close()` flushes anyway, and shutdown (§4.2) always calls it.
    timer.unref();
  }

  function doFlush(): void {
    fsyncSync(fd);
    pending = 0;
    cancelTimer();
  }

  function write(payload: string, lineCount: number): void {
    if (!open) throw new Error(`Transcript writer for session ${sessionId} is closed`);
    const buffer = Buffer.from(payload, 'utf8');
    writeSync(fd, buffer);
    bytes += buffer.byteLength;
    lines += lineCount;
    pending += lineCount;
    sessions.setTranscriptBytes(sessionId, bytes);

    if (pending >= everyLines) doFlush();
    else armTimer();
  }

  function serialize(entry: TranscriptEntry): string {
    // `JSON.stringify` escapes every control character, so a line can never
    // contain a raw newline — which is the whole invariant JSONL rests on.
    const stamped = 'ts' in entry ? entry : { ts: isoTimestamp(clock()), ...entry };
    return `${JSON.stringify(stamped)}\n`;
  }

  return {
    sessionId,
    relativePath,
    path: absolute,
    bytes: () => bytes,
    linesWritten: () => lines,
    append: (entry) => write(serialize(entry), 1),
    appendMany(entries) {
      if (entries.length === 0) return;
      write(entries.map(serialize).join(''), entries.length);
    },
    flush() {
      if (open && pending > 0) doFlush();
    },
    close() {
      if (!open) return;
      if (pending > 0) doFlush();
      cancelTimer();
      open = false;
      closeSync(fd);
    },
  };
}

export function createTranscriptStore(options: TranscriptStoreOptions): TranscriptStore {
  const { root, sessions } = options;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? silentLog;
  const defaults: WriterDefaults = {
    fsyncEveryLines: options.fsyncEveryLines ?? DEFAULT_FSYNC_EVERY_LINES,
    fsyncIntervalMs: options.fsyncIntervalMs ?? DEFAULT_FSYNC_INTERVAL_MS,
  };

  function absolutePath(relativePath: string): string {
    return resolve(root, relativePath);
  }

  return {
    root,
    relativePathFor: (sessionId, at) => transcriptRelativePath(sessionId, at ?? clock()),
    absolutePath,

    open(sessionId, writerOptions = {}) {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new RecordNotFoundError('sessions', sessionId);

      const relativePath =
        session.transcriptPath ?? transcriptRelativePath(sessionId, writerOptions.at ?? clock());

      return createWriter(
        sessionId,
        relativePath,
        absolutePath(relativePath),
        sessions,
        clock,
        defaults,
        writerOptions,
      );
    },

    tail(sessionId, tailOptions = {}) {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new RecordNotFoundError('sessions', sessionId);
      if (session.transcriptPath === null) {
        return { status: 'pruned', sessionId, reason: 'path-cleared' };
      }

      const absolute = absolutePath(session.transcriptPath);
      if (!existsSync(absolute)) {
        return { status: 'pruned', sessionId, reason: 'file-missing' };
      }

      const size = statSync(absolute).size;
      const from = Math.max(0, Math.min(tailOptions.from ?? 0, size));
      const available = size - from;
      const wanted =
        tailOptions.maxBytes === undefined
          ? available
          : Math.min(available, Math.max(0, tailOptions.maxBytes));

      if (wanted === 0) {
        return {
          status: 'ok',
          sessionId,
          relativePath: session.transcriptPath,
          from,
          nextOffset: from,
          size,
          lines: [],
        };
      }

      const buffer = Buffer.allocUnsafe(wanted);
      const fd = openSync(absolute, 'r');
      let read: number;
      try {
        read = readSync(fd, buffer, 0, wanted, from);
      } finally {
        closeSync(fd);
      }

      // Stop at the last newline: a trailing fragment is a line the writer has
      // not finished, and returning it would hand the caller invalid JSON and
      // then repeat it on the next call.
      const chunk = buffer.subarray(0, read);
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        return {
          status: 'ok',
          sessionId,
          relativePath: session.transcriptPath,
          from,
          nextOffset: from,
          size,
          lines: [],
        };
      }

      const complete = chunk.subarray(0, lastNewline).toString('utf8');
      return {
        status: 'ok',
        sessionId,
        relativePath: session.transcriptPath,
        from,
        nextOffset: from + lastNewline + 1,
        size,
        lines: complete.length === 0 ? [] : complete.split('\n'),
      };
    },

    prune(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new RecordNotFoundError('sessions', sessionId);
      if (session.transcriptPath === null) return false;

      const absolute = absolutePath(session.transcriptPath);
      rmSync(absolute, { force: true });
      sessions.clearTranscript(sessionId);
      log('debug', 'transcript pruned', { sessionId, path: session.transcriptPath });
      return true;
    },
  };
}
