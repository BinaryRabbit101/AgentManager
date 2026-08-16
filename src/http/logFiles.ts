/**
 * Reading log records back off disk — the fallback half of `GET /api/logs`.
 *
 * > "`GET /api/logs?…` serves the ring buffer, falling back to parsing the tail
 * > of the rotated files when `since` predates it." (DESIGN §5.3)
 *
 * The files are authoritative: every record in the ring was written to a file
 * first (§5.4 redacts at write time, and the writer is synchronous), so the
 * fallback reads files *instead of* the ring rather than merging with it. That
 * is what makes "no duplicates" a property of the design rather than of a
 * de-duplication pass.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { LEVEL_SEVERITY, type LogQuery, type LogRecord } from '../logging/index.js';

/** `core.log`, `access.log`, and their `-<YYYYMMDD>-<n>` archives (§5.2). */
const LOG_FILE_PATTERN = /^(core|access)(-\d{8}-\d+)?\.log$/;

/** Tail read per file. Ten times the ring, and far below any single archive's cap. */
export const DEFAULT_TAIL_BYTES = 4 * 1024 * 1024;

export interface LogFileInfo {
  readonly name: string;
  readonly path: string;
  readonly stream: 'core' | 'access';
  /** True for `core.log`/`access.log` — the files `/api/logs/download` ships. */
  readonly active: boolean;
  readonly size: number;
  readonly modified: Date;
}

/** Every log file in `dir`, newest name last. Missing directory yields `[]`. */
export function listLogFiles(dir: string): LogFileInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const files: LogFileInfo[] = [];
  for (const name of names.sort()) {
    const match = LOG_FILE_PATTERN.exec(name);
    if (match === null) continue;
    const path = join(dir, name);
    try {
      const stats = statSync(path);
      if (!stats.isFile()) continue;
      files.push({
        name,
        path,
        stream: match[1] === 'access' ? 'access' : 'core',
        active: match[2] === undefined,
        size: stats.size,
        modified: stats.mtime,
      });
    } catch {
      // A file rotated away between the listing and the stat is not an error.
    }
  }
  return files;
}

/**
 * The same predicate {@link LogRing.query} applies, so a ring answer and a file
 * answer to the same query are the same set.
 */
export function matchesLogQuery(record: LogRecord, filter: LogQuery): boolean {
  const minSeverity = filter.level === undefined ? 0 : (LEVEL_SEVERITY[filter.level] ?? 0);
  if ((LEVEL_SEVERITY[record.level] ?? 0) < minSeverity) return false;
  if (filter.component !== undefined && record.component !== filter.component) return false;
  if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) return false;
  if (filter.since !== undefined) {
    const since = filter.since instanceof Date ? filter.since.toISOString() : filter.since;
    if (!(record.ts > since)) return false;
  }
  return true;
}

/** Reads at most `maxBytes` from the end of a file, dropping a truncated first line. */
function readTail(path: string, maxBytes: number): string {
  let contents: Buffer;
  try {
    contents = readFileSync(path);
  } catch {
    return '';
  }
  if (contents.byteLength <= maxBytes) return contents.toString('utf8');
  const tail = contents.subarray(contents.byteLength - maxBytes).toString('utf8');
  const firstBreak = tail.indexOf('\n');
  return firstBreak === -1 ? '' : tail.slice(firstBreak + 1);
}

export interface ReadLogFilesOptions extends LogQuery {
  readonly maxBytesPerFile?: number;
}

/**
 * Parses the tails of every log file in `dir` and returns the matching records,
 * oldest first, with `limit` keeping the most recent matches — the same
 * semantics the ring buffer uses, because a log view asking for 100 lines wants
 * the last 100.
 *
 * Unparseable lines are skipped rather than reported: a torn last line is the
 * normal state of a file being appended to.
 */
export function readLogFiles(dir: string, options: ReadLogFilesOptions = {}): LogRecord[] {
  const maxBytes = options.maxBytesPerFile ?? DEFAULT_TAIL_BYTES;
  const records: LogRecord[] = [];

  for (const file of listLogFiles(dir)) {
    for (const line of readTail(file.path, maxBytes).split('\n')) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as LogRecord;
      if (typeof record.ts !== 'string') continue;
      if (!matchesLogQuery(record, options)) continue;
      records.push(record);
    }
  }

  records.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const { limit } = options;
  if (limit === undefined) return records;
  if (limit <= 0) return [];
  return records.length > limit ? records.slice(records.length - limit) : records;
}
