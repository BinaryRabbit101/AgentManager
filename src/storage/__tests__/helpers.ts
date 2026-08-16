/**
 * Test helpers for storage.
 *
 * Every storage test runs against a throwaway directory under the OS temp dir —
 * never `%LOCALAPPDATA%\AgentManager` (that is the developer's real data root)
 * and never inside the repository (§1.2: "no data-root path is ever written
 * inside the repo").
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { LogFn, LogLevel } from '../log.js';

/** A temporary data root plus its cleanup. */
export interface TempRoot {
  readonly path: string;
  cleanup(): void;
}

/** Creates an empty directory under the OS temp dir to use as a data root. */
export function makeTempRoot(prefix = 'agentmanager-test-'): TempRoot {
  const path = mkdtempSync(resolve(tmpdir(), prefix));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true, maxRetries: 5 }),
  };
}

export interface RecordedLog {
  readonly level: LogLevel;
  readonly msg: string;
  readonly data?: Record<string, unknown>;
}

/** A {@link LogFn} that keeps what it was given, for asserting on boot messages. */
export function recordingLog(): LogFn & { records: RecordedLog[] } {
  const records: RecordedLog[] = [];
  const log = ((level, msg, data) => {
    records.push(data === undefined ? { level, msg } : { level, msg, data });
  }) as LogFn & { records: RecordedLog[] };
  log.records = records;
  return log;
}

/** Writes a migration file into `dir` under the runner's `NNNN_<name>.sql` convention. */
export function writeMigration(dir: string, filename: string, sql: string): string {
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, filename);
  writeFileSync(path, sql, 'utf8');
  return path;
}
