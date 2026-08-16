/**
 * The process lifecycle through a real boot — milestone M9, DESIGN §4.2/§6.3.
 *
 * Everything here runs against the composition root with a temp data root, so
 * the sockets, the database and the module graph are the real ones; only the
 * process-level effects (`exit`, and the listener set for the two fatal cases)
 * are injected. The criteria that are *about* the process — a second instance,
 * a stale port file, a real fatal exit — are in `process.test.ts`, spawned.
 *
 * Acceptance covered here:
 * - "Boot tasks run after storage is ready and before any listener binds,
 *   proven by a test observing bind order."
 * - "a module that hangs in `stop()` does not prevent process exit."
 * - "Work edition with a forced non-loopback bind exits fatally with a clear
 *   message; home edition with a non-loopback bind not owned by the remote
 *   module does the same."
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findInstallRoot } from '../config/index.js';
import { isDatabaseOpen } from '../storage/index.js';
import type { Module } from '../modules/index.js';
import { boot, type BootOptions, type BootedService, type RunIo } from '../main.js';

import {
  BindInvariantError,
  BIND_INVARIANT_EXIT_CODE,
  createShutdownController,
  observeListeners,
  REMOTE_SERVICE,
  type ListenerObservation,
  type RemoteService,
  type ShutdownOutcome,
} from './index.js';

const repoRoot = findInstallRoot(resolve(import.meta.dirname, '..'));

/** A listener set with a socket that is not on this machine's loopback. */
const tailnetOnly: ListenerObservation = {
  source: 'handles',
  listeners: [{ address: '100.101.102.103', port: 7478, family: 'IPv4' }],
};

function capture(): RunIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (line) => void lines.push(line),
    err: (line) => void errors.push(line),
  };
}

let dataRoot: string;
let booted: BootedService[];
let exitCodes: number[];

beforeEach(() => {
  dataRoot = mkdtempSync(resolve(tmpdir(), 'agentmanager-lifecycle-'));
  booted = [];
  exitCodes = [];
});

afterEach(async () => {
  for (const service of booted) await service.shutdown().catch(() => undefined);
  rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5 });
});

async function bootTest(options: BootOptions = {}): Promise<BootedService> {
  const service = await boot({
    installRoot: repoRoot,
    dataRoot,
    env: {},
    pretty: false,
    tightenAcl: false,
    acl: { run: () => {} },
    exit: (code) => void exitCodes.push(code),
    ...options,
    http: { port: 0, ...options.http },
    argv: ['--set', 'secrets.provider=env', ...(options.argv ?? [])],
  });
  booted.push(service);
  return service;
}

function portOf(service: BootedService): number {
  const url = service.url();
  expect(url).toBeDefined();
  return Number(new URL(url ?? '').port);
}

describe('boot task ordering (§4.2)', () => {
  it('has bound no listener of its own by the time boot tasks run', async () => {
    // §4.2: "modules register boot tasks that run after storage is up and
    // before the listener binds". Observed on the sockets rather than on the
    // phase labels: the boot task asks the process what it is listening on.
    const seen: number[][] = [];
    const fixture: Module = {
      id: 'fixture-observer',
      dependsOn: ['storage'],
      init(ctx) {
        ctx.registerBootTask(() => {
          // Reconciliation needs the database and must precede any socket.
          ctx.store.settings.set('fixture.reconciled', true);
          seen.push(observeListeners().listeners.map((listener) => listener.port));
        }, 'observe');
        return {};
      },
    };

    const service = await bootTest({ additionalModules: [fixture] });
    const port = portOf(service);

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(port);
    expect(observeListeners().listeners.map((listener) => listener.port)).toContain(port);
    expect(service.storage.store.settings.get('fixture.reconciled')).toBe(true);
  });
});

describe('the bind-time invariant through a real boot (§6.3)', () => {
  it('records what it saw on a service that satisfies it', async () => {
    const service = await bootTest();
    expect(service.bind.edition).toBe('work');
    expect(service.bind.nonLoopback).toEqual([]);
    expect(service.bind.loopback.map((listener) => listener.port)).toContain(portOf(service));
    expect(service.bind.remote).toBeNull();
  });

  it('exits fatally when the work edition has a non-loopback listener', async () => {
    const io = capture();
    const failure = await bootTest({ listeners: () => tailnetOnly, io }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(BindInvariantError);
    expect(exitCodes).toEqual([BIND_INVARIANT_EXIT_CODE]);
    // Clear enough to act on: which socket, which rule, what to check.
    expect(io.errors.join('\n')).toContain('100.101.102.103:7478');
    expect(io.errors.join('\n')).toContain('work edition');
    // And nothing is left running behind the refusal.
    expect(isDatabaseOpen(join(dataRoot, 'state', 'agentmanager.db'))).toBe(false);
    expect(existsSync(join(dataRoot, 'state', 'agentmanager.db-wal'))).toBe(false);
  });

  it('exits fatally when a home-edition listener is claimed by nobody', async () => {
    const io = capture();
    const failure = await bootTest({
      argv: ['--edition', 'home'],
      listeners: () => tailnetOnly,
      io,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BindInvariantError);
    expect(exitCodes).toEqual([BIND_INVARIANT_EXIT_CODE]);
    expect(io.errors.join('\n')).toContain('not claimed by the remote module');
  });

  it('accepts a home-edition listener the remote module publishes as its own', async () => {
    // The contract the remote element will satisfy: a service on the registry
    // whose `boundAddress()` matches the socket the OS reports.
    const claim: Module = {
      id: 'fixture-remote',
      dependsOn: [],
      init(ctx) {
        const service: RemoteService = {
          boundAddress: () => ({ address: '100.101.102.103', port: 7478, source: 'tailscale' }),
        };
        ctx.provide(REMOTE_SERVICE, service);
        return {};
      },
    };

    const service = await bootTest({
      argv: ['--edition', 'home'],
      additionalModules: [claim],
      listeners: () => tailnetOnly,
    });

    expect(service.bind.remote).toEqual({
      address: '100.101.102.103',
      port: 7478,
      source: 'tailscale',
    });
    expect(service.bind.nonLoopback).toHaveLength(1);
  });

  it('refuses a home-edition claim that does not match the socket', async () => {
    const claim: Module = {
      id: 'fixture-remote',
      dependsOn: [],
      init(ctx) {
        ctx.provide(REMOTE_SERVICE, {
          boundAddress: () => ({ address: '100.101.102.103', port: 9999, source: 'tailscale' }),
        } satisfies RemoteService);
        return {};
      },
    };

    const failure = await bootTest({
      argv: ['--edition', 'home'],
      additionalModules: [claim],
      listeners: () => tailnetOnly,
      io: capture(),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BindInvariantError);
  });

  it('treats the home edition with no remote listener exactly like the work edition', async () => {
    // The placeholder remote module provides no service, so `home` with remote
    // enabled is as closed as `work` — which is what M11 will pin.
    const service = await bootTest({ argv: ['--edition', 'home'] });
    expect(service.runtime.order).toContain('remote');
    expect(service.bind.remote).toBeNull();
    expect(service.bind.nonLoopback).toEqual([]);
  });
});

describe('the shutdown budget against a real service (§4.2)', () => {
  it('checkpoints the WAL, and exits 0, on the graceful path', async () => {
    const service = await bootTest();
    const exits: number[] = [];
    const finalized: ShutdownOutcome[] = [];

    const controller = createShutdownController({
      graceMs: 5_000,
      stop: () => service.shutdown(),
      finalize: (outcome) => void finalized.push(outcome),
      exit: (code) => void exits.push(code),
    });

    controller.request('SIGINT');
    const outcome = await controller.settled;
    booted = [];

    expect(outcome.path).toBe('graceful');
    expect(outcome.durationMs).toBeLessThan(5_000);
    expect(exits).toEqual([0]);
    expect(finalized).toHaveLength(1);
    expect(isDatabaseOpen(service.paths.database)).toBe(false);
    expect(existsSync(join(dataRoot, 'state', 'agentmanager.db-wal'))).toBe(false);
  });

  it('exits anyway when a module hangs in stop(), and still closes the database', async () => {
    const service = await bootTest({
      additionalModules: [
        {
          id: 'fixture-hang',
          dependsOn: ['storage'],
          // Stops first in reverse order, so it strands every module behind it
          // — including storage, whose stop() is the WAL checkpoint.
          init: () => ({ stop: () => new Promise<void>(() => {}) }),
        },
      ],
      // Far beyond the process budget: the point is that the *process* deadline
      // is what ends this, not the module runtime's per-module ceiling.
      stopTimeoutMs: 120_000,
    });

    const exits: number[] = [];
    const controller = createShutdownController({
      graceMs: 250,
      stop: () => service.shutdown(),
      finalize: (outcome) => {
        if (outcome.path !== 'graceful') service.storage.close();
      },
      exit: (code) => void exits.push(code),
    });

    const started = Date.now();
    controller.request('SIGTERM');
    const outcome = await controller.settled;

    expect(outcome.path).toBe('forced');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(exits).toEqual([0]);
    // The last rites still left a self-contained database behind.
    expect(isDatabaseOpen(service.paths.database)).toBe(false);
    expect(existsSync(join(dataRoot, 'state', 'agentmanager.db-wal'))).toBe(false);
  });
});
