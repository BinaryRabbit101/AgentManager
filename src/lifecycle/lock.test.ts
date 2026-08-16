/**
 * The single-instance lock (DESIGN §4.2), milestone M9.
 *
 * The property under test is the one the design picks a file handle *for*: the
 * exclusion is enforced by the kernel and is released by process death however
 * it happens. The cross-process half of that — including a hard kill — is
 * proven against a real child process here; `process.test.ts` proves the same
 * thing through the built bundle, where the second instance is a whole core.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireInstanceLock,
  EXCLUSIVE_HANDLES_SUPPORTED,
  EXCLUSIVE_OPEN_FLAGS,
  LOCK_FILENAME,
  type InstanceLock,
  type LockAttempt,
} from './lock.js';

let runDir: string;
let lockPath: string;
let held: InstanceLock[];

beforeEach(() => {
  runDir = mkdtempSync(resolve(tmpdir(), 'agentmanager-lock-'));
  lockPath = join(runDir, LOCK_FILENAME);
  held = [];
});

afterEach(() => {
  for (const lock of held) lock.release();
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5 });
});

function acquire(path = lockPath): LockAttempt {
  const attempt = acquireInstanceLock({ path });
  if (attempt.acquired) held.push(attempt.lock);
  return attempt;
}

describe('acquireInstanceLock', () => {
  it('creates the run directory and the lock file', () => {
    const nested = join(runDir, 'run', LOCK_FILENAME);
    expect(acquire(nested).acquired).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  it('refuses a second acquisition while the first is held', () => {
    expect(acquire().acquired).toBe(true);

    const second = acquireInstanceLock({ path: lockPath });
    expect(second.acquired).toBe(false);
    if (second.acquired) return;
    expect(second.message).toContain(lockPath);
  });

  it('lets the next acquisition succeed once the lock is released', () => {
    const first = acquire();
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    first.lock.release();
    held = [];

    expect(acquire().acquired).toBe(true);
  });

  it('has an idempotent release that never throws', () => {
    const attempt = acquire();
    expect(attempt.acquired).toBe(true);
    if (!attempt.acquired) return;

    attempt.lock.release();
    expect(attempt.lock.released).toBe(true);
    expect(() => attempt.lock.release()).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);
    held = [];
  });

  it('takes the lock over a leftover file from a previous run', () => {
    // A file with no live handle behind it is not a lock — which is the whole
    // reason §4.2 prefers a handle to a PID file.
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, startedAt: 'yesterday' }));
    expect(acquire().acquired).toBe(true);
  });

  it('records the holding pid and start time in the file', () => {
    const attempt = acquireInstanceLock({
      path: lockPath,
      pid: 1234,
      now: () => new Date('2026-08-16T10:00:00.000Z'),
    });
    expect(attempt.acquired).toBe(true);
    if (!attempt.acquired) return;

    // Nothing can read the file while the handle is held — that is the point —
    // so the fd is closed directly rather than through `release`, which would
    // also delete the file this assertion is about.
    closeSync(attempt.lock.fd);
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;

    expect(parsed['pid']).toBe(1234);
    expect(parsed['startedAt']).toBe('2026-08-16T10:00:00.000Z');
    attempt.lock.release();
  });
});

/**
 * §4.2: "the handle dies with the process even on a hard kill".
 *
 * The child takes the lock and waits; the parent confirms it cannot take it,
 * kills the child without letting it clean up, and confirms it now can.
 */
describe.runIf(EXCLUSIVE_HANDLES_SUPPORTED)('the exclusive handle across processes', () => {
  const holdScript = (path: string): string =>
    [
      'const fs = require("node:fs");',
      `const fd = fs.openSync(${JSON.stringify(path)}, ${String(EXCLUSIVE_OPEN_FLAGS)});`,
      'console.log("acquired");',
      'setTimeout(() => {}, 60000);',
    ].join('\n');

  it('refuses another process while the handle is open, and frees it on a hard kill', async () => {
    const holder = spawn(process.execPath, ['-e', holdScript(lockPath)], { stdio: 'pipe' });
    try {
      const ready = await new Promise<string>((done) => {
        holder.stdout.on('data', (chunk: Buffer) => done(chunk.toString('utf8').trim()));
      });
      expect(ready).toBe('acquired');

      const contended = acquireInstanceLock({ path: lockPath });
      expect(contended.acquired).toBe(false);
      if (!contended.acquired) expect(contended.code).toBe('EBUSY');

      // SIGKILL on Windows is `TerminateProcess`: no handler, no cleanup, no
      // chance to release anything. Exactly the case a PID file cannot survive.
      holder.kill('SIGKILL');
      await new Promise<void>((done) => void holder.once('exit', () => done()));

      // The file outlives the process; the *handle* did not, so it is free.
      expect(existsSync(lockPath)).toBe(true);
      expect(acquire().acquired).toBe(true);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('keeps other processes from reading or deleting the lock file', () => {
    expect(acquire().acquired).toBe(true);

    const reader = spawnSync(
      process.execPath,
      [
        '-e',
        'try { require("node:fs").readFileSync(process.argv[1]); console.log("read"); } ' +
          'catch (error) { console.log("blocked:" + error.code); }',
        lockPath,
      ],
      { encoding: 'utf8' },
    );
    expect(reader.stdout.trim()).toBe('blocked:EBUSY');
  });
});
