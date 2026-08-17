/**
 * The HTTP surface, end to end (foundation IMPLEMENTATION §8).
 *
 * Every assertion here is made against a real listener on an ephemeral port,
 * booted through the real composition root with a temp data root — because M8's
 * acceptance criteria are all statements about what a client observes.
 *
 * Acceptance covered, criterion by criterion:
 * - "`/healthz` returns 200 with `{status, version, edition, uptime}` in under
 *   50 ms" — *healthz*.
 * - "`/api/health` aggregates every registered module health check and reports
 *   degraded modules individually" — *api/health*.
 * - "`/api/config/effective` shows each key's winning layer and contains no
 *   secret values" — *api/config/effective*.
 * - "`/api/logs` filters by level, component and `sessionId`;
 *   `/api/logs/stream` delivers a record emitted after subscription within
 *   1 s" — *api/logs*.
 * - "`/api/events?since=<id>` replays missed events in order, then the live
 *   stream continues without a gap or duplicate" — *api/events*.
 * - "Every request appears in `access.log` with method, path, status, duration
 *   and origin" — *access logging*.
 * - The SPA fallback, the JSON 404 for `/api/**`, and `remote: 'deny'` plus the
 *   graceful stop on `POST /api/service/shutdown` — *static SPA route* and
 *   *api/service/shutdown*.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LogRecord } from '../logging/index.js';
import type { HealthReport, Module } from '../modules/index.js';

import { boot, readVersion, type BootOptions, type BootedService } from '../main.js';

import { call, makeTempDir, openStream, repoRoot, type TempDir } from './__tests__/helpers.js';
import type { HttpService } from './module.js';
import { HTTP_SERVICE } from './module.js';

/** Planted credential material; none of it may appear in any response. */
const PLANTED_TOKEN = 'ghp_PLANTEDsupportTOKENvalue0123456789';
const PLANTED_ANTHROPIC = 'sk-ant-oat01-PLANTEDoauthTOKENvalue0123456789';
const PLANTED_BEARER = 'PLANTEDbearerCREDENTIALvalue012345';

let temp: TempDir;
let service: BootedService | undefined;
let base: string;

/**
 * A module that is deliberately unhealthy, so aggregation has something to
 * report. It borrowed the `orchestrator` id while that element did not exist;
 * now that it does, the fixture has its own.
 */
const degradedModule: Module = {
  id: 'fixture-degraded',
  dependsOn: [],
  init(ctx) {
    ctx.registerHealthCheck(
      (): HealthReport => ({
        status: 'degraded',
        message: 'the fixture check is unhappy',
        conditions: [
          { id: 'fixture.check', level: 'warn', message: 'a registered check raised this' },
        ],
      }),
      'fixture-check',
    );
    return {
      health: (): HealthReport => ({
        status: 'degraded',
        message: 'the fixture module is degraded',
        conditions: [{ id: 'fixture.module', level: 'warn', message: 'module-level condition' }],
        detail: { queueDepth: 3 },
      }),
    };
  },
};

async function bootApi(options: BootOptions = {}): Promise<BootedService> {
  const booted = await boot({
    installRoot: repoRoot,
    dataRoot: temp.path,
    env: {},
    pretty: false,
    tightenAcl: false,
    acl: { run: () => {} },
    exit: () => {},
    ...options,
    // Ephemeral port: the schema requires a real port number (and should), so
    // the test seam is a boot option rather than configuration.
    http: { port: 0, heartbeatMs: 0, ...options.http },
    // The home-edition case below loads the real remote module, whose detector
    // would otherwise read this machine's adapters. Injected so no test run binds
    // a socket beyond loopback, on any developer's box.
    remote: {
      detect: { locateCli: () => undefined, networkInterfaces: () => ({}) },
      ...options.remote,
    },
    argv: ['--set', 'secrets.provider=env', ...(options.argv ?? [])],
  });
  service = booted;
  const url = booted.url();
  expect(url).toBeDefined();
  base = url ?? '';
  return booted;
}

function accessLines(): LogRecord[] {
  return readFileSync(join(temp.path, 'state', 'logs', 'access.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogRecord);
}

beforeEach(() => {
  temp = makeTempDir();
});

afterEach(async () => {
  await service?.shutdown().catch(() => undefined);
  service = undefined;
  temp.cleanup();
});

// ---------------------------------------------------------------------------

describe('healthz', () => {
  it('returns status, version, edition and uptime in under 50 ms', async () => {
    const booted = await bootApi();

    // One warm-up request, so the measurement is of the endpoint rather than of
    // the first TCP connection the process has ever made.
    await call(base, '/healthz');

    const started = performance.now();
    const answer = await call<Record<string, unknown>>(base, '/healthz');
    const elapsed = performance.now() - started;

    expect(answer.status).toBe(200);
    expect(answer.body['status']).toBe('ok');
    expect(answer.body['version']).toBe(readVersion());
    expect(answer.body['edition']).toBe(booted.config.edition);
    expect(answer.body['edition']).toBe('work');
    expect(typeof answer.body['uptime']).toBe('number');
    expect(answer.body['uptime']).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(50);
  });

  it('echoes a request id header on every response', async () => {
    await bootApi();
    const answer = await call(base, '/healthz');
    expect(answer.headers.get('x-request-id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('answers HEAD from the same route, with no body', async () => {
    await bootApi();
    const response = await fetch(`${base}/healthz`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('refuses a method the path does not accept, naming the ones it does', async () => {
    await bootApi();
    const answer = await call<{ error: string }>(base, '/api/logs/level', { method: 'DELETE' });
    expect(answer.status).toBe(405);
    expect(answer.body.error).toBe('method_not_allowed');
    expect(answer.headers.get('allow')).toBe('PUT');
  });
});

describe('api/health', () => {
  it('aggregates every module and reports degraded ones individually', async () => {
    await bootApi({ additionalModules: [degradedModule] });

    const answer = await call<{
      status: string;
      modules: { id: string; status: string; message?: string; conditions: { id: string }[] }[];
      conditions: { id: string }[];
    }>(base, '/api/health');

    expect(answer.status).toBe(200);
    expect(answer.body.modules.map((module) => module.id)).toEqual([
      'storage',
      'secrets',
      'http',
      'roster',
      'projects',
      'runner',
      'orchestrator',
      'fixture-degraded',
    ]);

    const degraded = answer.body.modules.find((module) => module.id === 'fixture-degraded');
    expect(degraded?.status).toBe('degraded');
    // Both the module's own `health()` and its registered check are folded in.
    expect(degraded?.conditions.map((condition) => condition.id).sort()).toEqual([
      'fixture.check',
      'fixture.module',
    ]);

    // The rest of the service stays individually healthy...
    expect(answer.body.modules.find((module) => module.id === 'storage')?.status).toBe('ok');
    expect(answer.body.modules.find((module) => module.id === 'http')?.status).toBe('ok');
    // ...while the aggregate says the service as a whole is not fully well.
    expect(answer.body.status).toBe('degraded');
    expect(answer.body.conditions.map((condition) => condition.id)).toContain('fixture.check');
  });

  it('carries the secrets degradation and the ANTHROPIC_API_KEY condition', async () => {
    await bootApi({
      argv: ['--edition', 'home'],
      env: { ANTHROPIC_API_KEY: PLANTED_ANTHROPIC },
    });

    const answer = await call<{ conditions: { id: string }[] }>(base, '/api/health');
    expect(answer.body.conditions.map((condition) => condition.id)).toContain(
      'secrets.anthropicApiKeyOverridesSubscription',
    );
    // §3.5: the value that triggered it never travels with the condition.
    expect(answer.text).not.toContain(PLANTED_ANTHROPIC);
  });
});

describe('api/config/effective', () => {
  it('annotates every key with the layer that won it', async () => {
    await bootApi({
      env: { AGENTMANAGER_LOGGING_LEVEL: 'debug' },
      argv: ['--set', 'runner.maxConcurrent=5'],
    });

    const answer = await call<{
      edition: string;
      config: { runner: { maxConcurrent: number }; logging: { level: string } };
      sources: Record<string, { layer: string; origin: string }>;
      layers: string[];
    }>(base, '/api/config/effective');

    expect(answer.status).toBe(200);
    expect(answer.body.edition).toBe('work');
    expect(answer.body.layers).toEqual(['defaults', 'edition', 'machine', 'env', 'cli']);

    // Each of the three layers that actually set something is attributed.
    expect(answer.body.sources['http.port']?.layer).toBe('defaults');
    expect(answer.body.sources['logging.level']?.layer).toBe('env');
    expect(answer.body.sources['logging.level']?.origin).toContain('AGENTMANAGER_LOGGING_LEVEL');
    expect(answer.body.sources['runner.maxConcurrent']?.layer).toBe('cli');
    expect(answer.body.config.runner.maxConcurrent).toBe(5);
    expect(answer.body.config.logging.level).toBe('debug');
  });

  it('contains no secret material, however it reached the configuration', async () => {
    await bootApi({
      env: { ANTHROPIC_API_KEY: PLANTED_ANTHROPIC },
      argv: [
        // A credential under a name the key-path rules recognise…
        '--set',
        `agentEnv.SUPPORT_TOKEN=${PLANTED_TOKEN}`,
        // …one parked under a name they do not, caught by the pattern scrub…
        '--set',
        `agentEnv.NOTES=sk-ant-oat01-${PLANTED_ANTHROPIC}`,
        // …and one shaped like an Authorization header.
        '--set',
        `agentEnv.HEADER=Bearer ${PLANTED_BEARER}`,
      ],
    });

    const answer = await call<{
      config: { agentEnv: Record<string, string> };
      sources: Record<string, { layer: string; origin: string }>;
    }>(base, '/api/config/effective');

    // The scan the acceptance criterion asks for: the raw response text.
    expect(answer.text).not.toContain(PLANTED_TOKEN);
    expect(answer.text).not.toContain(PLANTED_ANTHROPIC);
    expect(answer.text).not.toContain(PLANTED_BEARER);

    // The keys and their attribution survive — this is a support diagnostic, so
    // "a value was set here, by this layer" must still be readable.
    expect(answer.body.config.agentEnv['SUPPORT_TOKEN']).toBe('[redacted]');
    expect(answer.body.config.agentEnv['NOTES']).toContain('[redacted]');
    expect(answer.body.config.agentEnv['HEADER']).toContain('[redacted]');
    expect(answer.body.sources['agentEnv.SUPPORT_TOKEN']?.layer).toBe('cli');
    // The attribution names the key that was set, never the value it was set to.
    expect(answer.body.sources['agentEnv.SUPPORT_TOKEN']?.origin).toBe(
      'cli:--set agentEnv.SUPPORT_TOKEN',
    );
  });

  it('keeps the auth mode and the secret provider readable, since neither is a credential', async () => {
    await bootApi();
    const answer = await call<{
      config: { auth: { mode: string }; secrets: { provider: string } };
    }>(base, '/api/config/effective');

    // §4.4's health script reports both; blanket key-path redaction of the
    // namespaces named `auth` and `secrets` would take them away.
    expect(answer.body.config.auth.mode).toBe('env');
    expect(answer.body.config.secrets.provider).toBe('env');
  });
});

describe('api/logs', () => {
  it('filters by level, component and sessionId', async () => {
    const booted = await bootApi();
    booted.logging.child('fixture-a').info('alpha');
    booted.logging.child('fixture-b', { sessionId: 'S-TEST' }).warn('beta');

    const byComponent = await call<{ records: LogRecord[]; source: string }>(
      base,
      '/api/logs?component=fixture-a',
    );
    expect(byComponent.body.source).toBe('ring');
    expect(byComponent.body.records.map((record) => record.msg)).toEqual(['alpha']);

    const byLevel = await call<{ records: LogRecord[] }>(base, '/api/logs?level=warn');
    const messages = byLevel.body.records.map((record) => record.msg);
    expect(messages).toContain('beta');
    expect(messages).not.toContain('alpha');

    const bySession = await call<{ records: LogRecord[] }>(base, '/api/logs?sessionId=S-TEST');
    expect(bySession.body.records.map((record) => record.msg)).toEqual(['beta']);
  });

  it('rejects an unusable filter rather than guessing at it', async () => {
    await bootApi();
    const answer = await call<{ error: string; parameter: string }>(base, '/api/logs?level=loud');
    expect(answer.status).toBe(400);
    expect(answer.body.parameter).toBe('level');
  });

  it('falls back to the log files when since predates the ring buffer', async () => {
    const booted = await bootApi();
    booted.logging.child('fixture-old').info('written to disk');

    const answer = await call<{ records: LogRecord[]; source: string }>(
      base,
      '/api/logs?since=2000-01-01T00:00:00.000Z&component=fixture-old',
    );
    expect(answer.body.source).toBe('files');
    expect(answer.body.records.map((record) => record.msg)).toEqual(['written to disk']);
  });

  it('delivers a record emitted after subscription within a second', async () => {
    const booted = await bootApi();
    const stream = openStream(`${base}/api/logs/stream?component=fixture-stream`);
    await stream.connected;

    booted.logging.child('fixture-stream').info('live record');

    const frames = await stream.waitFor(1, 'log', 1000);
    expect((frames[0]?.data as LogRecord | undefined)?.msg).toBe('live record');
    stream.close();
  });

  it('changes the level at runtime, without a restart', async () => {
    const booted = await bootApi();
    expect(booted.logging.getLevel()).toBe('info');

    const answer = await call<{ level: string; previous: string }>(base, '/api/logs/level', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'debug' }),
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ level: 'debug', previous: 'info' });
    expect(booted.logging.getLevel()).toBe('debug');

    // The change reaches loggers made before it, which is the point (§5.3).
    const child = booted.logging.child('fixture-level');
    child.debug('now visible');
    const records = await call<{ records: LogRecord[] }>(
      base,
      '/api/logs?component=fixture-level&level=debug',
    );
    expect(records.body.records.map((record) => record.msg)).toEqual(['now visible']);

    const rejected = await call<{ error: string }>(base, '/api/logs/level', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'shouty' }),
    });
    expect(rejected.status).toBe(400);
  });

  it('downloads the current log files as a zip', async () => {
    await bootApi();
    const response = await fetch(`${base}/api/logs/download`);
    const archive = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toContain('agentmanager-logs-');
    // Local file header signature, then both stream names in the directory.
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archive.toString('latin1')).toContain('core.log');
    expect(archive.toString('latin1')).toContain('access.log');
  });
});

describe('api/events', () => {
  it('replays missed events in order, then continues live with no gap or duplicate', async () => {
    const booted = await bootApi();
    const bus = booted.runtime.bus;

    const first = bus.emit({ type: 'fixture.one', persist: true, payload: { n: 1 } });
    bus.emit({ type: 'fixture.two', persist: true, payload: { n: 2 } });
    expect(first.id).toBeDefined();

    const stream = openStream(`${base}/api/events?since=${first.id ?? ''}&types=fixture.*`);
    // Emitted while the connection is being made: it must arrive exactly once,
    // whether the replay query or the live subscription happens to catch it.
    bus.emit({ type: 'fixture.three', persist: true, payload: { n: 3 } });

    await stream.waitFor(1, 'replay-complete');
    bus.emit({ type: 'fixture.four', persist: true, payload: { n: 4 } });

    const frames = await stream.waitFor(3, 'event');
    expect(frames.map((frame) => (frame.data as { type: string }).type)).toEqual([
      'fixture.two',
      'fixture.three',
      'fixture.four',
    ]);
    // Ids are the SSE `id:` field, so an EventSource reconnect resumes correctly.
    expect(frames.every((frame) => typeof frame.id === 'string')).toBe(true);
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(3);
    stream.close();
  });

  it('applies the types filter identically to the replay and to the live stream', async () => {
    const booted = await bootApi();
    const bus = booted.runtime.bus;

    bus.emit({ type: 'fixture.kept', persist: true });
    bus.emit({ type: 'other.dropped', persist: true });

    const stream = openStream(`${base}/api/events?types=fixture.*`);
    await stream.waitFor(1, 'replay-complete');
    bus.emit({ type: 'other.also-dropped', persist: true });
    bus.emit({ type: 'fixture.live', persist: true });

    const frames = await stream.waitFor(2, 'event');
    expect(frames.map((frame) => (frame.data as { type: string }).type)).toEqual([
      'fixture.kept',
      'fixture.live',
    ]);
    stream.close();
  });

  it('streams non-persisted events too, which carry no id and cannot be replayed', async () => {
    const booted = await bootApi();
    const stream = openStream(`${base}/api/events?types=fixture.*`);
    await stream.waitFor(1, 'replay-complete');

    booted.runtime.bus.emit({ type: 'fixture.delta', payload: { chunk: 'x' } });

    const frames = await stream.waitFor(1, 'event');
    expect((frames[0]?.data as { persist: boolean }).persist).toBe(false);
    expect(frames[0]?.id).toBeUndefined();
    stream.close();
  });
});

describe('static SPA route', () => {
  it('serves the shipped bundle at the root', async () => {
    await bootApi();
    const answer = await call(base, '/');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toContain('text/html');
    expect(answer.text).toContain('AgentManager');
  });

  it('falls back to index.html for an unknown non-API GET', async () => {
    await bootApi();
    // orchestrator's ntfy deep link shape: a cold GET of a client-side route.
    const answer = await call(base, '/questions/01JABCDEF');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toContain('text/html');
    expect(answer.text).toContain('AgentManager');
  });

  it('keeps /api/** out of the fallback: an unknown API path is a JSON 404', async () => {
    await bootApi();

    const missing = await call<{ error: string; path: string }>(base, '/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('json');
    expect(missing.body.error).toBe('not_found');
    expect(missing.body.path).toBe('/api/nope');

    // A method with no route at all takes the router's own 404, with the same body.
    const posted = await call<{ error: string }>(base, '/api/nope', { method: 'POST' });
    expect(posted.status).toBe(404);
    expect(posted.body.error).toBe('not_found');
  });

  it('refuses to serve anything outside the bundle directory', async () => {
    await bootApi();
    const answer = await call(base, '/../package.json');
    // Traversal cannot escape: the request either normalises away or falls back.
    expect(answer.text).not.toContain('"devDependencies"');
  });
});

describe('the route table', () => {
  it('holds exactly foundation’s v1 surface, all registered by the http module', async () => {
    const booted = await bootApi();
    // §6.4's inventory: "/healthz, /api/health, /api/config/effective,
    // /api/logs*, /api/service/shutdown, /api/events […] and the static SPA
    // route". Pinned so a route cannot appear or vanish unremarked.
    // Filtered to `http`'s own: feature modules register on the same table
    // (§6.4), and this assertion is about foundation's surface, not theirs.
    expect(
      booted.runtime.routes
        .byModule('http')
        .map((route) => `${route.method} ${route.path} ${route.remote}`),
    ).toEqual([
      'GET /healthz allow',
      'GET /api/health allow',
      'GET /api/config/effective allow',
      'GET /api/logs allow',
      'GET /api/logs/stream allow',
      'GET /api/logs/download allow',
      'PUT /api/logs/level allow',
      'GET /api/events allow',
      'POST /api/service/shutdown deny',
      'GET /* allow',
    ]);
    expect(booted.runtime.routes.byModule('http')).toHaveLength(10);
  });
});

describe('api/service/shutdown', () => {
  it('is registered remote: deny', async () => {
    const booted = await bootApi();
    const route = booted.runtime.routes.find('POST', '/api/service/shutdown');
    expect(route?.remote).toBe('deny');
    expect(route?.moduleId).toBe('http');
    // Everything else foundation registers defaults to allow (§6.4).
    expect(booted.runtime.routes.deniedRemotely().map((entry) => entry.path)).toEqual([
      '/api/service/shutdown',
    ]);
  });

  it('answers 202 and then runs the graceful stop path', async () => {
    const booted = await bootApi();

    const answer = await call<{ status: string; reason: string }>(base, '/api/service/shutdown', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test' }),
    });

    expect(answer.status).toBe(202);
    expect(answer.body).toMatchObject({ status: 'stopping', reason: 'test' });

    const deadline = Date.now() + 5000;
    while (booted.runtime.phase !== 'stopped' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(booted.runtime.phase).toBe('stopped');
    expect(booted.url()).toBeUndefined();
    service = undefined;
  });
});

describe('access logging', () => {
  it('writes one line per request with method, path, status, duration and origin', async () => {
    await bootApi();
    await call(base, '/healthz');
    await call(base, '/api/nope');

    const lines = accessLines();
    const healthz = lines.find((line) => line['path'] === '/healthz');
    expect(healthz).toMatchObject({
      component: 'access',
      msg: 'request',
      method: 'GET',
      path: '/healthz',
      status: 200,
      origin: 'local',
    });
    expect(typeof healthz?.['durationMs']).toBe('number');
    expect(healthz?.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // Failures are logged too, with the status they actually returned.
    expect(lines.find((line) => line['path'] === '/api/nope')?.['status']).toBe(404);
    // Exactly one component key per line — the M3 duplicate this milestone fixed.
    const raw = readFileSync(join(temp.path, 'state', 'logs', 'access.log'), 'utf8');
    for (const line of raw.split('\n').filter(Boolean)) {
      expect(line.split('"component"')).toHaveLength(2);
    }
  });

  it('scrubs a credential-bearing query parameter out of the logged URL', async () => {
    await bootApi();
    await call(base, `/healthz?ticket=${PLANTED_BEARER}`);

    const raw = readFileSync(join(temp.path, 'state', 'logs', 'access.log'), 'utf8');
    expect(raw).not.toContain(PLANTED_BEARER);
    expect(raw).toContain('ticket=[redacted]');
  });
});

describe('the mount point remote reuses', () => {
  it('mounts the same route table on a second listener with its own origin and middleware', async () => {
    const booted = await bootApi();
    const http = booted.runtime.registry.require<HttpService>(HTTP_SERVICE);
    expect(http).toBeDefined();

    // Exactly what the remote module will do (§6.4): same table, second server,
    // bearer middleware in front, `origin: 'remote'` on the context.
    const second = http!.mount({
      bind: '127.0.0.1',
      port: 0,
      origin: 'remote',
      name: 'remote-fixture',
      logger: booted.logging.child('remote-fixture'),
      accessLogger: booted.logging.accessLogger,
      heartbeatMs: 0,
      middleware: [
        (req, res) => {
          if (req.route?.remote === 'deny') {
            return res.error(404, 'not_found', 'This route is not available remotely.');
          }
          if (req.headers['authorization'] !== `Bearer ${PLANTED_BEARER}`) {
            return res.error(401, 'unauthorized', 'A bearer token is required.');
          }
          req.attributeToken('token-fixture-1');
          return undefined;
        },
      ],
    });

    try {
      const address = await second.listen();
      const remoteBase = `http://127.0.0.1:${String(address.port)}`;

      const anonymous = await call(remoteBase, '/healthz');
      expect(anonymous.status).toBe(401);

      const authorised = await call<{ status: string }>(remoteBase, '/healthz', {
        headers: { authorization: `Bearer ${PLANTED_BEARER}` },
      });
      expect(authorised.status).toBe(200);
      expect(authorised.body.status).toBe('ok');

      // The route registered `remote: 'deny'` is refused by the consumer of the
      // metadata, not by foundation (§6.4).
      const denied = await call(remoteBase, '/api/service/shutdown', {
        method: 'POST',
        headers: { authorization: `Bearer ${PLANTED_BEARER}` },
      });
      expect(denied.status).toBe(404);
      expect(booted.runtime.phase).toBe('ready');

      const remoteLines = accessLines().filter((line) => line['origin'] === 'remote');
      expect(remoteLines.length).toBeGreaterThanOrEqual(3);
      expect(remoteLines.find((line) => line['status'] === 401)?.level).toBe('warn');
      expect(remoteLines.find((line) => line['status'] === 200)?.['tokenId']).toBe(
        'token-fixture-1',
      );
      // The token itself never reaches the log (§5.1, §5.4).
      expect(JSON.stringify(remoteLines)).not.toContain(PLANTED_BEARER);
    } finally {
      await second.close();
    }
  });
});
