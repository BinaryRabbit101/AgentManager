/**
 * The module runner (DESIGN §6.2, IMPLEMENTATION §7).
 *
 * Acceptance covered here:
 * - "Start order matches the topological order and stop order is exactly its
 *   reverse, proven by a test recording hook calls."
 * - "A non-critical module that throws in `init` leaves the service running and
 *   marked unhealthy; a critical one exits non-zero." (The exit itself is the
 *   composition root's; see main.test.ts. Here the runner's half is proven: it
 *   refuses to continue and unwinds.)
 * - "Boot tasks run after storage is ready and before the listener bind phase."
 */
import { describe, expect, it, vi } from 'vitest';

import { CriticalModuleFailureError, ModuleTimeoutError } from './errors.js';
import { ModuleRuntime, type ModuleRuntimeOptions } from './runtime.js';
import type { LifecyclePhase, Module, ModuleContext } from './types.js';
import {
  emptyResolver,
  fakeStore,
  recordingModule,
  stubLogger,
  testConfig,
} from './__tests__/helpers.js';

const config = testConfig();

function runtimeFor(
  modules: readonly Module[],
  overrides: Partial<ModuleRuntimeOptions> = {},
): ModuleRuntime {
  const logger = stubLogger();
  return new ModuleRuntime({
    modules,
    config,
    store: fakeStore(),
    secrets: emptyResolver,
    logger: () => logger,
    clock: () => new Date('2026-08-16T10:35:00.000Z'),
    ...overrides,
  });
}

describe('start and stop order', () => {
  it('starts in topological order and stops in exactly the reverse', async () => {
    const log: string[] = [];
    const runtime = runtimeFor([
      recordingModule({ id: 'runner', dependsOn: ['storage', 'roster'], log }),
      recordingModule({ id: 'roster', dependsOn: ['storage'], log }),
      recordingModule({ id: 'storage', log }),
    ]);

    await runtime.startAll();
    expect(runtime.order).toEqual(['storage', 'roster', 'runner']);
    expect(log).toEqual([
      'storage.init',
      'roster.init',
      'runner.init',
      'storage.start',
      'roster.start',
      'runner.start',
    ]);

    log.length = 0;
    await runtime.stop();
    expect(log).toEqual(['runner.stop', 'roster.stop', 'storage.stop']);
  });

  it('is a no-op when stopped twice', async () => {
    const log: string[] = [];
    const runtime = runtimeFor([recordingModule({ id: 'storage', log })]);
    await runtime.startAll();
    await runtime.stop();
    await runtime.stop();
    expect(log.filter((entry) => entry === 'storage.stop')).toHaveLength(1);
    expect(runtime.phase).toBe('stopped');
  });
});

describe('failure handling (§6.2)', () => {
  it('keeps the service running when a non-critical module throws in init', async () => {
    const log: string[] = [];
    const runtime = runtimeFor([
      recordingModule({ id: 'storage', log }),
      recordingModule({ id: 'orchestrator', log, failAt: 'init' }),
      recordingModule({ id: 'runner', log }),
    ]);

    await runtime.startAll();

    // The broken module never starts; everything else does.
    expect(log).toEqual([
      'storage.init',
      'orchestrator.init',
      'runner.init',
      'storage.start',
      'runner.start',
    ]);
    expect(runtime.phase).toBe('ready');

    const health = await runtime.health();
    expect(health.status).toBe('degraded');
    const broken = health.modules.find((module) => module.id === 'orchestrator');
    expect(broken?.status).toBe('failed');
    expect(broken?.error).toContain('orchestrator failed in init');
    expect(health.modules.find((module) => module.id === 'runner')?.status).toBe('ok');
  });

  it('keeps the service running when a non-critical module throws in start', async () => {
    const log: string[] = [];
    const runtime = runtimeFor([
      recordingModule({ id: 'storage', log }),
      recordingModule({ id: 'orchestrator', log, failAt: 'start' }),
    ]);

    await runtime.startAll();
    const health = await runtime.health();

    expect(health.status).toBe('degraded');
    expect(health.modules.find((module) => module.id === 'orchestrator')?.status).toBe('failed');
  });

  it('refuses to continue when a critical module fails, unwinding what started', async () => {
    const log: string[] = [];
    const runtime = runtimeFor([
      recordingModule({ id: 'storage', log, critical: true }),
      recordingModule({ id: 'secrets', log, critical: true, failAt: 'init' }),
      recordingModule({ id: 'runner', log }),
    ]);

    await expect(runtime.startAll()).rejects.toBeInstanceOf(CriticalModuleFailureError);
    // `runner` was never initialised, and `storage` was stopped on the way out
    // so the database handle and its WAL do not outlive the process.
    expect(log).toEqual(['storage.init', 'secrets.init', 'storage.stop']);
    expect(runtime.phase).toBe('stopped');
  });

  it('carries the module id, phase and cause on the critical failure', async () => {
    const runtime = runtimeFor([
      recordingModule({ id: 'storage', log: [], critical: true, failAt: 'start' }),
    ]);

    const error = await runtime.startAll().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CriticalModuleFailureError);
    const failure = error as CriticalModuleFailureError;
    expect(failure.moduleId).toBe('storage');
    expect(failure.phase).toBe('start');
    expect(failure.exitCode).toBeGreaterThan(0);
  });

  it('times out a module that never finishes starting', async () => {
    const log: string[] = [];
    const runtime = runtimeFor([recordingModule({ id: 'orchestrator', log, hangAt: 'start' })], {
      startTimeoutMs: 20,
    });

    await runtime.startAll();
    const health = await runtime.health();
    const stuck = health.modules.find((module) => module.id === 'orchestrator');

    expect(stuck?.status).toBe('failed');
    expect(stuck?.error).toContain('did not finish start()');
    expect(new ModuleTimeoutError('x', 'start', 20).message).toContain('20 ms');
  });

  it('does not let a hanging stop() strand the modules behind it', async () => {
    const log: string[] = [];
    const runtime = runtimeFor(
      [
        recordingModule({ id: 'storage', log }),
        recordingModule({ id: 'http', dependsOn: ['storage'], log, hangAt: 'stop' }),
      ],
      { stopTimeoutMs: 20 },
    );

    await runtime.startAll();
    await runtime.stop();

    // `http` hangs, but `storage` — behind it in reverse order — still stops.
    expect(log).toContain('storage.stop');
    expect(runtime.phase).toBe('stopped');
  });
});

describe('boot tasks (§4.2)', () => {
  it('runs them after init and before the listener-bind phase', async () => {
    const marks: string[] = [];
    const phases: LifecyclePhase[] = [];

    const modules: Module[] = [
      {
        id: 'runner',
        dependsOn: [],
        init(ctx) {
          marks.push('runner.init');
          ctx.registerBootTask(() => void marks.push('runner.bootTask'), 'reconcile-sessions');
          return { start: () => void marks.push('runner.start') };
        },
      },
      {
        id: 'http',
        dependsOn: ['runner'],
        init: () => ({
          // The listener binds in start(); that is what makes "boot tasks
          // before any listener binds" structurally true.
          start: () => void marks.push('http.listener.bind'),
        }),
      },
    ];

    const runtime = runtimeFor(modules, {
      onPhase: (phase) => {
        phases.push(phase);
        marks.push(`phase:${phase}`);
      },
    });
    await runtime.startAll();

    expect(phases).toEqual(['modules-init', 'boot-tasks', 'listener-bind', 'ready']);
    expect(marks.indexOf('runner.bootTask')).toBeGreaterThan(marks.indexOf('phase:boot-tasks'));
    expect(marks.indexOf('runner.bootTask')).toBeLessThan(marks.indexOf('phase:listener-bind'));
    expect(marks.indexOf('runner.bootTask')).toBeLessThan(marks.indexOf('http.listener.bind'));
    expect(runtime.bootTaskNames).toEqual(['runner:reconcile-sessions']);
    expect(runtime.phases.map((mark) => mark.phase)).toEqual(phases);
  });

  it('degrades the owning module when a boot task throws, without ending the boot', async () => {
    const runtime = runtimeFor([
      {
        id: 'runner',
        dependsOn: [],
        critical: true,
        init(ctx) {
          ctx.registerBootTask(() => {
            throw new Error('reconciliation failed');
          }, 'reconcile');
          return {};
        },
      },
    ]);

    await runtime.startAll();
    const health = await runtime.health();

    expect(runtime.phase).toBe('ready');
    expect(health.modules[0]?.status).toBe('degraded');
    expect(health.modules[0]?.error).toContain('reconciliation failed');
  });
});

describe('module context (§6.1)', () => {
  it('hands each module the frozen config, the store, and a tagged logger', async () => {
    let seen: ModuleContext | undefined;
    const logger = vi.fn(() => stubLogger());
    const store = fakeStore();

    const runtime = runtimeFor(
      [
        {
          id: 'roster',
          dependsOn: [],
          init: (ctx) => {
            seen = ctx;
            return {};
          },
        },
      ],
      { logger, store },
    );
    await runtime.startAll();

    expect(seen?.moduleId).toBe('roster');
    expect(seen?.config).toBe(config);
    expect(Object.isFrozen(seen?.config)).toBe(true);
    expect(seen?.store).toBe(store);
    expect(seen?.settings).toBe(store.settings);
    expect(seen?.bus).toBe(runtime.bus);
    expect(seen?.clock()).toBeInstanceOf(Date);
    expect(logger).toHaveBeenCalledWith('roster');
    // The read-only face of §3.2: no `set`, no `delete`.
    expect(Object.keys(seen?.secrets ?? {})).toEqual(['get']);
  });

  it('routes registrations onto the one route table, attributed to the module', async () => {
    const runtime = runtimeFor([
      {
        id: 'foundation',
        dependsOn: [],
        init: (ctx) => {
          ctx.registerRoutes([
            { method: 'GET', path: '/healthz', handler: () => undefined },
            {
              method: 'POST',
              path: '/api/service/shutdown',
              handler: () => undefined,
              remote: 'deny',
            },
          ]);
          return {};
        },
      },
    ]);
    await runtime.startAll();

    expect(runtime.routes.size).toBe(2);
    expect(runtime.routes.find('GET', '/healthz')?.moduleId).toBe('foundation');
    expect(runtime.routes.find('GET', '/healthz')?.remote).toBe('allow');
    expect(runtime.routes.deniedRemotely().map((r) => r.path)).toEqual(['/api/service/shutdown']);
  });

  it('publishes and resolves services, and answers undefined for absent ones', async () => {
    const found: unknown[] = [];
    const runtime = runtimeFor([
      {
        id: 'storage',
        dependsOn: [],
        init: (ctx) => {
          ctx.provide('storage', { schemaVersion: 1 });
          return {};
        },
      },
      {
        id: 'roster',
        dependsOn: ['storage'],
        init: (ctx) => {
          found.push(ctx.require<{ schemaVersion: number }>('storage'));
          found.push(ctx.require('remote'));
          return {};
        },
      },
    ]);
    await runtime.startAll();

    expect(found).toEqual([{ schemaVersion: 1 }, undefined]);
  });

  it('aggregates registered health checks alongside the handle health', async () => {
    const runtime = runtimeFor([
      {
        id: 'secrets',
        dependsOn: [],
        init: (ctx) => {
          ctx.registerHealthCheck(
            () => ({
              status: 'degraded',
              conditions: [
                { id: 'secrets.degradedToKeyfile', level: 'warn', message: 'keyfile fallback' },
              ],
            }),
            'provider',
          );
          return { health: () => ({ status: 'ok', detail: { provider: 'keyfile' } }) };
        },
      },
    ]);
    await runtime.startAll();

    const health = await runtime.health();
    expect(health.status).toBe('degraded');
    expect(health.phase).toBe('ready');
    expect(health.modules[0]?.status).toBe('degraded');
    expect(health.modules[0]?.detail).toEqual({ provider: 'keyfile' });
    expect(health.conditions.map((condition) => condition.id)).toEqual([
      'secrets.degradedToKeyfile',
    ]);
  });

  it('survives a health check that throws', async () => {
    const runtime = runtimeFor([
      {
        id: 'roster',
        dependsOn: [],
        init: (ctx) => {
          ctx.registerHealthCheck(() => {
            throw new Error('health check exploded');
          }, 'broken');
          return {};
        },
      },
    ]);
    await runtime.startAll();

    const health = await runtime.health();
    expect(health.modules[0]?.status).toBe('failed');
    expect(health.modules[0]?.message).toContain('health check exploded');
  });
});
