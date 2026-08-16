/**
 * Test helpers for secrets.
 *
 * Every test runs against a throwaway directory under the OS temp dir — never
 * `%LOCALAPPDATA%\AgentManager` (the developer's real data root, whose DPAPI
 * envelope holds their actual OAuth token) and never inside the repository.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { IcaclsRunner } from '../acl.js';
import { DpapiUnavailableError } from '../errors.js';
import type { DpapiBinding, DpapiLoader } from '../dpapi.js';
import type { LogFn, LogLevel } from '../types.js';

/** A temporary directory plus its cleanup. */
export interface TempDir {
  readonly path: string;
  /** `<path>\secrets` — deliberately *not* created, so "nothing was written" is assertable. */
  readonly secretsDir: string;
  cleanup(): void;
}

export function makeTempDir(prefix = 'agentmanager-secrets-test-'): TempDir {
  const path = mkdtempSync(resolve(tmpdir(), prefix));
  return {
    path,
    secretsDir: resolve(path, 'secrets'),
    cleanup: () => rmSync(path, { recursive: true, force: true, maxRetries: 5 }),
  };
}

export interface RecordedLog {
  readonly level: LogLevel;
  readonly msg: string;
  readonly data?: Record<string, unknown>;
}

/** A {@link LogFn} that keeps what it was given, for asserting on the fallback `WARN`. */
export function recordingLog(): LogFn & { records: RecordedLog[] } {
  const records: RecordedLog[] = [];
  const log = ((level, msg, data) => {
    records.push(data === undefined ? { level, msg } : { level, msg, data });
  }) as LogFn & { records: RecordedLog[] };
  log.records = records;
  return log;
}

/** An `icacls` runner that records its arguments and mutates nothing. */
export function fakeIcacls(): IcaclsRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = ((args: readonly string[]) => void calls.push([...args])) as IcaclsRunner & {
    calls: string[][];
  };
  run.calls = calls;
  return run;
}

/** ACL options that keep a test off the real ACL machinery entirely. */
export function inertAcl(): { platform: NodeJS.Platform; principal: string; run: IcaclsRunner } {
  return { platform: 'win32', principal: 'TESTDOMAIN\\tester', run: fakeIcacls() };
}

/**
 * An in-memory stand-in for DPAPI: XOR against the entropy, then a marker byte.
 *
 * Not encryption and not pretending to be — it exists so the *envelope* logic
 * can be tested on any platform, while the real binding is exercised by the
 * Windows-only tests in `dpapi.test.ts`.
 */
export function fakeDpapiBinding(): DpapiBinding {
  const transform = (input: Buffer, entropy: Buffer): Buffer => {
    const out = Buffer.alloc(input.length);
    for (let i = 0; i < input.length; i += 1) {
      out[i] = (input[i] ?? 0) ^ (entropy[i % entropy.length] ?? 0);
    }
    return out;
  };
  return {
    protect: (plaintext, entropy) => transform(plaintext, entropy),
    unprotect: (ciphertext, entropy) => transform(ciphertext, entropy),
  };
}

/** A loader that resolves the in-memory stand-in. */
export const fakeDpapiLoader: DpapiLoader = () => Promise.resolve(fakeDpapiBinding());

/** A loader that fails the way an ABI mismatch after a Node upgrade fails. */
export const failingDpapiLoader: DpapiLoader = () =>
  Promise.reject(
    new DpapiUnavailableError(
      'the native binary did not load for this platform or Node ABI (simulated ABI mismatch)',
    ),
  );

/** True on the machine CI runs on; the DPAPI and real-ACL tests need it. */
export const onWindows = process.platform === 'win32';
