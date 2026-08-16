/**
 * A module-load counter, so "the remote module file is never imported" is a
 * testable fact rather than a claim.
 *
 * DESIGN §6.2 gates the remote module behind a **dynamic import**: "in the work
 * edition its code is never evaluated, its routes never registered, its sockets
 * never created". IMPLEMENTATION §7 asks for that to be "asserted via an import
 * spy or module-load counter", and M11 pins the same boundary. A counter
 * incremented at module-evaluation time is the only spy that observes the
 * property directly — anything else observes a consequence of it.
 *
 * The count lives on `globalThis` under a registered symbol rather than in a
 * module-level variable, so it survives however the test runner arranges module
 * instances: two copies of this file still increment one counter.
 */
const COUNTER_KEY = Symbol.for('agentmanager.moduleLoadCounts');

type Counts = Record<string, number>;

function counts(): Counts {
  const host = globalThis as { [COUNTER_KEY]?: Counts };
  return (host[COUNTER_KEY] ??= {});
}

/** Called at the top level of a dynamically imported module, on evaluation. */
export function noteModuleLoaded(moduleId: string): void {
  const store = counts();
  store[moduleId] = (store[moduleId] ?? 0) + 1;
}

/** How many times `moduleId`'s file has been evaluated in this process. */
export function moduleLoadCount(moduleId: string): number {
  return counts()[moduleId] ?? 0;
}

/** Resets one module's count. For tests that assert on a single boot. */
export function resetModuleLoadCount(moduleId: string): void {
  delete counts()[moduleId];
}
