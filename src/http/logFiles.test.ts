import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LogRecord } from '../logging/index.js';

import { listLogFiles, matchesLogQuery, readLogFiles } from './logFiles.js';

let dir: string;

function write(name: string, records: Partial<LogRecord>[]): void {
  writeFileSync(join(dir, name), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmanager-logfiles-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('listLogFiles', () => {
  it('finds the active streams and their rotated archives, and nothing else', () => {
    write('core.log', [{ ts: 'a' }]);
    write('core-20260816-1.log', [{ ts: 'b' }]);
    write('access.log', [{ ts: 'c' }]);
    writeFileSync(join(dir, 'notes.txt'), 'ignore me');
    writeFileSync(join(dir, 'core.log.bak'), 'ignore me too');

    const files = listLogFiles(dir);
    expect(files.map((file) => file.name)).toEqual([
      'access.log',
      'core-20260816-1.log',
      'core.log',
    ]);
    expect(files.filter((file) => file.active).map((file) => file.name)).toEqual([
      'access.log',
      'core.log',
    ]);
  });

  it('treats a missing directory as no files rather than as an error', () => {
    expect(listLogFiles(join(dir, 'nope'))).toEqual([]);
  });
});

describe('readLogFiles', () => {
  const records: Partial<LogRecord>[] = [
    { ts: '2026-08-16T10:00:00.000Z', level: 'info', component: 'core', msg: 'boot' },
    { ts: '2026-08-16T10:00:01.000Z', level: 'debug', component: 'runner', msg: 'spawn' },
    {
      ts: '2026-08-16T10:00:02.000Z',
      level: 'error',
      component: 'runner',
      msg: 'failed',
      sessionId: 'S1',
    },
  ];

  it('parses every stream, sorts by timestamp and skips unparseable lines', () => {
    write('core-20260816-1.log', [records[0]!, records[1]!]);
    write('core.log', [records[2]!]);
    writeFileSync(join(dir, 'access.log'), 'not json at all\n');

    expect(readLogFiles(dir).map((record) => record.msg)).toEqual(['boot', 'spawn', 'failed']);
  });

  it('applies the same filters the ring buffer does', () => {
    write('core.log', records);

    expect(readLogFiles(dir, { level: 'error' }).map((r) => r.msg)).toEqual(['failed']);
    expect(readLogFiles(dir, { component: 'runner' }).map((r) => r.msg)).toEqual([
      'spawn',
      'failed',
    ]);
    expect(readLogFiles(dir, { sessionId: 'S1' }).map((r) => r.msg)).toEqual(['failed']);
    expect(readLogFiles(dir, { since: '2026-08-16T10:00:00.000Z' }).map((r) => r.msg)).toEqual([
      'spawn',
      'failed',
    ]);
  });

  it('keeps the most recent matches when a limit is given', () => {
    write('core.log', records);
    expect(readLogFiles(dir, { limit: 2 }).map((r) => r.msg)).toEqual(['spawn', 'failed']);
    expect(readLogFiles(dir, { limit: 0 })).toEqual([]);
  });

  it('drops the torn first line when it reads only the tail of a file', () => {
    write('core.log', records);
    const tail = readLogFiles(dir, { maxBytesPerFile: 120 });
    // Whatever the cut lands on, no half-line is ever returned as a record.
    expect(tail.length).toBeLessThan(3);
    expect(tail.every((record) => typeof record.ts === 'string')).toBe(true);
  });
});

describe('matchesLogQuery', () => {
  it('treats level as a minimum severity', () => {
    const record = { ts: 'x', level: 'warn' } as LogRecord;
    expect(matchesLogQuery(record, { level: 'info' })).toBe(true);
    expect(matchesLogQuery(record, { level: 'error' })).toBe(false);
  });

  it('treats since as an exclusive lower bound', () => {
    const record = { ts: '2026-08-16T10:00:00.000Z', level: 'info' } as LogRecord;
    expect(matchesLogQuery(record, { since: '2026-08-16T10:00:00.000Z' })).toBe(false);
    expect(matchesLogQuery(record, { since: '2026-08-16T09:59:59.999Z' })).toBe(true);
  });
});
