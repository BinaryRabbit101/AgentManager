/**
 * The runner's configuration sub-schema (runner DESIGN §12) — M1's second
 * acceptance criterion:
 *
 * > "`runner.*` keys resolve through **all five config layers**;
 * > `AGENTMANAGER_RUNNER_MAXCONCURRENT=4` wins over the machine-local file; an
 * > out-of-range value is a fatal validation error naming the key."
 *
 * Driven through the real loader against the real shipped files, because the
 * point of the criterion is that the *composition* works — a test against a
 * hand-built registry would prove that zod parses, which was never in doubt.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, createFoundationRegistry, loadConfig } from '../../config/index.js';

import { MAX_CONCURRENT_LIMIT, RUNNER_CONFIG_DEFAULTS } from './config.js';
import { makeTempDir, repoRoot, type TempDir } from './__tests__/helpers.js';

let dataRootDir: TempDir;

/** Writes layer 3, `<dataRoot>/config/config.json`. */
function writeMachineConfig(value: Record<string, unknown>): void {
  const dir = resolve(dataRootDir.path, 'config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'config.json'), JSON.stringify(value), 'utf8');
}

function load(
  options: { env?: NodeJS.ProcessEnv; argv?: readonly string[] } = {},
): ReturnType<typeof loadConfig> {
  return loadConfig({
    installRoot: repoRoot,
    dataRootOverride: dataRootDir.path,
    env: options.env ?? {},
    argv: options.argv ?? [],
  });
}

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-runner-config-');
});

afterEach(() => {
  dataRootDir.cleanup();
});

describe('the composed namespace', () => {
  it('is registered by the runner element rather than foundation', () => {
    const contribution = createFoundationRegistry().contributions.find(
      (entry) => entry.namespace === 'runner',
    );
    expect(contribution?.owner).toBe('runner');
    expect(contribution?.defaults).toEqual(RUNNER_CONFIG_DEFAULTS);
  });

  it('resolves §12 in full from the shipped defaults (layer 1)', () => {
    // `--edition home` because the shipped work edition is layer 2 and lowers
    // `maxConcurrent`; layer 1 on its own is what this pins.
    expect(load({ argv: ['--edition', 'home'] }).config.runner).toEqual({
      maxConcurrent: 2,
      queueLimit: 50,
      defaultModel: 'sonnet',
      startTimeoutMs: 90_000,
      idleTimeoutMs: 1_200_000,
      wallClockMaxMinutes: 120,
      gracefulInterruptMs: 10_000,
      workspaceWaitMinutes: 60,
      queueStaleHours: 24,
      question: { holdMs: 900_000, expireHours: 24 },
      transcript: { flushLines: 50, flushMs: 2000, maxMb: 512, maxTailBytes: 1_048_576 },
      // `observeCliEvent` is M11's kill switch for the CLI's `rate_limit_event`
      // (§7.4). It defaults **on**, and turning it off must cost a display and
      // no scheduling behaviour at all.
      rateLimit: { cooldownMs: 300_000, maxCooldownMs: 1_800_000, observeCliEvent: true },
    });
  });
});

describe('all five layers', () => {
  it('layer 2 — the work edition lowers maxConcurrent to 1', () => {
    const loaded = load({ argv: ['--edition', 'work'] });
    expect(loaded.config.runner.maxConcurrent).toBe(1);
    expect(loaded.sources['runner.maxConcurrent']?.layer).toBe('edition');
  });

  it('layer 3 — the machine-local file wins over the edition', () => {
    writeMachineConfig({ runner: { maxConcurrent: 3, transcript: { maxMb: 64 } } });
    const loaded = load({ argv: ['--edition', 'work'] });
    expect(loaded.config.runner).toMatchObject({ maxConcurrent: 3 });
    expect(loaded.config.runner.transcript).toMatchObject({ maxMb: 64, flushLines: 50 });
    expect(loaded.sources['runner.transcript.maxMb']?.layer).toBe('machine');
  });

  it('layer 4 — AGENTMANAGER_RUNNER_MAXCONCURRENT=4 wins over the machine-local file', () => {
    writeMachineConfig({ runner: { maxConcurrent: 3 } });
    const loaded = load({ env: { AGENTMANAGER_RUNNER_MAXCONCURRENT: '4' } });
    expect(loaded.config.runner.maxConcurrent).toBe(4);
    expect(loaded.sources['runner.maxConcurrent']?.layer).toBe('env');
  });

  it('layer 4 — a nested key resolves through the underscore mapping', () => {
    const loaded = load({
      env: {
        AGENTMANAGER_RUNNER_TRANSCRIPT_MAXTAILBYTES: '4096',
        AGENTMANAGER_RUNNER_QUESTION_HOLDMS: '1000',
      },
    });
    expect(loaded.config.runner.transcript.maxTailBytes).toBe(4096);
    expect(loaded.config.runner.question.holdMs).toBe(1000);
  });

  it('layer 5 — --set wins over the environment', () => {
    writeMachineConfig({ runner: { maxConcurrent: 3 } });
    const loaded = load({
      env: { AGENTMANAGER_RUNNER_MAXCONCURRENT: '4' },
      argv: ['--set', 'runner.maxConcurrent=5', '--set', 'runner.idleTimeoutMs=60000'],
    });
    expect(loaded.config.runner).toMatchObject({ maxConcurrent: 5, idleTimeoutMs: 60_000 });
    expect(loaded.sources['runner.maxConcurrent']?.layer).toBe('cli');
  });
});

describe('validation', () => {
  /** Asserts a fatal {@link ConfigError} whose per-key report names `key`. */
  function expectRefusal(setting: string, key: string): void {
    let error: unknown;
    try {
      load({ argv: ['--set', setting] });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const failure = error as ConfigError;
    expect(failure.report()).toContain(key);
    expect(failure.exitCode).toBeGreaterThan(0);
  }

  it('refuses a maxConcurrent above the 1..8 clamp, naming the key', () => {
    expectRefusal(
      `runner.maxConcurrent=${String(MAX_CONCURRENT_LIMIT + 1)}`,
      'runner.maxConcurrent',
    );
  });

  it('refuses a zero or negative timeout, naming the key', () => {
    expectRefusal('runner.startTimeoutMs=0', 'runner.startTimeoutMs');
    expectRefusal('runner.transcript.flushLines=-1', 'runner.transcript.flushLines');
  });

  it('refuses an unrecognised runner key rather than ignoring it', () => {
    expectRefusal('runner.maxConcurent=2', 'runner.maxConcurent');
  });

  it('refuses a wrongly-typed value', () => {
    expectRefusal('runner.transcript.maxMb=lots', 'runner.transcript.maxMb');
  });
});
