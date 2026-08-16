/**
 * The graceful-shutdown budget of DESIGN §4.2, milestone M9.
 *
 * The acceptance criterion this file carries: "a module that hangs in `stop()`
 * does not prevent process exit". `lifecycle.test.ts` runs the same controller
 * against a real booted service with a real hanging module; here the teardown
 * is a stub, so every path — graceful, overrun, failed — is provable in
 * milliseconds.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
  createShutdownController,
  installShutdownSignals,
  SHUTDOWN_SIGNALS,
  type ShutdownOutcome,
} from './shutdown.js';

interface Harness {
  readonly exits: number[];
  readonly finalized: ShutdownOutcome[];
  readonly events: ShutdownOutcome[];
}

function harness(): Harness {
  return { exits: [], finalized: [], events: [] };
}

const never = (): Promise<void> => new Promise<void>(() => {});

describe('createShutdownController', () => {
  it('tears down, runs the last rites, and exits 0 on the graceful path', async () => {
    const h = harness();
    const stopped: string[] = [];

    const controller = createShutdownController({
      graceMs: 5_000,
      stop: () => {
        stopped.push('stopped');
        return Promise.resolve();
      },
      finalize: (outcome) => void h.finalized.push(outcome),
      exit: (code) => void h.exits.push(code),
    });

    controller.request('SIGINT');
    const outcome = await controller.settled;

    expect(outcome.path).toBe('graceful');
    expect(outcome.reason).toBe('SIGINT');
    expect(stopped).toEqual(['stopped']);
    expect(h.finalized).toHaveLength(1);
    expect(h.exits).toEqual([0]);
  });

  it('exits anyway when the teardown outlives the grace budget', async () => {
    const h = harness();
    const controller = createShutdownController({
      graceMs: 25,
      // Stands in for a module whose `stop()` never settles.
      stop: never,
      finalize: (outcome) => void h.finalized.push(outcome),
      exit: (code) => void h.exits.push(code),
      onEvent: (outcome) => void h.events.push(outcome),
    });

    controller.request('api');
    const outcome = await controller.settled;

    expect(outcome.path).toBe('forced');
    // The owner asked for a stop and got one; an overrun is not a crash, and
    // §4.3's scheduled task must not restart the core over it.
    expect(outcome.exitCode).toBe(0);
    expect(h.exits).toEqual([0]);
    expect(h.events[0]?.path).toBe('forced');
  });

  it('removes the port file and releases the lock on the forced path too', async () => {
    // The last rites are what the next start depends on, so they cannot be
    // conditional on the teardown having gone well.
    const h = harness();
    const controller = createShutdownController({
      graceMs: 10,
      stop: never,
      finalize: (outcome) => void h.finalized.push(outcome),
      exit: (code) => void h.exits.push(code),
    });

    controller.request('SIGTERM');
    await controller.settled;

    expect(h.finalized.map((outcome) => outcome.path)).toEqual(['forced']);
  });

  it('reports a failing teardown with a non-zero exit code', async () => {
    const h = harness();
    const controller = createShutdownController({
      graceMs: 5_000,
      stop: () => Promise.reject(new Error('storage would not close')),
      finalize: (outcome) => void h.finalized.push(outcome),
      exit: (code) => void h.exits.push(code),
      failureExitCode: 70,
    });

    controller.request('api');
    const outcome = await controller.settled;

    expect(outcome.path).toBe('failed');
    expect(outcome.error).toContain('storage would not close');
    expect(h.exits).toEqual([70]);
    expect(h.finalized).toHaveLength(1);
  });

  it('acts on the first request only, so a signal during shutdown changes nothing', async () => {
    const h = harness();
    let calls = 0;
    const controller = createShutdownController({
      graceMs: 5_000,
      stop: () => {
        calls += 1;
        return Promise.resolve();
      },
      finalize: (outcome) => void h.finalized.push(outcome),
      exit: (code) => void h.exits.push(code),
    });

    controller.request('SIGINT');
    controller.request('SIGTERM');
    const outcome = await controller.settled;
    controller.request('api');

    expect(calls).toBe(1);
    expect(outcome.reason).toBe('SIGINT');
    expect(h.exits).toEqual([0]);
    expect(h.finalized).toHaveLength(1);
  });

  it('does not force an exit after the teardown has already finished', async () => {
    const h = harness();
    const controller = createShutdownController({
      graceMs: 15,
      stop: () => Promise.resolve(),
      finalize: (outcome) => void h.finalized.push(outcome),
      exit: (code) => void h.exits.push(code),
    });

    controller.request('api');
    await controller.settled;
    await new Promise((done) => setTimeout(done, 40));

    expect(h.exits).toEqual([0]);
    expect(h.finalized).toHaveLength(1);
  });

  it('reports how long the shutdown took', async () => {
    let clock = 1_000;
    const controller = createShutdownController({
      graceMs: 5_000,
      stop: () => {
        clock += 250;
        return Promise.resolve();
      },
      finalize: () => {},
      exit: () => {},
      now: () => clock,
    });

    controller.request('api');
    await expect(controller.settled).resolves.toMatchObject({ durationMs: 250 });
  });
});

describe('installShutdownSignals', () => {
  it('routes SIGINT and SIGTERM into the controller', () => {
    const requested: string[] = [];
    const target = new EventEmitter();
    installShutdownSignals(
      {
        request: (reason) => void requested.push(reason),
        requested: false,
        settled: Promise.resolve({ reason: '', path: 'graceful', durationMs: 0, exitCode: 0 }),
      },
      target,
    );

    target.emit('SIGINT');
    target.emit('SIGTERM');

    expect(requested).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('listens once per signal, leaving a second Ctrl+C as the escape hatch', () => {
    const requested: string[] = [];
    const target = new EventEmitter();
    installShutdownSignals(
      {
        request: (reason) => void requested.push(reason),
        requested: false,
        settled: Promise.resolve({ reason: '', path: 'graceful', durationMs: 0, exitCode: 0 }),
      },
      target,
    );

    target.emit('SIGINT');
    target.emit('SIGINT');

    expect(requested).toEqual(['SIGINT']);
    // The handler is gone, so the next Ctrl+C reaches Node's default one.
    expect(target.listenerCount('SIGINT')).toBe(0);
    expect(SHUTDOWN_SIGNALS).toEqual(['SIGINT', 'SIGTERM']);
  });
});
