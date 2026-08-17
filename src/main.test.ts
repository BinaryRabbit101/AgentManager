/**
 * The CLI surface (M1) and the composition root (M7, IMPLEMENTATION §7).
 *
 * Acceptance covered here:
 * - "`node dist/main.js --version` prints the version and exits 0" (M1), kept
 *   working through M7's rewiring — checked both in-process and, when a build
 *   is present, by spawning the real bundle.
 * - "A critical [module failing] exits non-zero", via the injectable exit.
 * - "A non-critical module that throws in `init` leaves the service running and
 *   marked unhealthy."
 * - "With `edition: 'work'`, the remote module file is never imported (asserted
 *   via an import spy or module-load counter)."
 * - "Boot tasks run after storage is ready and before any listener binds."
 * - A full boot against a temp data root starts and shuts down cleanly.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findInstallRoot } from './config/index.js';
import { isDatabaseOpen } from './storage/index.js';
// Type-only, deliberately: importing the remote module's `index.ts` here would
// evaluate its load probe and destroy the very count this file asserts on.
import type { RemoteModuleOptions } from './modules/remote/options.js';
import {
  CriticalModuleFailureError,
  moduleLoadCount,
  resetModuleLoadCount,
  type LifecyclePhase,
  type Module,
} from './modules/index.js';

import {
  PROGRAM_NAME,
  boot,
  parseArgs,
  readVersion,
  run,
  type BootOptions,
  type BootedService,
  type RunIo,
} from './main.js';

const repoRoot = findInstallRoot(dirname(fileURLToPath(import.meta.url)));
const packageVersion = (
  JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
).version;

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

describe('parseArgs', () => {
  it('recognises the version flag in both spellings', () => {
    expect(parseArgs(['--version']).version).toBe(true);
    expect(parseArgs(['-v']).version).toBe(true);
  });

  it('recognises the help flag in both spellings', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it("passes the configuration loader's flags through untouched", () => {
    expect(parseArgs(['--edition', 'work']).config).toEqual(['--edition', 'work']);
    expect(parseArgs(['--set', 'http.port=7480']).config).toEqual(['--set', 'http.port=7480']);
    expect(parseArgs(['--data-root=C:\\tmp']).config).toEqual(['--data-root=C:\\tmp']);
    expect(parseArgs(['--edition', 'work']).unknown).toEqual([]);
  });

  it('collects arguments nothing recognises', () => {
    expect(parseArgs(['--nope', 'value']).unknown).toEqual(['--nope', 'value']);
  });

  it('treats an empty argument list as no flags', () => {
    expect(parseArgs([])).toEqual({ version: false, help: false, config: [], unknown: [] });
  });
});

describe('readVersion', () => {
  it('returns the version declared in package.json', () => {
    expect(readVersion()).toBe(packageVersion);
  });
});

describe('run', () => {
  it('prints just the version and exits 0 for --version', () => {
    const io = capture();
    expect(run(['--version'], io)).toBe(0);
    expect(io.lines).toEqual([packageVersion]);
    expect(io.errors).toEqual([]);
  });

  it('prints usage and exits 0 for --help', () => {
    const io = capture();
    expect(run(['--help'], io)).toBe(0);
    expect(io.lines.join('\n')).toContain('Usage:');
  });

  it('asks the caller to start the service when given no arguments', () => {
    const io = capture();
    expect(run([], io)).toBeNull();
    expect(io.errors).toEqual([]);
  });

  it('rejects unknown arguments with exit code 2', () => {
    const io = capture();
    expect(run(['--nope'], io)).toBe(2);
    expect(io.errors.join('\n')).toContain('--nope');
  });
});

describe('the built bundle', () => {
  const bundle = join(repoRoot, 'dist', 'main.js');

  it.runIf(existsSync(bundle))('answers --version and exits 0', () => {
    const printed = execFileSync(process.execPath, [bundle, '--version'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(printed.trim()).toBe(packageVersion);
  });
});

// ---------------------------------------------------------------------------
// The composition root
// ---------------------------------------------------------------------------

let dataRoot: string;
let booted: BootedService[];
let exitCodes: number[];

beforeEach(() => {
  dataRoot = mkdtempSync(resolve(tmpdir(), 'agentmanager-boot-'));
  booted = [];
  exitCodes = [];
});

afterEach(async () => {
  for (const service of booted) {
    await service.shutdown().catch(() => undefined);
  }
  rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5 });
});

/**
 * Boots against a temp data root, the repository's own shipped `config/` as the
 * install root, and an empty environment, so nothing on the developer's machine
 * leaks into the result.
 *
 * `secrets.provider=env` keeps the store off DPAPI and off the disk (§3.1), and
 * the injected `icacls` runner means no real ACL is ever touched.
 *
 * `http.port: 0` binds the M8 listener to an ephemeral port, so a test run never
 * competes for the configured 7477 or with another test file.
 */
/**
 * A machine with no Tailscale at all: no CLI to spawn, no adapters to enumerate.
 *
 * The home-edition boots below load the real remote module, and its default
 * detector reads this machine. Injecting "nothing found" is what keeps them about
 * the composition root rather than about whether the developer is on a tailnet —
 * and stops a test run opening a socket beyond loopback.
 */
const noTailscale: RemoteModuleOptions = {
  detect: { locateCli: () => undefined, networkInterfaces: () => ({}) },
};

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
    remote: { ...noTailscale, ...options.remote },
    argv: ['--set', 'secrets.provider=env', ...(options.argv ?? [])],
  });
  booted.push(service);
  return service;
}

describe('boot', () => {
  it('starts and shuts down cleanly against a temp data root', async () => {
    const phases: LifecyclePhase[] = [];
    const service = await bootTest({ onPhase: (phase) => void phases.push(phase) });

    expect(service.config.edition).toBe('work');
    expect(service.paths.dataRoot).toBe(resolve(dataRoot));
    // §6.2's list order: `[storage, secrets, http, roster, projects, runner,
    // orchestrator]`, as far as the elements that exist. `orchestrator` is last
    // because it is pushed behind `modules.orchestrator.enabled`, which the
    // shipped defaults leave on.
    expect(service.runtime.order).toEqual([
      'storage',
      'secrets',
      'http',
      'roster',
      'projects',
      'runner',
      'orchestrator',
    ]);
    expect(service.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(service.storage.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(dataRoot, 'state', 'agentmanager.db'))).toBe(true);
    expect(existsSync(join(dataRoot, 'state', 'logs', 'core.log'))).toBe(true);
    expect(isDatabaseOpen(service.paths.database)).toBe(true);

    expect(phases).toEqual([
      'config-loaded',
      'logging-ready',
      'storage-ready',
      'secrets-ready',
      'modules-init',
      'boot-tasks',
      'listener-bind',
      'ready',
    ]);

    const health = await service.health();
    expect(health.status).toBe('ok');
    expect(health.modules.map((module) => module.id)).toEqual([
      'storage',
      'secrets',
      'http',
      'roster',
      'projects',
      'runner',
      'orchestrator',
    ]);
    // §6.2 names exactly these as critical; a feature module that fails must
    // leave the service reachable rather than end the process.
    expect(health.modules.filter((module) => module.critical).map((module) => module.id)).toEqual([
      'storage',
      'secrets',
      'http',
    ]);

    await service.shutdown();
    booted = [];

    expect(service.url()).toBeUndefined();

    expect(isDatabaseOpen(service.paths.database)).toBe(false);
    expect(service.runtime.phase).toBe('stopped');
    // The WAL is checkpointed away by the close (§4.2).
    expect(existsSync(join(dataRoot, 'state', 'agentmanager.db-wal'))).toBe(false);
  });

  it('never imports the remote module file in the work edition', async () => {
    // §6.2: "in the work edition its code is never evaluated, its routes never
    // registered, its sockets never created".
    resetModuleLoadCount('remote');
    const service = await bootTest();

    expect(service.config.edition).toBe('work');
    expect(service.config.modules.remote.enabled).toBe(false);
    expect(moduleLoadCount('remote')).toBe(0);
    expect(service.runtime.order).not.toContain('remote');
  });

  it('loads the remote module only in the home edition with it enabled', async () => {
    const service = await bootTest({ argv: ['--edition', 'home'] });

    expect(service.config.modules.remote.enabled).toBe(true);
    expect(service.runtime.order).toContain('remote');
    expect(moduleLoadCount('remote')).toBeGreaterThanOrEqual(1);
  });

  it('does not load the remote module in the home edition when it is disabled', async () => {
    resetModuleLoadCount('remote');
    const service = await bootTest({
      argv: ['--edition', 'home', '--set', 'modules.remote.enabled=false'],
    });

    expect(service.runtime.order).not.toContain('remote');
    expect(moduleLoadCount('remote')).toBe(0);
  });

  it('runs boot tasks after storage is ready and before the listener-bind phase', async () => {
    const marks: string[] = [];
    const fixture: Module = {
      id: 'fixture-runner',
      dependsOn: ['storage'],
      init(ctx) {
        ctx.registerBootTask(() => {
          // The reconciliation §4.2 describes needs the database, and needs it
          // before anything can be reached over a socket.
          ctx.store.settings.set('fixture.bootTaskRan', true);
          marks.push('bootTask');
        }, 'reconcile');
        return { start: () => void marks.push('listener.bind') };
      },
    };

    const service = await bootTest({
      additionalModules: [fixture],
      onPhase: (phase) => void marks.push(`phase:${phase}`),
    });

    expect(marks.indexOf('phase:storage-ready')).toBeLessThan(marks.indexOf('bootTask'));
    expect(marks.indexOf('bootTask')).toBeLessThan(marks.indexOf('phase:listener-bind'));
    expect(marks.indexOf('bootTask')).toBeLessThan(marks.indexOf('listener.bind'));
    expect(service.storage.store.settings.get('fixture.bootTaskRan')).toBe(true);
  });

  it('keeps running, and reports unhealthy, when a non-critical module throws in init', async () => {
    const service = await bootTest({
      additionalModules: [
        {
          id: 'fixture-noncritical',
          dependsOn: [],
          init: () => {
            throw new Error('the fixture module is broken');
          },
        },
      ],
    });

    expect(service.runtime.phase).toBe('ready');
    expect(exitCodes).toEqual([]);

    const health = await service.health();
    expect(health.status).toBe('degraded');
    const broken = health.modules.find((module) => module.id === 'fixture-noncritical');
    expect(broken?.status).toBe('failed');
    expect(broken?.error).toContain('the fixture module is broken');
    // The rest of the service is untouched: storage still answers.
    expect(health.modules.find((module) => module.id === 'storage')?.status).toBe('ok');
  });

  it('exits non-zero when a critical module fails, without killing the test runner', async () => {
    const failure = await bootTest({
      additionalModules: [
        {
          id: 'fixture-critical',
          dependsOn: [],
          critical: true,
          init: () => {
            throw new Error('critical fixture is broken');
          },
        },
      ],
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CriticalModuleFailureError);
    expect(exitCodes).toHaveLength(1);
    expect(exitCodes[0]).toBeGreaterThan(0);
    // Nothing is left open behind the failure.
    expect(existsSync(join(dataRoot, 'state', 'agentmanager.db-wal'))).toBe(false);
  });

  it('exits with the configuration exit code on invalid configuration', async () => {
    const io = capture();
    const failure = await bootTest({
      argv: ['--set', 'http.port=notanumber'],
      io,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(exitCodes).toEqual([78]);
    expect(io.errors.join('\n')).toContain('http.port');
    expect(io.errors.join('\n')).toContain(PROGRAM_NAME);
  });

  it('refuses the work edition with remote enabled, as configuration validation', async () => {
    const failure = await bootTest({
      argv: ['--set', 'modules.remote.enabled=true'],
      io: capture(),
    }).catch((error: unknown) => error);

    expect((failure as Error).message).toContain('invalid');
    expect(exitCodes).toEqual([78]);
  });

  it('raises the ANTHROPIC_API_KEY condition into health under subscription auth', async () => {
    // DESIGN §3.5 / architecture D2: the override is silent, so it is both
    // logged and kept as a health condition the UI displays.
    const service = await bootTest({
      argv: ['--edition', 'home'],
      env: { ANTHROPIC_API_KEY: 'sk-ant-fixture' },
    });

    const health = await service.health();
    const conditions = health.conditions.map((condition) => condition.id);
    expect(conditions).toContain('secrets.anthropicApiKeyOverridesSubscription');
    expect(health.modules.find((module) => module.id === 'secrets')?.status).toBe('degraded');
    // The value itself never appears in the condition text.
    expect(JSON.stringify(health)).not.toContain('sk-ant-fixture');
  });

  it('gives modules a working event bus wired to the events table', async () => {
    const seen: string[] = [];
    const service = await bootTest({
      additionalModules: [
        {
          id: 'fixture-emitter',
          dependsOn: ['storage'],
          init(ctx) {
            ctx.bus.subscribe(['fixture.*'], (event) => void seen.push(event.type));
            ctx.registerBootTask(() => {
              ctx.bus.emit({ type: 'fixture.happened', persist: true });
            }, 'emit');
            return {};
          },
        },
      ],
    });

    expect(seen).toEqual(['fixture.happened']);
    expect(service.storage.store.events.list({ types: ['fixture.*'] })).toHaveLength(1);
  });

  it('applies element-owned migrations in module topological order', async () => {
    // §1.3, proven through the composition root: the module list decides the
    // order storage applies `migrations/<moduleId>/` in.
    const service = await bootTest({
      additionalModules: [
        // Every element in the v1 list is now a real module, so the fixture is
        // a stand-in for the next one — and it deliberately ships no migration
        // directory, which is the negative half of this assertion.
        { id: 'fixture-element', dependsOn: ['orchestrator'], init: () => ({}) },
      ],
    });

    expect(service.runtime.order).toEqual([
      'storage',
      'secrets',
      'http',
      'roster',
      'projects',
      'runner',
      'orchestrator',
      'fixture-element',
    ]);
    // Foundation's set first, then every module that actually ships one — which
    // in this build is `roster`, `projects`, `runner` and `orchestrator` (the
    // fixture has no directory).
    expect(Object.keys(service.storage.setVersions)).toEqual([
      'foundation',
      'roster',
      'projects',
      'runner',
      'orchestrator',
    ]);
  });
});

describe('shutdown', () => {
  it('is safe to call twice', async () => {
    const service = await bootTest();
    await service.shutdown();
    await service.shutdown();
    booted = [];
    expect(service.runtime.phase).toBe('stopped');
  });

  it('stops modules in reverse order, closing the database last', async () => {
    const marks: string[] = [];
    const service = await bootTest({
      additionalModules: [
        {
          id: 'fixture-late',
          dependsOn: ['storage', 'secrets'],
          init: () => ({ stop: () => void marks.push('fixture-late.stop') }),
        },
      ],
    });

    const closed = vi.spyOn(service.storage, 'close');
    await service.shutdown();
    booted = [];

    expect(marks).toEqual(['fixture-late.stop']);
    expect(closed).toHaveBeenCalled();
    expect(isDatabaseOpen(service.paths.database)).toBe(false);
  });
});
