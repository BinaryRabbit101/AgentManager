/**
 * The transcript reader (runner DESIGN §11.1's route contract and §11.2's
 * in-process `getTranscriptTail`) — **one reader with two faces**.
 *
 * `GET /api/sessions/:id/transcript` and `RunnerService.getTranscriptTail()`
 * must agree byte for byte, because they answer the same question for two
 * callers: a UI paging a live session, and orchestrator recovering a turn whose
 * live capture was lost to a restart (orchestrator §17, R3) — which "must not
 * make an HTTP call into its own process". Two implementations of a
 * whole-lines-plus-offset contract is two places to get the mid-line case wrong,
 * so there is one.
 *
 * ## The three rules that make a poll loop safe
 *
 * 1. **Whole JSONL lines only.** A `from` that lands mid-line is not an error
 *    and is not silently truncated — it **advances to the following newline**.
 *    Clients compute offsets from `sessions.transcript_bytes`, which foundation
 *    updates per append while the writer is mid-flush, so a mid-line offset is
 *    the normal case rather than the exotic one.
 * 2. **`next` always advances**, so a caller that keeps passing it back
 *    terminates. Even the empty read returns the offset it consumed to.
 * 3. **A pruned transcript is a value, not a throw.** Projects' retention NULLs
 *    the path underneath a reader at any time (foundation §1.5); the caller
 *    renders "pruned" rather than handling an exception.
 *
 * ## `tail=` costs one read regardless of file size
 *
 * Reading backwards is the whole point: without it, opening a finished session —
 * up to §8.2's 512 MB per-session cap — means paging forward from byte 0 to show
 * its end. {@link TranscriptReader.tail} seeks to `size - maxBytes` and performs
 * exactly one `read`, snapping forward to the next line boundary. The
 * {@link FileIo} seam exists so a test can prove that, by counting reads rather
 * than timing them.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';

import type { SessionsRepository, TranscriptStore } from '../../storage/index.js';

import { DEFAULT_TAIL_BYTES } from './config.js';
import { SessionNotFoundError } from './errors.js';
import type { TranscriptLine } from './transcript.js';

/** The read result both faces return (§11.1: "the same `{lines, from, next, pruned}` shape"). */
export interface TranscriptPage {
  /** Parsed whole lines, oldest first. Empty when pruned or at the end of the file. */
  readonly lines: readonly TranscriptLine[];
  /** The offset the returned lines actually start at, after any mid-line advance. */
  readonly from: number;
  /** Where to resume. Never behind `from`. */
  readonly next: number;
  /** The file's size at the moment of the read; 0 when pruned. */
  readonly size: number;
  readonly pruned: boolean;
}

export interface ReadForwardOptions {
  /** Byte offset. Mid-line is fine — the reader advances to the next newline. */
  readonly from?: number;
  /** Maximum lines to return. */
  readonly limit?: number;
}

export interface ReadTailOptions {
  /** Bytes to read back from the end. Defaults to 64 KB, capped by `maxTailBytes`. */
  readonly maxBytes?: number;
}

export interface TranscriptReader {
  read(sessionId: string, options?: ReadForwardOptions): TranscriptPage;
  tail(sessionId: string, options?: ReadTailOptions): TranscriptPage;
}

/** The filesystem calls the reader makes, so a test can count them. */
export interface FileIo {
  open(path: string): number;
  read(fd: number, buffer: Buffer, length: number, position: number): number;
  close(fd: number): void;
  size(path: string): number;
}

export const nodeFileIo: FileIo = {
  open: (path) => openSync(path, 'r'),
  read: (fd, buffer, length, position) => readSync(fd, buffer, 0, length, position),
  close: (fd) => closeSync(fd),
  size: (path) => statSync(path).size,
};

export interface TranscriptReaderOptions {
  readonly transcripts: TranscriptStore;
  readonly sessions: SessionsRepository;
  /** §12's `runner.transcript.maxTailBytes` — the ceiling a client may ask for. */
  readonly maxTailBytes: number;
  /**
   * Ceiling on one forward read, so a `limit`-less request against a 512 MB
   * transcript cannot buffer the file. Defaults to `maxTailBytes`.
   */
  readonly maxForwardBytes?: number;
  readonly io?: FileIo;
  readonly onMalformedLine?: (sessionId: string, raw: string) => void;
}

const PRUNED = (from: number): TranscriptPage => ({
  lines: [],
  from,
  next: from,
  size: 0,
  pruned: true,
});

export function createTranscriptReader(options: TranscriptReaderOptions): TranscriptReader {
  const { transcripts, sessions } = options;
  const io = options.io ?? nodeFileIo;
  const maxTailBytes = options.maxTailBytes;
  const maxForwardBytes = options.maxForwardBytes ?? maxTailBytes;

  /** Resolves the file, or reports the pruned case as a value. */
  function locate(sessionId: string): { path: string; size: number } | undefined {
    const session = sessions.get(sessionId);
    if (session === undefined) throw new SessionNotFoundError(sessionId);
    if (session.transcriptPath === null) return undefined;
    const path = transcripts.absolutePath(session.transcriptPath);
    try {
      return { path, size: io.size(path) };
    } catch {
      // The row still names a file that is no longer on disk — foundation §1.5's
      // second pruned reason, and a normal outcome of a deleted data directory.
      return undefined;
    }
  }

  function readChunk(path: string, position: number, length: number): Buffer {
    if (length <= 0) return Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(length);
    const fd = io.open(path);
    let read: number;
    try {
      read = io.read(fd, buffer, length, position);
    } finally {
      io.close(fd);
    }
    return buffer.subarray(0, read);
  }

  function parse(sessionId: string, raw: string): TranscriptLine | undefined {
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('not an object');
      }
      return value as TranscriptLine;
    } catch {
      // The writer only ever emits `JSON.stringify` output, so this is
      // corruption rather than a normal case. It is surfaced as a line rather
      // than dropped: a reader that silently swallowed bytes would make a
      // damaged transcript look merely short.
      options.onMalformedLine?.(sessionId, raw);
      return { seq: -1, ts: '', type: 'malformed', raw };
    }
  }

  return {
    read(sessionId, forward = {}) {
      const requested = Math.max(0, Math.trunc(forward.from ?? 0));
      const file = locate(sessionId);
      if (file === undefined) return PRUNED(requested);

      const start = Math.min(requested, file.size);
      if (start >= file.size) {
        return { lines: [], from: start, next: start, size: file.size, pruned: false };
      }

      // Rule 1, in one step: read one byte earlier than asked so the reader can
      // *see* whether the offset was mid-line, rather than guessing.
      const probeFrom = start === 0 ? 0 : start - 1;
      const length = Math.min(file.size - probeFrom, maxForwardBytes + 1);
      const chunk = readChunk(file.path, probeFrom, length);

      let cursor = 0;
      let lineStart = probeFrom;
      if (start > 0) {
        if (chunk[0] === 0x0a) {
          // The byte before the offset was a newline, so the offset is exactly
          // a line boundary and nothing needs skipping.
          cursor = 1;
        } else {
          const newline = chunk.indexOf(0x0a);
          if (newline === -1) {
            // No complete line ahead: the request landed inside the writer's
            // last, still-unterminated line. Report no progress rather than a
            // fragment; the next poll sees the newline.
            return { lines: [], from: start, next: start, size: file.size, pruned: false };
          }
          cursor = newline + 1;
        }
        lineStart = probeFrom + cursor;
      }

      const limit =
        forward.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, forward.limit);
      const lines: TranscriptLine[] = [];
      let next = lineStart;
      let scan = cursor;
      while (lines.length < limit) {
        const newline = chunk.indexOf(0x0a, scan);
        if (newline === -1) break;
        const raw = chunk.subarray(scan, newline).toString('utf8');
        if (raw.length > 0) {
          const line = parse(sessionId, raw);
          if (line !== undefined) lines.push(line);
        }
        scan = newline + 1;
        next = probeFrom + scan;
      }

      return { lines, from: lineStart, next, size: file.size, pruned: false };
    },

    tail(sessionId, tailOptions = {}) {
      const file = locate(sessionId);
      if (file === undefined) return PRUNED(0);

      const wanted = Math.min(
        maxTailBytes,
        Math.max(0, Math.trunc(tailOptions.maxBytes ?? DEFAULT_TAIL_BYTES)),
      );
      const start = Math.max(0, file.size - wanted);
      if (file.size === 0) {
        return { lines: [], from: 0, next: 0, size: 0, pruned: false };
      }

      const chunk = readChunk(file.path, start, file.size - start);

      // Snap forward: unless the window happens to begin at a line boundary, its
      // first line is a fragment of a record that started before it.
      let cursor = 0;
      if (start > 0) {
        const newline = chunk.indexOf(0x0a);
        if (newline === -1) {
          return { lines: [], from: file.size, next: file.size, size: file.size, pruned: false };
        }
        cursor = newline + 1;
      }

      const lines: TranscriptLine[] = [];
      const from = start + cursor;
      let next = from;
      let scan = cursor;
      for (;;) {
        const newline = chunk.indexOf(0x0a, scan);
        if (newline === -1) break;
        const raw = chunk.subarray(scan, newline).toString('utf8');
        if (raw.length > 0) {
          const line = parse(sessionId, raw);
          if (line !== undefined) lines.push(line);
        }
        scan = newline + 1;
        next = start + scan;
      }

      return { lines, from, next, size: file.size, pruned: false };
    },
  };
}
