/**
 * **Foundation M11 — the work edition's module inventory.**
 *
 * foundation IMPLEMENTATION §11 asks for a suite pinning "work-edition module
 * inventory, socket binding assertions in both editions, config validation
 * rejections, and a static check that no feature module imports another feature
 * module directly".
 *
 * Remote M10 (`src/modules/remote/boundary*.test.ts`) already owns the *socket*
 * half of that list and the config-validation rejections, and it owns them
 * against real boots and real sockets. This file deliberately does not repeat
 * any of it. What M10 could not assert — because it is a statement about the
 * whole module list rather than about remote — is the **inventory** itself:
 *
 * | Already pinned | Where | What M11 adds |
 * |---|---|---|
 * | Work edition binds no non-loopback socket, `/api/remote/*` is absent | `remote/boundary.test.ts` | The complete list of module ids that *are* loaded, so a module appearing is as visible as one disappearing |
 * | The remote module file is never evaluated in the work edition | `main.test.ts`, `remote/boundary.test.ts` | The same fact stated as a **set difference**: home minus work is exactly `['remote']`, and nothing else moves |
 * | `home` + `modules.remote.enabled: false` binds what `work` binds | `remote/boundary.test.ts` | The two editions' inventories, registries and route-table owners compared field for field |
 *
 * ## Why an inventory and not just a listener count
 *
 * D6 says the work edition is "the same codebase with the listener module not
 * started". A listener count proves nothing *else* opened a socket; it cannot
 * see a module that loaded but happened to bind nothing this run, and it cannot
 * see a module that quietly stopped loading. Both are edition drift. The
 * inventory is the direct statement: these ids, exactly, and every route on the
 * live table belongs to one of them.
 *
 * ## The load-counter ordering constraint
 *
 * The same rule `remote/boundary.test.ts` documents applies here: ES modules are
 * evaluated once per worker, so **every work-edition boot comes first in this
 * file**. A home-edition boot above them would put `remote/index.js` in the
 * module cache and make a later count of zero meaningless. Nothing here imports
 * `./remote/index.js` other than as a type.
 */
import { describe, expect, it } from 'vitest';

import { boot, type BootOptions, type BootedService } from '../main.js';
import { moduleLoadCount, resetModuleLoadCount } from './loadProbe.js';
import { makeTempDir, repoRoot, type TempDir } from './__tests__/helpers.js';

/**
 * §6.2's list, written out.
 *
 * ```ts
 * const modules = [storage, secrets, http, roster, projects, runner];
 * if (config.modules.orchestrator.enabled) modules.push(orchestrator);
 * if (config.edition === 'home' && config.modules.remote.enabled) modules.push(remote);
 * ```
 *
 * Restated here rather than derived from `main.ts`, on purpose: a test that
 * asked the composition root what it composed would pass whatever the
 * composition root did. This list is the design document's, and a change to
 * either has to be a decision about both.
 */
const FOUNDATION_MODULES = ['storage', 'secrets', 'http'] as const;
const ALWAYS_ON_FEATURES = ['roster', 'projects', 'runner'] as const;

const WORK_INVENTORY = [...FOUNDATION_MODULES, ...ALWAYS_ON_FEATURES, 'orchestrator'].sort();
const HOME_INVENTORY = [...WORK_INVENTORY, 'remote'].sort();

const REMOTE_MODULE_ID = 'remote';

/** A machine with no Tailscale at all, and timers that never fire. */
const quietRemote: BootOptions['remote'] = {
  detect: { locateCli: () => undefined, networkInterfaces: () => ({}) },
  timers: { after: () => () => {} },
};

interface Booted {
  readonly service: BootedService;
  readonly temp: TempDir;
}

async function bootCore(options: BootOptions = {}): Promise<Booted> {
  const temp = makeTempDir('agentmanager-inventory-');
  const service = await boot({
    installRoot: repoRoot,
    dataRoot: temp.path,
    env: {},
    pretty: false,
    tightenAcl: false,
    acl: { run: () => {} },
    exit: () => {},
    io: { out: () => {}, err: () => {} },
    ...options,
    http: { port: 0, heartbeatMs: 0, ...options.http },
    remote: { ...quietRemote, ...options.remote },
    argv: ['--set', 'secrets.provider=env', ...(options.argv ?? [])],
  });
  return { service, temp };
}

/** Everything an inventory comparison is made of, for one booted service. */
interface Inventory {
  readonly edition: string;
  readonly modules: readonly string[];
  readonly healthModules: readonly string[];
  readonly routeOwners: readonly string[];
  readonly services: Readonly<Record<RegistryName, boolean>>;
}

/** Every service name §6.2's modules publish, so absence is asserted by name. */
const REGISTRY_NAMES = [
  'storage',
  'secrets',
  'http',
  'roster',
  'projects',
  'runner',
  'orchestrator',
  'remote',
] as const;

type RegistryName = (typeof REGISTRY_NAMES)[number];

async function inventoryOf(booted: BootedService): Promise<Inventory> {
  const health = await booted.health();
  return {
    edition: booted.config.edition,
    modules: [...booted.runtime.order].sort(),
    healthModules: health.modules.map((module) => module.id).sort(),
    routeOwners: [...new Set(booted.runtime.routes.routes.map((route) => route.moduleId))].sort(),
    services: Object.fromEntries(
      REGISTRY_NAMES.map((name) => [name, booted.runtime.registry.require(name) !== undefined]),
    ) as Record<RegistryName, boolean>,
  };
}

async function withBoot<T>(
  options: BootOptions,
  use: (service: BootedService) => Promise<T>,
): Promise<T> {
  const booted = await bootCore(options);
  try {
    return await use(booted.service);
  } finally {
    await booted.service.shutdown().catch(() => undefined);
    booted.temp.cleanup();
  }
}

// ---------------------------------------------------------------------------
// The work edition's inventory
// ---------------------------------------------------------------------------

describe('M11 — the work edition loads exactly the modules §6.2 lists, and no others', () => {
  // **Must stay the first boot in this file.** See the file header.
  it('has the full inventory, remote absent from every one of its four surfaces', async () => {
    resetModuleLoadCount(REMOTE_MODULE_ID);

    await withBoot({}, async (service) => {
      expect(service.config.edition).toBe('work');
      const inventory = await inventoryOf(service);

      // (1) The module graph itself — an exact list, not a `not.toContain`.
      // A module that appears is as much a failure as one that vanishes.
      expect(inventory.modules).toEqual(WORK_INVENTORY);

      // (2) What `/api/health` reports, which is what an operator reads.
      expect(inventory.healthModules).toEqual(WORK_INVENTORY);

      // (3) Who owns the routes on the live table. Every route belongs to a
      // module that is actually loaded — the table cannot carry an orphan.
      expect(inventory.routeOwners.length).toBeGreaterThan(0);
      for (const owner of inventory.routeOwners) expect(WORK_INVENTORY).toContain(owner);
      expect(inventory.routeOwners).not.toContain(REMOTE_MODULE_ID);

      // (4) The service registry — §6.2's "any code that would want to ask
      // 'are we home edition?' instead asks whether a capability is present".
      expect(inventory.services.remote).toBe(false);
      for (const name of REGISTRY_NAMES) {
        if (name === REMOTE_MODULE_ID) continue;
        expect(inventory.services[name], `registry service "${name}"`).toBe(true);
      }

      // And the file was never evaluated, which is the cause of all four.
      expect(moduleLoadCount(REMOTE_MODULE_ID)).toBe(0);
    });
  });

  it('loses exactly the orchestrator when its gate is closed, and nothing else', async () => {
    // The control for the inventory assertion above: without it, a test that
    // only ever saw one configuration could not tell an inventory from a
    // constant. `modules.orchestrator.enabled` is the other gate in §6.2, and
    // unlike remote's it is an operator's switch rather than an edition
    // invariant — so closing it must move exactly one id.
    await withBoot({ argv: ['--set', 'modules.orchestrator.enabled=false'] }, async (service) => {
      const inventory = await inventoryOf(service);

      expect(inventory.modules).toEqual(WORK_INVENTORY.filter((id) => id !== 'orchestrator'));
      expect(inventory.services.orchestrator).toBe(false);
      expect(inventory.routeOwners).not.toContain('orchestrator');
      // Every other capability is untouched: a gate is not a fork.
      expect(inventory.services.runner).toBe(true);
      expect(inventory.services.roster).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// home minus work is exactly one module
// ---------------------------------------------------------------------------

describe('M11 — the two editions differ by one module and nothing else (D6)', () => {
  it('adds remote to the home inventory and changes no other id, service or route owner', async () => {
    // Both editions in one test, so this is a comparison between two
    // observations rather than between an observation and a remembered
    // expectation. The work boot is first, which also keeps the load counter
    // above honest.
    const work = await withBoot({}, (service) => inventoryOf(service));
    const home = await withBoot({ argv: ['--edition', 'home'] }, (service) => inventoryOf(service));

    expect(work.edition).toBe('work');
    expect(home.edition).toBe('home');
    // The counter is deliberately *not* asserted here: `remote/index.js` is now
    // in this worker's module cache, and a cached module is not re-evaluated, so
    // a count would say more about the runner than about the edition. Its zero
    // in the work edition above is the load-bearing half, and `main.test.ts`
    // owns the positive one.

    // The difference, in both directions.
    expect(home.modules).toEqual(HOME_INVENTORY);
    expect(home.modules.filter((id) => !work.modules.includes(id))).toEqual([REMOTE_MODULE_ID]);
    expect(work.modules.filter((id) => !home.modules.includes(id))).toEqual([]);

    // The same statement for the capability registry and the route table: one
    // capability appears, and the routes it brings are its own.
    expect({ ...home.services, remote: false }).toEqual(work.services);
    expect(home.routeOwners).toContain(REMOTE_MODULE_ID);
    expect(home.routeOwners.filter((owner) => owner !== REMOTE_MODULE_ID)).toEqual(
      work.routeOwners,
    );
  });

  it('is the work edition again when home has modules.remote.enabled false', async () => {
    // remote M10 proves the two are identical listener for listener. This is the
    // same equivalence at the level M11 owns: the inventory, the registry and
    // the route-table owners, so "the edition is configuration" (D6) is true of
    // the module list and not only of the sockets.
    const work = await withBoot({}, (service) => inventoryOf(service));
    const disabled = await withBoot(
      { argv: ['--edition', 'home', '--set', 'modules.remote.enabled=false'] },
      (service) => inventoryOf(service),
    );

    expect(disabled.edition).toBe('home');
    expect({ ...disabled, edition: 'work' }).toEqual(work);
  });
});
