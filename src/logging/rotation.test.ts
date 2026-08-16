import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RotatingFileWriter, daysToMs, formatDay, parseDay } from './rotation.js';
import type { RotationOptions } from './rotation.js';

let dir: string;

/** Fixed clock — retention must never depend on when the suite happens to run. */
const BASE = new Date('2026-08-16T12:00:00.000Z');
let clockValue = BASE;
const now = (): Date => clockValue;

function daysBefore(days: number): Date {
  return new Date(BASE.getTime() - daysToMs(days));
}

function writer(overrides: Partial<RotationOptions> = {}): RotatingFileWriter {
  return new RotatingFileWriter({
    dir,
    baseName: 'core',
    maxBytes: 64,
    maxFiles: 10,
    retentionMs: daysToMs(14),
    now,
    ...overrides,
  });
}

function archives(): string[] {
  return readdirSync(dir)
    .filter((name) => name !== 'core.log')
    .sort();
}

/** Seeds a rotated archive as if it had been written on that day. */
function seedArchive(day: Date, index: number): string {
  const name = `core-${formatDay(day)}-${index}.log`;
  writeFileSync(join(dir, name), 'old\n');
  return name;
}

beforeEach(() => {
  clockValue = BASE;
  dir = mkdtempSync(join(tmpdir(), 'agentmanager-rotation-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('formatDay / parseDay', () => {
  it('round-trips a UTC day stamp', () => {
    expect(formatDay(new Date('2026-01-05T23:59:59.999Z'))).toBe('20260105');
    expect(parseDay('20260105')).toBe(Date.UTC(2026, 0, 5));
  });
});

describe('RotatingFileWriter', () => {
  it('creates the directory and appends to the active file', () => {
    const nested = join(dir, 'deep', 'logs');
    const stream = new RotatingFileWriter({
      dir: nested,
      baseName: 'core',
      maxBytes: 1024,
      maxFiles: 10,
      retentionMs: daysToMs(14),
      now,
    });
    stream.write('one\n');
    stream.write('two\n');
    stream.close();
    expect(readFileSync(join(nested, 'core.log'), 'utf8')).toBe('one\ntwo\n');
  });

  it('resumes the byte count of an existing file rather than truncating it', () => {
    writeFileSync(join(dir, 'core.log'), 'existing\n');
    const stream = writer();
    expect(stream.bytes).toBe('existing\n'.length);
    stream.write('more\n');
    stream.close();
    expect(readFileSync(join(dir, 'core.log'), 'utf8')).toBe('existing\nmore\n');
  });

  it('rotates once a write would push the file past maxBytes', () => {
    const stream = writer({ maxBytes: 32 });
    stream.write('a'.repeat(30) + '\n');
    expect(archives()).toEqual([]);
    stream.write('b'.repeat(30) + '\n');
    stream.close();

    expect(archives()).toEqual(['core-20260816-1.log']);
    expect(readFileSync(join(dir, 'core-20260816-1.log'), 'utf8')).toContain('a'.repeat(30));
    expect(readFileSync(join(dir, 'core.log'), 'utf8')).toContain('b'.repeat(30));
  });

  it('numbers repeated rotations within the same day', () => {
    const stream = writer({ maxBytes: 16 });
    for (let i = 0; i < 4; i += 1) stream.write(`${'x'.repeat(14)}\n`);
    stream.close();
    expect(archives()).toEqual([
      'core-20260816-1.log',
      'core-20260816-2.log',
      'core-20260816-3.log',
    ]);
  });

  it('starts a fresh sequence on a new day', () => {
    const stream = writer({ maxBytes: 16 });
    stream.write(`${'x'.repeat(14)}\n`);
    stream.write(`${'x'.repeat(14)}\n`);
    clockValue = new Date('2026-08-17T09:00:00.000Z');
    stream.write(`${'x'.repeat(14)}\n`);
    stream.close();
    expect(archives()).toEqual(['core-20260816-1.log', 'core-20260817-1.log']);
  });

  it('prunes the oldest archives beyond maxFiles', () => {
    for (let i = 1; i <= 4; i += 1) seedArchive(BASE, i);
    const stream = writer({ maxFiles: 2, maxBytes: 16 });
    stream.close();
    expect(archives()).toEqual(['core-20260816-3.log', 'core-20260816-4.log']);
  });

  it('prunes archives older than the retention window even when few exist', () => {
    seedArchive(daysBefore(30), 1);
    seedArchive(daysBefore(20), 1);
    const fresh = seedArchive(daysBefore(2), 1);
    const stream = writer({ maxFiles: 50, retentionMs: daysToMs(14) });
    stream.close();
    expect(archives()).toEqual([fresh]);
  });

  it('runs the prune pass on construction, so a machine off for a week cleans up at boot', () => {
    const stale = seedArchive(daysBefore(30), 1);
    expect(readdirSync(dir)).toContain(stale);
    const stream = writer();
    stream.close();
    expect(readdirSync(dir)).not.toContain(stale);
  });

  it('leaves unrelated files in the directory alone', () => {
    writeFileSync(join(dir, 'access.log'), 'x\n');
    writeFileSync(join(dir, 'notes.txt'), 'x\n');
    seedArchive(daysBefore(30), 1);
    const stream = writer();
    stream.close();
    expect(readdirSync(dir).sort()).toEqual(['access.log', 'core.log', 'notes.txt']);
  });

  it('ignores writes after close', () => {
    const stream = writer();
    stream.write('one\n');
    stream.close();
    stream.close();
    stream.write('two\n');
    expect(readFileSync(join(dir, 'core.log'), 'utf8')).toBe('one\n');
  });
});
