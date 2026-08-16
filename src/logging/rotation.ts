/**
 * Size-based rotation with an age cap (DESIGN.md §5.2).
 *
 * The active stream is `<base>.log`; rotating renames it to
 * `<base>-<YYYYMMDD>-<n>.log`, where `n` counts rotations within that UTC day.
 * Pruning keeps at most `maxFiles` archives *and* drops anything older than
 * `retentionDays`, whichever bites first. It runs on every rotation and once in
 * the constructor, so a machine that was off for a week cleans up at next start
 * rather than waiting for the first 10 MB of new logs.
 *
 * Writes are synchronous (`writeSync` on an append handle). At the volume a
 * single-user desktop service produces this is cheaper than the bookkeeping an
 * async queue would need to guarantee ordering, and it means `flushAndClose()`
 * has nothing to flush.
 */
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export interface RotationOptions {
  readonly dir: string;
  /** `core` or `access` — the stem of both the active file and its archives. */
  readonly baseName: string;
  readonly maxBytes: number;
  /** Rotated archives kept; the active file is not counted. */
  readonly maxFiles: number;
  readonly retentionMs: number;
  readonly now: () => Date;
  /** Reports a rotation failure; defaults to a single line on stderr. */
  readonly onError?: (error: unknown) => void;
}

interface Archive {
  readonly name: string;
  /** UTC midnight of the day named in the file, in epoch milliseconds. */
  readonly dayMs: number;
  readonly index: number;
}

const MILLISECONDS_PER_DAY = 86_400_000;

export class RotatingFileWriter {
  readonly path: string;
  readonly #options: RotationOptions;
  #fd: number;
  #bytes: number;
  #closed = false;

  constructor(options: RotationOptions) {
    this.#options = options;
    this.path = join(options.dir, `${options.baseName}.log`);
    mkdirSync(options.dir, { recursive: true });
    this.#fd = openSync(this.path, 'a');
    this.#bytes = fstatSync(this.#fd).size;
    this.prune();
  }

  /** Bytes currently in the active file. */
  get bytes(): number {
    return this.#bytes;
  }

  write(line: string): void {
    if (this.#closed) return;
    const size = Buffer.byteLength(line);
    if (this.#bytes > 0 && this.#bytes + size > this.#options.maxBytes) this.#rotate();
    writeSync(this.#fd, line);
    this.#bytes += size;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeSync(this.#fd);
  }

  /**
   * Deletes archives beyond `maxFiles` or older than the retention window. An
   * archive is judged by the day in its name: it goes once that day is further
   * behind `now` than the window.
   */
  prune(): void {
    const { dir, maxFiles, retentionMs, now } = this.#options;
    const cutoff = now().getTime() - retentionMs;

    // Newest first, so "beyond maxFiles" is a plain index comparison.
    const archives = this.#listArchives().sort(
      (a, b) => b.dayMs - a.dayMs || b.index - a.index || b.name.localeCompare(a.name),
    );

    archives.forEach((archive, position) => {
      if (position < maxFiles && archive.dayMs >= cutoff) return;
      try {
        unlinkSync(join(dir, archive.name));
      } catch (error) {
        this.#report(error);
      }
    });
  }

  #rotate(): void {
    const target = this.#nextArchivePath();
    try {
      closeSync(this.#fd);
      renameSync(this.path, target);
      this.#bytes = 0;
    } catch (error) {
      // A rotation that cannot rename (a virus scanner holding the handle open
      // is the realistic case on Windows) must not take the service down: keep
      // appending to the current file and try again on the next write.
      this.#report(error);
    } finally {
      this.#fd = openSync(this.path, 'a');
      this.#bytes = fstatSync(this.#fd).size;
    }
    this.prune();
  }

  #nextArchivePath(): string {
    const day = formatDay(this.#options.now());
    const used = this.#listArchives()
      .filter((archive) => archive.dayMs === parseDay(day))
      .map((archive) => archive.index);
    const next = used.length === 0 ? 1 : Math.max(...used) + 1;
    return join(this.#options.dir, `${this.#options.baseName}-${day}-${next}.log`);
  }

  #listArchives(): Archive[] {
    const pattern = new RegExp(`^${escapeRegExp(this.#options.baseName)}-(\\d{8})-(\\d+)\\.log$`);
    let names: string[];
    try {
      names = readdirSync(this.#options.dir);
    } catch (error) {
      this.#report(error);
      return [];
    }

    const archives: Archive[] = [];
    for (const name of names) {
      const match = pattern.exec(name);
      if (match === null) continue;
      const [, day, index] = match;
      if (day === undefined || index === undefined) continue;
      const dayMs = parseDay(day);
      if (Number.isNaN(dayMs)) continue;
      archives.push({ name, dayMs, index: Number(index) });
    }
    return archives;
  }

  #report(error: unknown): void {
    const report = this.#options.onError;
    if (report !== undefined) {
      report(error);
      return;
    }
    process.stderr.write(`log rotation failed for ${this.path}: ${String(error)}\n`);
  }
}

/** `YYYYMMDD` in UTC, matching the archive naming of DESIGN §5.2. */
export function formatDay(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  return `${year}${month}${day}`;
}

/** Epoch milliseconds of UTC midnight on a `YYYYMMDD` day stamp. */
export function parseDay(day: string): number {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(4, 6));
  const date = Number(day.slice(6, 8));
  return Date.UTC(year, month - 1, date);
}

export function daysToMs(days: number): number {
  return days * MILLISECONDS_PER_DAY;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
