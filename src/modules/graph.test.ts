/**
 * The dependency graph (DESIGN §6.2, IMPLEMENTATION §7).
 *
 * Acceptance: "A dependency cycle in `dependsOn` is detected and fails fast
 * with the cycle named."
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ModuleGraphError } from './errors.js';
import { moduleMigrationsFor, topologicalOrder } from './graph.js';
import type { Module } from './types.js';

function module(id: string, dependsOn: readonly string[] = []): Module {
  return { id, dependsOn, init: () => Promise.resolve({}) };
}

const ids = (modules: readonly Module[]): string[] => modules.map((m) => m.id);

describe('topologicalOrder', () => {
  it('orders every module after the modules it depends on', () => {
    const order = topologicalOrder([
      module('runner', ['storage', 'roster']),
      module('roster', ['storage']),
      module('storage'),
    ]);

    expect(ids(order)).toEqual(['storage', 'roster', 'runner']);
  });

  it('breaks ties by declaration order, so the list reads as the boot order', () => {
    const order = topologicalOrder([module('storage'), module('secrets'), module('http')]);
    expect(ids(order)).toEqual(['storage', 'secrets', 'http']);
  });

  it('detects a cycle and names it', () => {
    const failure = attempt(() =>
      topologicalOrder([module('a', ['c']), module('b', ['a']), module('c', ['b'])]),
    );

    expect(failure).toBeInstanceOf(ModuleGraphError);
    expect(failure.message).toContain('Module dependency cycle:');
    // Every member is named, in an order that reads as a cycle: the last id
    // repeats the first.
    const cycle = (failure as ModuleGraphError).cycle ?? [];
    expect(cycle.length).toBe(4);
    expect(cycle.at(0)).toBe(cycle.at(-1));
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
    expect(failure.message).toContain(cycle.join(' -> '));
  });

  it('names the pair in a two-module cycle', () => {
    const failure = attempt(() =>
      topologicalOrder([module('roster', ['projects']), module('projects', ['roster'])]),
    );

    expect((failure as ModuleGraphError).cycle).toHaveLength(3);
    expect(failure.message).toMatch(/roster -> projects -> roster|projects -> roster -> projects/);
  });

  it('detects a module that depends on itself', () => {
    const failure = attempt(() => topologicalOrder([module('runner', ['runner'])]));
    expect(failure.message).toContain('depends on itself');
  });

  it('refuses a dependency that is not in the module list, pointing at require()', () => {
    const failure = attempt(() => topologicalOrder([module('http', ['remote'])]));

    expect(failure).toBeInstanceOf(ModuleGraphError);
    expect(failure.message).toContain('"remote"');
    expect(failure.message).toContain("ctx.require('remote')");
  });

  it('refuses two modules sharing an id', () => {
    const failure = attempt(() => topologicalOrder([module('storage'), module('storage')]));
    expect(failure.message).toContain('share the id "storage"');
  });

  it('accepts an empty list', () => {
    expect(topologicalOrder([])).toEqual([]);
  });
});

describe('moduleMigrationsFor', () => {
  it('maps the topological order onto migrations/<moduleId>/, preserving it', () => {
    const order = topologicalOrder([module('roster', ['storage']), module('storage')]);
    const sets = moduleMigrationsFor(order, '/opt/app/migrations');

    // §1.3: module sets are applied "in module topological order — the same
    // order `dependsOn` produces at start-up".
    expect(sets.map((set) => set.moduleId)).toEqual(['storage', 'roster']);
    expect(sets[0]?.dir).toBe(resolve('/opt/app/migrations', 'storage'));
  });
});

/** Returns the thrown error, failing the test if nothing was thrown. */
function attempt(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to throw');
}
