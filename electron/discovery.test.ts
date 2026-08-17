/**
 * ui IMPLEMENTATION §6, criteria 1 and 2 — the machine half.
 *
 * - "With no core running, launching the app starts one detached and connects."
 * - "With a core already running, the app connects without spawning a second
 *   (single-instance lock in the core is not tripped)."
 *
 * The process-level halves of those sentences (`detached: true`, a real second
 * process, a session that keeps progressing after the window closes) are on the
 * manual checklist — `npm run checks:ui`, ids `M6-core-outlives-window` and
 * `M6-spawn-detached`. What is asserted here is the *decision*: whether a spawn
 * happens at all, what makes a port file stale, and that nothing in the module
 * can stop a core it started.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  coreUrl,
  discoverCore,
  startupFailureMessage,
  waitForCore,
  type CoreProbe,
  type DiscoveryDeps,
  type PortRecord,
} from './discovery.js';

const RECORD: PortRecord = {
  port: 7477,
  pid: 4242,
  startedAt: '2026-08-17T09:00:00.000Z',
  edition: 'home',
};
const HEALTHY: CoreProbe = { status: 'ok', version: '0.1.0', edition: 'home' };

interface Harness extends DiscoveryDeps {
  readonly spawns: number[];
  readonly probes: number[];
  clock: number;
}

function harness(options: {
  /** What the port file says, turn by turn; the last entry repeats. */
  readonly files: readonly (PortRecord | undefined)[];
  /** What `/healthz` answers, turn by turn; the last entry repeats. */
  readonly probes: readonly (CoreProbe | undefined)[];
}): Harness {
  const spawns: number[] = [];
  const probed: number[] = [];
  let fileTurn = 0;
  let probeTurn = 0;
  const state = {
    clock: 0,
    spawns,
    probes: probed,
    logPath: 'C:\\Data\\state\\logs\\core.log',
    readPortFile: (): PortRecord | undefined => {
      const value = options.files[Math.min(fileTurn, options.files.length - 1)];
      fileTurn += 1;
      return value;
    },
    probe: (port: number): Promise<CoreProbe | undefined> => {
      probed.push(port);
      const value = options.probes[Math.min(probeTurn, options.probes.length - 1)];
      probeTurn += 1;
      return Promise.resolve(value);
    },
    spawnCore: (): void => {
      spawns.push(state.clock);
    },
    sleep: (ms: number): Promise<void> => {
      state.clock += ms;
      return Promise.resolve();
    },
    now: (): number => state.clock,
  };
  return state;
}

describe('a core that is already listening is connected to, never re-spawned', () => {
  it('reads the port file, probes it, and stops there', async () => {
    const deps = harness({ files: [RECORD], probes: [HEALTHY] });

    const result = await discoverCore(deps);

    expect(result).toEqual({ kind: 'connected', url: 'http://127.0.0.1:7477', probe: HEALTHY });
    // The whole point: the core's own single-instance lock is never tripped,
    // because nothing was started.
    expect(deps.spawns).toEqual([]);
    expect(deps.probes).toEqual([7477]);
  });

  it('loads the window over HTTP at loopback, never file://', () => {
    // §1.5 #2, and the reason the Electron client and the tailnet client cannot
    // drift: same origin model, same relative paths, same bundle.
    expect(coreUrl(7477)).toBe('http://127.0.0.1:7477');
    expect(coreUrl(7477).startsWith('file:')).toBe(false);
  });
});

describe('nothing listening means spawn, then poll for readiness', () => {
  it('spawns when there is no port file at all', async () => {
    const deps = harness({ files: [undefined, RECORD], probes: [HEALTHY] });

    const result = await discoverCore(deps);

    expect(deps.spawns).toHaveLength(1);
    expect(result).toEqual({ kind: 'started', url: 'http://127.0.0.1:7477', probe: HEALTHY });
  });

  it('treats a port file whose /healthz does not answer as stale', async () => {
    // foundation §4.2: "A stale file whose `/healthz` does not answer is ignored
    // and overwritten." A hard-killed core leaves the file behind, so the file's
    // existence is never enough to skip the spawn.
    const deps = harness({ files: [RECORD], probes: [undefined, HEALTHY] });

    const result = await discoverCore(deps);

    expect(deps.spawns).toHaveLength(1);
    expect(result.kind).toBe('started');
  });

  it('re-reads the port file each poll, so a core that bound elsewhere is found', async () => {
    // The configured port can be taken; the core binds an ephemeral one and
    // republishes. Polling the stale port forever would time out beside a
    // perfectly healthy core.
    const moved: PortRecord = { ...RECORD, port: 51_099 };
    const deps = harness({ files: [RECORD, moved], probes: [undefined, HEALTHY] });

    const result = await discoverCore(deps);

    expect(result).toEqual({
      kind: 'started',
      url: 'http://127.0.0.1:51099',
      probe: HEALTHY,
    });
    expect(deps.probes).toEqual([7477, 51_099]);
  });
});

describe('a core that never comes up fails with the log path, not a blank window', () => {
  it('gives up after the readiness budget and names the log', async () => {
    const deps = harness({ files: [undefined], probes: [undefined] });

    const result = await waitForCore(deps, { readinessTimeoutMs: 1_000, pollIntervalMs: 250 });

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.logPath).toBe('C:\\Data\\state\\logs\\core.log');
    expect(result.message).toContain('C:\\Data\\state\\logs\\core.log');
    expect(result.message).toContain('1 seconds');
  });

  it('states the budget it actually waited', () => {
    expect(startupFailureMessage(30_000, 'C:\\log')).toContain('30 seconds');
  });
});

describe('the shell never owns the core (foundation §4.1)', () => {
  it('has no code path that stops, kills or signals a spawned process', () => {
    // Asserted over the source because it is a *prohibition*: there is no call
    // to make and therefore nothing to observe at runtime. `spawnCore` returns
    // `void` for the same reason — a handle is how "never owns" quietly becomes
    // "kills on exit".
    const source = readFileSync(resolve(process.cwd(), 'electron', 'discovery.ts'), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*\/|\*)/u.test(line))
      .join('\n');
    expect(code).not.toMatch(/\.kill\(/u);
    expect(code).not.toMatch(/process\.kill/u);
    expect(code).not.toMatch(/SIGTERM|SIGINT|taskkill/u);
    expect(code).toContain('spawnCore(): void');
  });
});
