/**
 * In-memory ring buffer of the most recent log records (DESIGN.md §5.3).
 *
 * Every record written to a file stream is teed here, already redacted, so that
 * `GET /api/logs` (M8) can serve the UI without touching the filesystem — which
 * is what makes the log view work identically over the tailnet.
 */
import { LEVEL_SEVERITY, type LogLevel, type LogQuery, type LogRecord } from './types.js';

export class LogRing {
  readonly capacity: number;
  readonly #records: (LogRecord | undefined)[];
  #next = 0;
  #size = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`log ring capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.#records = new Array<LogRecord | undefined>(capacity);
  }

  /** Number of records currently held (at most {@link capacity}). */
  get size(): number {
    return this.#size;
  }

  push(record: LogRecord): void {
    this.#records[this.#next] = record;
    this.#next = (this.#next + 1) % this.capacity;
    if (this.#size < this.capacity) this.#size += 1;
  }

  /** Every held record, oldest first. */
  toArray(): LogRecord[] {
    const out: LogRecord[] = [];
    const start = (this.#next - this.#size + this.capacity) % this.capacity;
    for (let i = 0; i < this.#size; i += 1) {
      const record = this.#records[(start + i) % this.capacity];
      if (record !== undefined) out.push(record);
    }
    return out;
  }

  clear(): void {
    this.#records.fill(undefined);
    this.#next = 0;
    this.#size = 0;
  }

  /**
   * Filtered view, oldest first. `level` is a minimum severity, `since` is an
   * exclusive lower bound on `ts`, and `limit` keeps the *most recent* matches —
   * a log view asking for 100 lines wants the last 100, not the first.
   */
  query(filter: LogQuery = {}): LogRecord[] {
    const minSeverity = filter.level === undefined ? 0 : severityOf(filter.level);
    const since = normaliseSince(filter.since);

    const matches = this.toArray().filter((record) => {
      if (severityOf(record.level) < minSeverity) return false;
      if (filter.component !== undefined && record.component !== filter.component) return false;
      if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) return false;
      if (since !== undefined && !(record.ts > since)) return false;
      return true;
    });

    const { limit } = filter;
    if (limit === undefined) return matches;
    if (limit <= 0) return [];
    return matches.length > limit ? matches.slice(matches.length - limit) : matches;
  }
}

function severityOf(level: string | undefined): number {
  if (level === undefined) return 0;
  return LEVEL_SEVERITY[level as LogLevel] ?? 0;
}

function normaliseSince(since: string | Date | undefined): string | undefined {
  if (since === undefined) return undefined;
  return since instanceof Date ? since.toISOString() : since;
}
