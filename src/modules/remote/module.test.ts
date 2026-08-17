/**
 * The `remote` module through the real composition root — remote IMPLEMENTATION
 * M1 and the core-level half of M3.
 *
 * Everything here goes through `boot()` in `src/main.ts`, because five of the
 * things under test are only true through that path: the edition gate is in the
 * composition root and nowhere else, the module migration's *order* comes from the
 * module graph (foundation §1.3), the route table is mounted by the `http` module
 * at `start()` (§6.4), `ctx.provide` is what foundation's bind-time assertion reads
 * (§6.3), and `critical: false` is a property of the runtime rather than of this
 * file.
 *
 * **This file never imports `./index.js`.** That import would evaluate the load
 * probe and destroy the very count the work-edition criterion asserts on, so the
 * module id and the service name appear here as literals — which is also how a
 * drift between them and the module would be caught rather than hidden.
 *
 * Detection is injected in every case. On a machine with no tailnet the default
 * detector would answer "nothing found" and these tests would pass by accident; on
 * a developer's machine that *is* on a tailnet they would open a real socket. Both
 * are reasons to inject.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { observeListeners } from '../../lifecycle/bind.js';
import { boot, type BootOptions, type BootedService } from '../../main.js';
import { moduleLoadCount } from '../loadProbe.js';
import { controllableQuery, fakeAssistant, fakeResult } from '../runner/__tests__/fakeQuery.js';
import { makeTempDir, repoRoot, type TempDir } from '../__tests__/helpers.js';

import type { RemoteStatus, RemoteTimers } from './listener.js';
import type { Detection, TailscaleDetector } from './tailscale.js';

/** The literals, restated rather than imported (see the file comment). */
const REMOTE_MODULE_ID = 'remote';
const REMOTE_SERVICE = 'remote';
const REMOTE_ENABLED_SETTING = 'remote.enabled';

let dataRootDir: TempDir;
let workspaceDir: TempDir;
let service: BootedService | undefined;
let base: string;
let exitCodes: number[];

/** A machine with no Tailscale at all. */
const noTailscale: BootOptions['remote'] = {
  detect: { locateCli: () => undefined, networkInterfaces: () => ({}) },
};

/** A detector that always claims one address, valid or not. */
function claiming(address: string): TailscaleDetector {
  const detection: Detection = {
    ok: true,
    address,
    magicDnsName: 'workstation.jackal-hippocampus.ts.net',
    backendState: 'Running',
    source: 'cli',
  };
  return {
    detect: () => Promise.resolve(detection),
    peerName: () => null,
    peerCount: () => 0,
  };
}

/** Timers that never fire, so only explicit calls move the state machine. */
const neverFires: RemoteTimers = { after: () => () => {} };

async function bootCore(options: BootOptions = {}): Promise<BootedService> {
  const booted = await boot({
    installRoot: repoRoot,
    dataRoot: dataRootDir.path,
    env: {},
    pretty: false,
    tightenAcl: false,
    acl: { run: () => {} },
    exit: (code) => void exitCodes.push(code),
    ...options,
    http: { port: 0, heartbeatMs: 0, ...options.http },
    remote: { ...noTailscale, ...options.remote },
    argv: ['--set', 'secrets.provider=env', ...(options.argv ?? [])],
  });
  service = booted;
  const url = booted.url();
  if (url === undefined) throw new Error('the local listener did not bind');
  base = url;
  return booted;
}

async function bootHome(options: BootOptions = {}): Promise<BootedService> {
  return bootCore({ ...options, argv: ['--edition', 'home', ...(options.argv ?? [])] });
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T; text: string }> {
  const answer = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await answer.text();
  return {
    status: answer.status,
    text,
    body: (text.length === 0 ? undefined : JSON.parse(text)) as T,
  };
}

function nonLoopbackListeners(): readonly { address: string; port: number }[] {
  return observeListeners().listeners.filter(
    (entry) => !entry.address.startsWith('127.') && entry.address !== '::1',
  );
}

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-remote-boot-');
  workspaceDir = makeTempDir('agentmanager-remote-work-');
  service = undefined;
  exitCodes = [];
});

afterEach(async () => {
  await service?.shutdown().catch(() => undefined);
  service = undefined;
  dataRootDir.cleanup();
  workspaceDir.cleanup();
});

// ---------------------------------------------------------------------------
// M1 — module skeleton and edition wiring
// ---------------------------------------------------------------------------

describe('M1 — the edition gate (§6.2, architecture D6)', () => {
  // **This test must stay first in the file.** ES modules are evaluated once per
  // worker, so a home-edition boot anywhere above it would put the remote module
  // in the module cache and leave a later work-edition boot unable to load it
  // again — which would make a zero count prove nothing. Being the first boot in
  // an isolated worker is what makes it prove something.
  it('never loads the module, or its routes, in the work edition', async () => {
    expect(moduleLoadCount(REMOTE_MODULE_ID)).toBe(0);
    const booted = await bootCore();

    expect(booted.config.edition).toBe('work');
    expect(booted.config.modules.remote.enabled).toBe(false);
    // The counter is incremented at module evaluation, so zero means the file was
    // never even parsed as a module — the property §6.2 actually promises.
    expect(moduleLoadCount(REMOTE_MODULE_ID)).toBe(0);
    expect(booted.runtime.order).not.toContain(REMOTE_MODULE_ID);
    expect(booted.runtime.registry.require(REMOTE_SERVICE)).toBeUndefined();

    // Asserted against the live route table, not a source list (§12 contract 6).
    expect(booted.runtime.routes.routes.some((route) => route.path.startsWith('/api/remote'))).toBe(
      false,
    );
    expect((await call('GET', '/api/remote/status')).status).toBe(404);
  });

  it('starts the module in the home edition with modules.remote.enabled and reports it in /api/health', async () => {
    const booted = await bootHome();

    expect(booted.config.modules.remote.enabled).toBe(true);
    expect(booted.runtime.order).toContain(REMOTE_MODULE_ID);
    // `dependsOn: ['storage', 'http']` is also the start order.
    for (const dependency of ['storage', 'http']) {
      expect(booted.runtime.order.indexOf(dependency)).toBeLessThan(
        booted.runtime.order.indexOf(REMOTE_MODULE_ID),
      );
    }

    const health = await call<{
      modules: { id: string; status: string; critical: boolean; detail?: RemoteStatus }[];
    }>('GET', '/api/health');
    const remote = health.body.modules.find((module) => module.id === REMOTE_MODULE_ID);
    expect(remote).toBeDefined();
    // Not critical: a broken remote listener must leave the local service running.
    expect(remote?.critical).toBe(false);
    // The gate opening is what evaluated the file — the other half of the counter
    // assertion above.
    expect(moduleLoadCount(REMOTE_MODULE_ID)).toBeGreaterThanOrEqual(1);
  });

  it('does not load the module in the home edition when modules.remote.enabled is false', async () => {
    const booted = await bootHome({ argv: ['--set', 'modules.remote.enabled=false'] });

    expect(booted.runtime.order).not.toContain(REMOTE_MODULE_ID);
    expect(booted.runtime.registry.require(REMOTE_SERVICE)).toBeUndefined();
    // A home edition with remote switched off is as closed as the work edition.
    expect(booted.bind.remote).toBeNull();
    expect(booted.bind.nonLoopback).toEqual([]);
    expect((await call('GET', '/api/remote/status')).status).toBe(404);
  });
});

describe('M1 — the module migration (§1.3)', () => {
  it('applies migrations/remote/ once, in module topological order, recorded under "remote"', async () => {
    const booted = await bootHome();

    expect(booted.storage.setVersions[REMOTE_MODULE_ID]).toBe(1);
    // Foundation's numbered set first, then each element's in module topological
    // order; `remote` comes after `http`'s dependents because it depends on them.
    const applied = booted.storage.applied.map((entry) => entry.setId);
    expect(applied[0]).toBe('foundation');
    expect(applied).toContain(REMOTE_MODULE_ID);
    expect(applied.filter((setId) => setId === REMOTE_MODULE_ID)).toHaveLength(1);
    expect(applied.indexOf(REMOTE_MODULE_ID)).toBe(applied.length - 1);

    const rows = booted.storage.db
      .prepare<[], { module: string; version: number }>(
        "SELECT module, version FROM schema_migrations WHERE module = 'remote'",
      )
      .all();
    expect(rows).toEqual([{ module: 'remote', version: 1 }]);

    // And it did what it says: §4.1's audit column now exists.
    const columns = booted.storage.db
      .prepare<[], { name: string }>('PRAGMA table_info(remote_tokens)')
      .all()
      .map((column) => column.name);
    expect(columns).toContain('last_used_peer');
  });

  it('applies nothing on a second boot against the same data root', async () => {
    const first = await bootHome();
    expect(first.storage.applied.map((entry) => entry.setId)).toContain(REMOTE_MODULE_ID);
    await first.shutdown();
    service = undefined;

    const second = await bootHome();
    expect(second.storage.applied).toEqual([]);
    expect(second.storage.setVersions[REMOTE_MODULE_ID]).toBe(1);
    expect(
      second.storage.db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM schema_migrations WHERE module = 'remote'",
        )
        .get()?.n,
    ).toBe(1);
  });
});

describe('M1 — critical: false', () => {
  it('leaves the core running, and marks remote failed, when init throws', async () => {
    const booted = await bootHome({
      remote: {
        ...noTailscale,
        onReady: () => {
          throw new Error('the remote module is broken');
        },
      },
    });

    // The process is alive and the local API answers — which is the whole point of
    // the flag: the owner can reach 127.0.0.1 and fix it (§10.3).
    expect(booted.runtime.phase).toBe('ready');
    expect(exitCodes).toEqual([]);

    const health = await call<{
      status: string;
      modules: { id: string; status: string; error?: string }[];
    }>('GET', '/api/health');
    const remote = health.body.modules.find((module) => module.id === REMOTE_MODULE_ID);
    expect(remote?.status).toBe('failed');
    expect(remote?.error).toContain('the remote module is broken');
    expect(health.body.modules.find((module) => module.id === 'http')?.status).toBe('ok');
    expect(health.body.modules.find((module) => module.id === 'storage')?.status).toBe('ok');

    // A module whose `init` threw published nothing, so it claims no socket — and a
    // home edition with no claim is as closed as the work edition (§6.3).
    expect(booted.bind.remote).toBeNull();
    expect(booted.bind.nonLoopback).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M3 — the listener through the real core
// ---------------------------------------------------------------------------

describe('M3 — Tailscale down at boot, through the real core', () => {
  it('starts the core normally with no socket, and reports remote degraded with the reason', async () => {
    const booted = await bootHome();

    // No non-loopback socket exists, as the process itself reports it.
    expect(nonLoopbackListeners()).toEqual([]);
    expect(booted.bind.remote).toBeNull();
    expect(booted.bind.nonLoopback).toEqual([]);
    // The local API is up and answering, which is what "the core starts normally"
    // has to mean.
    expect(booted.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const health = await call<{
      status: string;
      modules: {
        id: string;
        status: string;
        message?: string;
        detail?: { state: string; bound: boolean; address: string | null };
      }[];
      conditions: { id: string; message: string }[];
    }>('GET', '/api/health');
    const remote = health.body.modules.find((module) => module.id === REMOTE_MODULE_ID);
    expect(remote?.status).toBe('degraded');
    expect(remote?.detail?.state).toBe('waiting');
    expect(remote?.detail?.bound).toBe(false);
    // §2.3's sentence for the local UI, verbatim in shape.
    expect(health.body.conditions.map((condition) => condition.id)).toContain('remote.unavailable');
    expect(
      health.body.conditions.find((condition) => condition.id === 'remote.unavailable')?.message,
    ).toContain('Remote access unavailable — Tailscale is');
  });

  it('reports the backend state the CLI gave, so the user is told which state it is in', async () => {
    const booted = await bootHome({
      remote: {
        detector: {
          detect: () =>
            Promise.resolve({
              ok: false,
              reason: 'backend-not-running',
              message: 'Tailscale is not running: BackendState is "NeedsLogin".',
              backendState: 'NeedsLogin',
              source: 'cli',
            }),
          peerName: () => null,
          peerCount: () => 0,
        },
        timers: neverFires,
      },
    });

    const status = await call<RemoteStatus>('GET', '/api/remote/status');
    expect(status.status).toBe(200);
    expect(status.body.state).toBe('waiting');
    expect(status.body.tailscaleState).toBe('NeedsLogin');
    expect(status.body.lastError).toContain('NeedsLogin');
    expect(status.body.boundAddress).toBeNull();
    expect(booted.bind.remote).toBeNull();
  });
});

describe('M3 — the published claim (§6.3)', () => {
  it('publishes boundAddress() on the registry under the name foundation reads', async () => {
    const booted = await bootHome();
    const published = booted.runtime.registry.require<{ boundAddress: () => unknown }>(
      REMOTE_SERVICE,
    );

    expect(published).toBeDefined();
    expect(published?.boundAddress()).toBeNull();
    // The assertion compared the claim against the sockets the OS reports, and
    // recorded that it did.
    expect(booted.bind.edition).toBe('home');
    expect(booted.bind.remote).toBeNull();
    expect(booted.bind.warnings).toEqual([]);
  });

  it('refuses to bind, and claims nothing, when the detected address is not a Tailscale one', async () => {
    // A LAN address arriving from a subverted detector: the socket is never
    // created, so foundation's assertion has nothing to disagree with.
    const booted = await bootHome({
      remote: { detector: claiming('192.168.0.197'), timers: neverFires },
    });

    expect(nonLoopbackListeners()).toEqual([]);
    expect(booted.bind.remote).toBeNull();
    const status = await call<RemoteStatus>('GET', '/api/remote/status');
    expect(status.body.state).toBe('waiting');
    expect(status.body.lastError).toContain('refusing to bind');
  });
});

describe('M3 — the shared route table (§6.4) and remote’s own routes (§5)', () => {
  it('registers /api/remote/status as remote-allowed and /api/remote/restart as remote-denied', async () => {
    const booted = await bootHome();
    const table = booted.runtime.routes.routes.filter((route) =>
      route.path.startsWith('/api/remote'),
    );

    expect(table.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/remote/tokens/:id',
      'GET /api/remote/agents',
      'GET /api/remote/status',
      'GET /api/remote/tokens',
      'POST /api/remote/restart',
      'POST /api/remote/stream-ticket',
      'POST /api/remote/tokens',
      'PUT /api/remote/agents/:id/access',
      'PUT /api/remote/enabled',
    ]);
    // M7/M8's three: the ticket route and both grant routes are reachable
    // remotely. The grant *write* is §3.2's one deliberate exception to the
    // loosening principle, and it is declared here rather than assumed.
    expect(table.find((route) => route.path === '/api/remote/stream-ticket')?.remote).toBe('allow');
    expect(table.find((route) => route.path === '/api/remote/agents')?.remote).toBe('allow');
    expect(table.find((route) => route.path === '/api/remote/agents/:id/access')?.remote).toBe(
      'allow',
    );
    expect(table.find((route) => route.path === '/api/remote/status')?.remote).toBe('allow');
    // §3.2's loosening principle, declared where the routes are defined: minting a
    // credential and restarting the transport are local-only; listing and revoking
    // are reductions of remote privilege and stay reachable remotely.
    expect(table.find((route) => route.path === '/api/remote/restart')?.remote).toBe('deny');
    expect(
      table.find((route) => route.method === 'POST' && route.path === '/api/remote/tokens')?.remote,
    ).toBe('deny');
    expect(
      table.find((route) => route.method === 'GET' && route.path === '/api/remote/tokens')?.remote,
    ).toBe('allow');
    expect(table.find((route) => route.path === '/api/remote/tokens/:id')?.remote).toBe('allow');
    // Not declarable either way: the *direction* of the change decides, so the
    // body-conditional backstop is the enforcement (§3.2).
    expect(table.find((route) => route.path === '/api/remote/enabled')?.remote).toBe('allow');
    expect(table.every((route) => route.moduleId === REMOTE_MODULE_ID)).toBe(true);
  });

  it('answers POST /api/remote/restart on the local listener by re-running the cycle', async () => {
    await bootHome({ remote: { detector: claiming('192.168.0.197'), timers: neverFires } });

    const before = await call<RemoteStatus>('GET', '/api/remote/status');
    expect(before.body.state).toBe('waiting');

    const restarted = await call<RemoteStatus>('POST', '/api/remote/restart');
    expect(restarted.status).toBe(200);
    // Still refused — the address is still a LAN address — but the cycle ran again
    // and reported its own state rather than a cached one.
    expect(restarted.body.state).toBe('waiting');
    expect(restarted.body.lastError).toContain('refusing to bind');
    expect(nonLoopbackListeners()).toEqual([]);
  });
});

describe('M3 — the settings kill switch (§5)', () => {
  it('binds nothing when the settings key is false, and detection never runs', async () => {
    let detections = 0;
    const booted = await bootHome({
      remote: {
        detector: {
          detect: () => {
            detections += 1;
            return Promise.resolve(claiming('100.101.102.103').detect());
          },
          peerName: () => null,
          peerCount: () => 0,
        },
        timers: neverFires,
      },
      // Written before any module starts, so the first cycle already sees it.
      additionalModules: [
        {
          id: 'fixture-kill-switch',
          dependsOn: ['storage'],
          init(ctx) {
            ctx.registerBootTask(() => {
              ctx.settings.set(REMOTE_ENABLED_SETTING, false);
            }, 'switch-remote-off');
            return {};
          },
        },
      ],
    });

    expect(detections).toBe(0);
    expect(nonLoopbackListeners()).toEqual([]);
    expect(booted.bind.remote).toBeNull();
    const status = await call<RemoteStatus>('GET', '/api/remote/status');
    expect(status.body.enabled).toBe(false);
    expect(status.body.lastError).toContain(REMOTE_ENABLED_SETTING);
  });
});

// ---------------------------------------------------------------------------
// M3 — running sessions are unaffected by any transition (§2.3)
// ---------------------------------------------------------------------------

describe('M3 — running sessions survive every listener transition', () => {
  it(
    'keeps a live session running, and its transcript intact, across repeated bind failures and restarts',
    { timeout: 40_000 },
    async () => {
      // §2.3's most important consequence: "the runner lives in the core process;
      // losing the tailnet loses the *view*, never the work."
      //
      // The transitions are real, not simulated: the detector claims a CGNAT
      // address this machine does not hold, so every cycle reaches the real
      // `http.mount(...).listen()` and fails there — `binding → bind error →
      // waiting`, five times over, ending in `down`, then recovering through
      // `POST /api/remote/restart`. Timers never fire, so the only transitions are
      // the ones this test asks for.
      const held = controllableQuery();
      const booted = await bootHome({
        runner: { query: held.query },
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fixture' },
        remote: { detector: claiming('100.64.0.1'), timers: neverFires },
      });

      const folder = join(workspaceDir.path, 'Surviving');
      mkdirSync(folder, { recursive: true });
      const project = await call<{ id: string }>('POST', '/api/projects', { localPath: folder });
      expect(project.status).toBe(201);
      const agent = await call<{ definition: { id: string } }>('POST', '/api/roster/agents', {
        name: 'Cal Survivor',
        specialty: 'general',
        capabilities: { roles: ['implementer'] },
        personaText: '# Cal\n',
      });
      expect(agent.status).toBe(201);

      const launched = await call<{ sessionId: string }>('POST', '/api/assignments/solo', {
        projectId: project.body.id,
        agentId: agent.body.definition.id,
        prompt: 'hold',
      });
      expect(launched.status).toBe(201);
      await held.started(1);

      const running = await call<{ session: { status: string } }>(
        'GET',
        `/api/sessions/${launched.body.sessionId}`,
      );
      expect(running.body.session.status).toBe('running');
      const transcriptBefore = await call<{ lines: { type: string }[] }>(
        'GET',
        `/api/sessions/${launched.body.sessionId}/transcript`,
      );

      // Five real bind attempts and failures, driving the state machine all the way
      // to `down` — the noisiest thing remote can do to itself.
      const states: string[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const restarted = await call<RemoteStatus>('POST', '/api/remote/restart');
        states.push(restarted.body.state);
        expect(nonLoopbackListeners()).toEqual([]);
      }
      expect(states.every((state) => state === 'waiting' || state === 'down')).toBe(true);

      // The session never noticed.
      const stillRunning = await call<{ session: { status: string } }>(
        'GET',
        `/api/sessions/${launched.body.sessionId}`,
      );
      expect(stillRunning.body.session.status).toBe('running');
      const transcriptAfter = await call<{ lines: { type: string }[] }>(
        'GET',
        `/api/sessions/${launched.body.sessionId}/transcript`,
      );
      expect(transcriptAfter.body.lines).toEqual(transcriptBefore.body.lines);

      // And it finishes normally afterwards, which is the other half of "the work
      // is untouched".
      const live = held.sessions[0];
      expect(live).toBeDefined();
      await live?.emit(fakeAssistant({ text: 'Survived.' }), fakeResult({ text: 'Survived.' }));
      held.endAll();
      const deadline = Date.now() + 20_000;
      let settled: { status: string; exitReason: string | null } | undefined;
      for (;;) {
        const answer = await call<{ session: { status: string; exitReason: string | null } }>(
          'GET',
          `/api/sessions/${launched.body.sessionId}`,
        );
        const session = answer.body.session;
        if (session !== undefined && !['queued', 'running', 'paused'].includes(session.status)) {
          settled = session;
          break;
        }
        if (Date.now() > deadline) throw new Error(`session stuck in ${session?.status ?? '?'}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(settled).toMatchObject({ status: 'done', exitReason: 'completed' });

      // The core itself is unharmed: it is still `ready`, and remote is the only
      // module that is not `ok`.
      expect(booted.runtime.phase).toBe('ready');
      const health = await call<{ modules: { id: string; status: string }[] }>(
        'GET',
        '/api/health',
      );
      const unwell = health.body.modules
        .filter((module) => module.status !== 'ok')
        .map((module) => module.id);
      expect(unwell).toEqual([REMOTE_MODULE_ID]);
    },
  );
});

// ---------------------------------------------------------------------------
// M4 — the plaintext appears in the creation response and nowhere else
// ---------------------------------------------------------------------------

describe('M4 — a minted token’s plaintext reaches no log file and no column', () => {
  it('appears in the creation response only, and in neither core.log, access.log nor the database', async () => {
    // The scanning half of M4's first criterion, and it needs the *real* core: the
    // real logger with its real redaction chain, the real files on disk, and the
    // real SQLite file. A unit test cannot claim this.
    const booted = await bootHome();
    const base = booted.url() ?? '';

    const minted = await call<{ id: string; token: string; prefix: string }>(
      'POST',
      '/api/remote/tokens',
      { label: 'Pixel 9', device: 'Android 15' },
    );
    expect(minted.status).toBe(201);
    const token = minted.body.token;
    expect(token).toHaveLength(43);

    // Exercise every path that could plausibly echo it: a list, the status, a
    // health report, and a request that carries the token as a Bearer header on
    // the *local* listener (which does not authenticate, so the header is pure
    // log fodder — exactly the case foundation §5.4's redaction exists for).
    await call('GET', '/api/remote/tokens');
    await call('GET', '/api/remote/status');
    await call('GET', '/api/health');
    await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } });

    // Flush by shutting the core down: pino's file streams are asynchronous, and a
    // scan of a half-written file would pass for the wrong reason.
    await booted.shutdown();
    service = undefined;

    const logsDir = join(dataRootDir.path, 'state', 'logs');
    for (const file of ['core.log', 'access.log']) {
      const text = readFileSync(join(logsDir, file), 'utf8');
      expect(text.length, file).toBeGreaterThan(0);
      expect(text, file).not.toContain(token);
      // The mint *is* logged — by id and prefix, which is what makes an incident
      // reviewable without making it exploitable.
      if (file === 'core.log') expect(text).toContain(minted.body.id);
    }

    // And the database file, byte for byte: the digest is there, the token is not.
    const database = readFileSync(join(dataRootDir.path, 'state', 'agentmanager.db'));
    expect(database.includes(Buffer.from(token, 'utf8'))).toBe(false);
    expect(
      database.includes(Buffer.from(createHash('sha256').update(token).digest('hex'), 'utf8')),
    ).toBe(true);
  });

  it('does not echo the token when the same label is minted twice', async () => {
    await bootHome();
    const first = await call<{ token: string }>('POST', '/api/remote/tokens', { label: 'Pixel 9' });
    const second = await call<{ token: string }>('POST', '/api/remote/tokens', {
      label: 'Pixel 9',
    });

    // Two devices with the same name is a user's problem, not a collision: each
    // gets its own credential, and neither response mentions the other's.
    expect(first.body.token).not.toBe(second.body.token);
    expect(second.text).not.toContain(first.body.token);

    const listed = await call('GET', '/api/remote/tokens');
    expect(listed.text).not.toContain(first.body.token);
    expect(listed.text).not.toContain(second.body.token);
  });

  it('refuses a mint with no label, and reports the active count in the status', async () => {
    await bootHome();
    const bad = await call<{ error: string }>('POST', '/api/remote/tokens', { device: 'Android' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_request');

    await call('POST', '/api/remote/tokens', { label: 'one' });
    await call('POST', '/api/remote/tokens', { label: 'two' });
    const status = await call<{ activeTokenCount: number }>('GET', '/api/remote/status');
    expect(status.body.activeTokenCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Static assertions over remote's own source (M10 owns the tree-wide versions)
// ---------------------------------------------------------------------------

describe('M3 — remote’s source never binds a socket itself', () => {
  const sources = [
    'index.ts',
    'listener.ts',
    'proxy.ts',
    'tailscale.ts',
    'routes.ts',
    'streamRoutes.ts',
    'tokenRoutes.ts',
    'middleware.ts',
    'policy.ts',
    'gate.ts',
    'grants.ts',
    'rateLimit.ts',
    'streams.ts',
    'tickets.ts',
    'tokens.ts',
    'ports.ts',
    'config.ts',
    'options.ts',
  ];

  it('owns no server of its own, and never passes an address to listen()', () => {
    // M10 asserts tree-wide that "no `listen(` call omits an address argument".
    // Remote's half of that is stronger and is asserted here: it creates no server,
    // and the only `listen()` it calls is the argument-less one on the object
    // foundation's `mount(...)` returned — so the address is decided by `mount`'s
    // validated options and cannot be smuggled in at the call site.
    for (const file of sources) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      expect(text, file).not.toMatch(/createServer/);
      expect(text, file).not.toMatch(/\.listen\(\s*[^)\s]/);
    }
  });

  it('contains no wildcard bind literal outside a test', () => {
    for (const file of sources) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      // `0.0.0.0` and `::` appear only in `assertBindable`'s refusal list, which is
      // a comparison rather than a bind — so the check is that no *string being
      // bound* exists, asserted as "the literal appears only next to a refusal".
      for (const match of text.matchAll(/'0\.0\.0\.0'/g)) {
        const line = text.slice(0, match.index).split('\n').length;
        const source = text.split('\n')[line - 1] ?? '';
        expect(source, `${file}:${String(line)}`).toMatch(/value === |wildcard/);
      }
    }
  });

  it('reads no edition anywhere — D6 is satisfied by not being loaded', () => {
    for (const file of sources) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      // Comments name the editions constantly; code must not branch on them.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/config\.edition|edition ===/);
    }
  });
});

// ---------------------------------------------------------------------------
// The hard deny, end to end (M3's placeholder policy)
// ---------------------------------------------------------------------------

describe('M4/M6 — the real policy chain is wired into the mounted listener', () => {
  it('puts §3.1/§9.2’s three middlewares in front of the remote listener', async () => {
    // The socket cannot be bound without a tailnet, so the wiring is asserted where
    // it is decided: the module hands foundation's `mount` the chain of §9.2 #6
    // (peer guard), §9.2 #8 (`Host` allowlist) and §3.1 (the route policy).
    // `policy.test.ts` and `auth.test.ts` prove what each of them does over a real
    // socket. The count is asserted because the *order* is the security property —
    // peer before routing, deny before auth — and a chain that quietly lost a link
    // would still answer every happy-path test.
    const mounts: { middleware: number }[] = [];
    await bootHome({
      remote: {
        detector: claiming('100.64.0.1'),
        timers: neverFires,
      },
      additionalModules: [
        {
          id: 'fixture-mount-spy',
          dependsOn: ['http'],
          init(ctx) {
            const http = ctx.require<{
              mount: (options: { middleware?: readonly unknown[] }) => unknown;
            }>('http');
            const original = http?.mount.bind(http);
            if (http !== undefined && original !== undefined) {
              http.mount = (options) => {
                mounts.push({ middleware: options.middleware?.length ?? 0 });
                return original(options);
              };
            }
            return {};
          },
        },
      ],
    });

    // One mount attempt, with three middlewares.
    expect(mounts).toEqual([{ middleware: 3 }]);
  });
});

// ---------------------------------------------------------------------------
// D5's proxy bind mode, through the real composition root
// ---------------------------------------------------------------------------

/** A machine whose only external IPv4 is a fixture LAN address nobody holds. */
function lanDetect(address: string): NonNullable<NonNullable<BootOptions['remote']>['detect']> {
  return {
    locateCli: () => undefined,
    networkInterfaces: () => ({
      Loopback: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
      Ethernet: [
        {
          address,
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:11:22:33:44:55',
          internal: false,
          cidr: `${address}/24`,
        },
      ],
    }),
  };
}

/**
 * A fixture LAN address this machine certainly does not hold.
 *
 * The prover is fed an interface list that *claims* it, so the module reaches the
 * real `mount(...).listen()` and fails there — which is exactly the observation
 * these tests want: proxy mode got as far as asking foundation to bind the
 * declared address, and left no socket behind.
 */
const UNBINDABLE_LAN = '192.168.253.253';

const proxyArgs = (bind: string, peers: readonly string[] = ['192.168.253.9']): string[] => [
  '--set',
  'remote.bind=proxy',
  '--set',
  `remote.proxy=${JSON.stringify({ bind, allowedPeers: peers })}`,
];

describe('D5 amendment — proxy mode through the real core', () => {
  it('asks foundation to mount the declared LAN address with origin remote, and leaves no socket', async () => {
    const mounts: { bind: string; port: number; origin: string; middleware: number }[] = [];
    const booted = await bootHome({
      argv: proxyArgs(UNBINDABLE_LAN),
      remote: { detect: lanDetect(UNBINDABLE_LAN), timers: neverFires },
      additionalModules: [
        {
          id: 'fixture-proxy-mount-spy',
          dependsOn: ['http'],
          init(ctx) {
            const http = ctx.require<{
              mount: (options: {
                bind: string;
                port: number;
                origin: string;
                middleware?: readonly unknown[];
              }) => unknown;
            }>('http');
            const original = http?.mount.bind(http);
            if (http !== undefined && original !== undefined) {
              http.mount = (options) => {
                mounts.push({
                  bind: options.bind,
                  port: options.port,
                  origin: options.origin,
                  middleware: options.middleware?.length ?? 0,
                });
                return original(options);
              };
            }
            return {};
          },
        },
      ],
    });

    // The one mount attempt is on the declared LAN address — never a wildcard,
    // never the Tailscale range, never loopback — with the same three-middleware
    // chain tailscale mode gets.
    expect(mounts).toEqual([{ bind: UNBINDABLE_LAN, port: 7478, origin: 'remote', middleware: 3 }]);
    // `listen()` failed (this host does not hold that address), so nothing is bound
    // and nothing is claimed.
    expect(nonLoopbackListeners()).toEqual([]);
    expect(booted.bind.remote).toBeNull();
    expect(booted.bind.nonLoopback).toEqual([]);

    const status = await call<RemoteStatus>('GET', '/api/remote/status');
    expect(status.body.mode).toBe('proxy');
    expect(status.body.state).toBe('waiting');
    expect(status.body.boundAddress).toBeNull();
  });

  it('stays in waiting, with no socket, when the machine does not hold the declared address', async () => {
    const booted = await bootHome({
      argv: proxyArgs('192.168.254.254'),
      // The interface list holds a *different* LAN address, so the prover refuses.
      remote: { detect: lanDetect(UNBINDABLE_LAN), timers: neverFires },
    });

    expect(nonLoopbackListeners()).toEqual([]);
    expect(booted.bind.remote).toBeNull();

    const status = await call<RemoteStatus>('GET', '/api/remote/status');
    expect(status.body.mode).toBe('proxy');
    expect(status.body.state).toBe('waiting');
    expect(status.body.lastError).toContain('no interface on this machine holds');
    expect(status.body.detectionSource).toBe('proxy');
    // No Tailscale fact is invented, and none is looked for.
    expect(status.body.magicDnsName).toBeNull();
    expect(status.body.tailscaleState).toBe('not applicable (proxy mode)');

    // And the health condition does not tell the owner to check Tailscale on a
    // machine where Tailscale deliberately is not installed.
    const health = await call<{ conditions: { id: string; message: string }[] }>(
      'GET',
      '/api/health',
    );
    const condition = health.body.conditions.find((entry) => entry.id === 'remote.unavailable');
    expect(condition?.message).toContain('declared LAN address');
    expect(condition?.message).not.toContain('Tailscale is');
  });

  it('spawns no subprocess and locates no Tailscale CLI in proxy mode', async () => {
    let cliLookups = 0;
    await bootHome({
      argv: proxyArgs(UNBINDABLE_LAN),
      remote: {
        detect: {
          ...lanDetect(UNBINDABLE_LAN),
          locateCli: () => {
            cliLookups += 1;
            return undefined;
          },
        },
        timers: neverFires,
      },
    });

    // Detection is skipped entirely: the tailnet-membership gate lives on the
    // proxy host in this mode, so there is nothing here to ask Tailscale about.
    expect(cliLookups).toBe(0);
  });

  it('leaves the work edition exactly as closed as before — no listener of any mode', async () => {
    // The proxy block is present in configuration and the edition still refuses to
    // load the module at all, which is D6 unchanged by the amendment.
    const booted = await bootCore({ argv: proxyArgs(UNBINDABLE_LAN) });

    expect(booted.config.edition).toBe('work');
    expect(booted.config.remote.bind).toBe('proxy');
    expect(booted.config.modules.remote.enabled).toBe(false);
    expect(booted.runtime.order).not.toContain(REMOTE_MODULE_ID);
    expect(booted.runtime.registry.require(REMOTE_SERVICE)).toBeUndefined();
    expect(nonLoopbackListeners()).toEqual([]);
    expect(booted.bind.nonLoopback).toEqual([]);
    expect((await call('GET', '/api/remote/status')).status).toBe(404);
  });
});
