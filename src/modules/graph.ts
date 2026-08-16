/**
 * The dependency graph of DESIGN §6.2: "Modules are topologically sorted by
 * `dependsOn`, started in order […] and stopped in reverse."
 *
 * The same order is §1.3's migration order — "each module's set in module
 * topological order — the same order `dependsOn` produces at start-up, so a
 * module's tables exist before any module that depends on it runs". Storage
 * deliberately does not sort; it applies what it is given, and
 * {@link moduleMigrationsFor} is the one place that turns this order into
 * migration sets. One graph, one answer.
 */
import { resolve } from 'node:path';

import { ModuleGraphError } from './errors.js';
import type { Module } from './types.js';

/**
 * Modules in start order: every module after all of its `dependsOn`.
 *
 * Ties are broken by declaration order, so the list in `main.ts` reads as the
 * boot order it produces whenever dependencies do not force otherwise — a
 * property worth having when the list *is* the documentation of what runs.
 *
 * @throws ModuleGraphError on a duplicate id, an unknown dependency, or a cycle
 *   (named as `a -> b -> a`).
 */
export function topologicalOrder(modules: readonly Module[]): readonly Module[] {
  const byId = new Map<string, Module>();
  for (const module of modules) {
    if (byId.has(module.id)) {
      throw new ModuleGraphError(
        `Two modules share the id "${module.id}"; module ids are the namespace ` +
          '`dependsOn`, the service registry and `migrations/<moduleId>/` all key on.',
      );
    }
    byId.set(module.id, module);
  }

  for (const module of modules) {
    for (const dependency of module.dependsOn) {
      if (dependency === module.id) {
        throw new ModuleGraphError(`Module "${module.id}" depends on itself.`, [
          module.id,
          module.id,
        ]);
      }
      if (!byId.has(dependency)) {
        throw new ModuleGraphError(
          `Module "${module.id}" depends on "${dependency}", which is not in the module list. ` +
            'A dependency that may legitimately be absent (an edition-gated module) is not a ' +
            "`dependsOn`; ask for it with `ctx.require('" +
            dependency +
            "')` instead (DESIGN §6.2).",
        );
      }
    }
  }

  // Kahn's algorithm, scanning in declaration order so ties stay stable.
  const remaining = new Map<string, Set<string>>();
  for (const module of modules) remaining.set(module.id, new Set(module.dependsOn));

  const ordered: Module[] = [];
  for (;;) {
    const next = modules.find(
      (module) => remaining.get(module.id)?.size === 0 && remaining.has(module.id),
    );
    if (next === undefined) break;
    remaining.delete(next.id);
    for (const dependencies of remaining.values()) dependencies.delete(next.id);
    ordered.push(next);
  }

  if (remaining.size > 0) {
    const cycle = findCycle(byId, remaining);
    throw new ModuleGraphError(
      `Module dependency cycle: ${cycle.join(' -> ')}. ` +
        'Modules in a cycle can never be started in dependency order; break it by having one ' +
        'of them talk to the other through the event bus or the service registry (DESIGN §6.1).',
      cycle,
    );
  }

  return ordered;
}

/**
 * One concrete cycle among the modules Kahn could not place, as ids in order
 * with the first repeated at the end.
 *
 * Naming an actual cycle rather than listing the stuck modules is the whole
 * point of the acceptance criterion: "a dependency cycle in `dependsOn` is
 * detected and fails fast **with the cycle named**".
 */
function findCycle(byId: Map<string, Module>, remaining: Map<string, Set<string>>): string[] {
  const onPath: string[] = [];
  const inPath = new Set<string>();
  const done = new Set<string>();

  const walk = (id: string): string[] | undefined => {
    if (inPath.has(id)) return [...onPath.slice(onPath.indexOf(id)), id];
    if (done.has(id)) return undefined;

    onPath.push(id);
    inPath.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!remaining.has(dependency)) continue;
      const found = walk(dependency);
      if (found !== undefined) return found;
    }
    onPath.pop();
    inPath.delete(id);
    done.add(id);
    return undefined;
  };

  for (const id of remaining.keys()) {
    const found = walk(id);
    // `dependsOn` points at what must start *first*, so walking it yields the
    // cycle backwards; reversing prints it in start order, which is the
    // direction a reader is trying to follow.
    if (found !== undefined) return [...found].reverse();
  }
  return [...remaining.keys()];
}

/** One module's shipped migration directory, as storage's runner takes it. */
export interface ModuleMigrationDir {
  readonly moduleId: string;
  readonly dir: string;
}

/**
 * `migrations/<moduleId>/` for each module, **in the order given** (§1.3).
 *
 * Pass the output of {@link topologicalOrder}. Directories that do not exist
 * are not filtered here — `moduleMigrationSets` skips them, and shipping
 * migrations is optional for a module with no tables of its own.
 */
export function moduleMigrationsFor(
  order: readonly Module[],
  migrationsRoot: string,
): readonly ModuleMigrationDir[] {
  return order.map((module) => ({
    moduleId: module.id,
    dir: resolve(migrationsRoot, module.id),
  }));
}
