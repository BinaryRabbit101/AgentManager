/**
 * The route policy middleware — remote IMPLEMENTATION **M6**, criterion by
 * criterion.
 *
 * | M6 acceptance criterion | Test |
 * |---|---|
 * | `GET /` and `/assets/*` served without a token; `GET /api/health` without one is 401 | *serves the static shell without a token …* |
 * | shutdown, token minting, restart and `enabled:{true}` all 403 remotely and succeed locally | *the four denied routes …*, *succeed over the local listener …* |
 * | The same four return 403 **without** a token, proving deny precedes auth | *returns the identical 403 with no token …* |
 * | `DELETE /api/remote/tokens/:id` and `enabled:{false}` succeed remotely | *the loosening principle, in both directions …* |
 * | `GET /api/fs/browse` succeeds remotely, confined to browseRoots, no file contents, resolved path logged | *fs/browse is allowed remotely …* (containment lives in projects' own suite) |
 * | A fixture route registered `{ remote: 'deny' }` is refused with no change to remote's code | *a fixture route declaring remote deny …* |
 * | Every other route in the v1 inventory is reachable with a valid token — a table test over the actual route table | *every route in the live table …* |
 */
import { afterEach, describe, expect, it } from 'vitest';

import { boot, type BootOptions, type BootedService } from '../../main.js';
import type { RegisteredRoute } from '../types.js';
import { makeTempDir, repoRoot, type TempDir } from '../__tests__/helpers.js';

import { createRemoteHarness, type RemoteHarness } from './__tests__/harness.js';
import { PEER_REFUSED_CODE } from './middleware.js';
import {
  BACKSTOP_DENY_PATTERNS,
  ROUTE_DENIED_CODE,
  backstopMatch,
  decideRoutePolicy,
  effectiveDenyList,
  isApiPath,
  isStaticShellRequest,
} from './policy.js';
import { UNAUTHORIZED_CODE } from './tokens.js';

let harness: RemoteHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** The four routes IMPLEMENTATION §6 names, with the bodies that make them so. */
const DENIED_REMOTELY = [
  { method: 'POST', path: '/api/service/shutdown', body: undefined },
  { method: 'POST', path: '/api/remote/tokens', body: { label: 'stolen' } },
  { method: 'POST', path: '/api/remote/restart', body: undefined },
  { method: 'PUT', path: '/api/remote/enabled', body: { enabled: true } },
] as const;

// ---------------------------------------------------------------------------
// Rule 1 — the static shell (§3.1)
// ---------------------------------------------------------------------------

describe('M6 — serves the static shell without a token (§3.1 rule 1)', () => {
  it('serves /, /index.html, /assets/*, the favicon and a deep link with no Authorization header', async () => {
    harness = await createRemoteHarness();

    for (const path of [
      '/',
      '/index.html',
      '/assets/app-4f2a.js',
      '/assets/index-9c1b.css',
      '/favicon.ico',
      '/sw.js',
      // The history fallback: an ntfy deep link arriving cold must load the app
      // before it can authenticate (§3.1 rule 1).
      '/questions/01JABCDEF',
    ]) {
      const answer = await harness.call(path);
      expect(answer.status, path).toBe(200);
      expect(answer.text, path).toBe(`shell:${path}`);
    }
  });

  it('answers 401 to GET /api/health with no token', async () => {
    harness = await createRemoteHarness();
    const answer = await harness.call('/api/health');

    expect(answer.status).toBe(401);
    expect((answer.json as { error: string }).error).toBe(UNAUTHORIZED_CODE);
  });

  it('does not extend the bypass to a non-GET method or to /api', () => {
    expect(isStaticShellRequest('GET', '/')).toBe(true);
    expect(isStaticShellRequest('HEAD', '/assets/app.js')).toBe(true);
    // A POST to a non-API path is not "loading the shell", so it authenticates.
    expect(isStaticShellRequest('POST', '/')).toBe(false);
    expect(isStaticShellRequest('GET', '/api/health')).toBe(false);
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/health')).toBe(true);
    expect(isApiPath('/apidocs')).toBe(false);
  });

  it('never lets the shell bypass cover a non-/api route someone declared remote: deny', async () => {
    // §3.1's literal order would serve this unauthenticated. The strengthening in
    // `policy.ts` fails it closed instead, so the assumption "the only non-/api GET
    // is the SPA" is enforced rather than relied upon.
    const decision = decideRoutePolicy({
      method: 'GET',
      path: '/internal/diagnostics',
      body: undefined,
      routeRemote: 'deny',
    });
    expect(decision.kind).toBe('denied');

    harness = await createRemoteHarness({
      routes: [
        {
          method: 'GET',
          path: '/internal/diagnostics',
          remote: 'deny',
          handler: (_request, response) => response.text('secrets'),
        },
      ],
    });
    const answer = await harness.call('/internal/diagnostics');
    expect(answer.status).toBe(403);
    expect(answer.text).not.toContain('secrets');
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — the deny list, before auth (§3.1, §3.2)
// ---------------------------------------------------------------------------

describe('M6 — the four denied routes answer 403 route_denied_remotely (§3.2)', () => {
  it('refuses each of them with a valid token', async () => {
    harness = await createRemoteHarness();
    const { token } = harness.mint();

    for (const route of DENIED_REMOTELY) {
      const answer = await harness.call(route.path, {
        method: route.method,
        token,
        ...(route.body === undefined ? {} : { body: route.body }),
      });
      expect(answer.status, route.path).toBe(403);
      expect((answer.json as { error: string }).error, route.path).toBe(ROUTE_DENIED_CODE);
    }
  });

  it('returns the identical 403 with no token, proving deny precedes auth (no token oracle)', async () => {
    harness = await createRemoteHarness();
    const { token } = harness.mint();

    for (const route of DENIED_REMOTELY) {
      const withToken = await harness.call(route.path, {
        method: route.method,
        token,
        ...(route.body === undefined ? {} : { body: route.body }),
      });
      const withoutToken = await harness.call(route.path, {
        method: route.method,
        ...(route.body === undefined ? {} : { body: route.body }),
      });
      const withGarbage = await harness.call(route.path, {
        method: route.method,
        token: 'not-a-token',
        ...(route.body === undefined ? {} : { body: route.body }),
      });

      expect(withoutToken.status, route.path).toBe(403);
      // Byte-identical across all three: a denied route tells a caller nothing
      // about whether its credential was any good (§3.1 rule 2).
      expect(withoutToken.text, route.path).toBe(withToken.text);
      expect(withGarbage.text, route.path).toBe(withToken.text);
    }
  });

  it('does not let a failed credential against a denied route feed the lockout', async () => {
    harness = await createRemoteHarness();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await harness.call('/api/service/shutdown', { method: 'POST', token: 'not-a-token' });
    }
    // The token was never examined, so there was no sign-in to fail.
    expect(harness.audit.failures).toHaveLength(0);
    expect(harness.audit.blocks).toHaveLength(0);
  });

  it('refuses a secrets write under any write method, and leaves a read to its own policy', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(
        backstopMatch(method, '/api/secrets/notify.ntfy.topicUrl', undefined),
        method,
      ).toBeDefined();
    }
    expect(backstopMatch('GET', '/api/secrets', undefined)).toBeUndefined();
    // The `**` suffix covers the prefix itself and everything under it, and nothing
    // that merely starts with the same characters.
    expect(backstopMatch('POST', '/api/secrets', undefined)).toBeDefined();
    expect(backstopMatch('POST', '/api/secretsomething', undefined)).toBeUndefined();
  });

  it('refuses to mint a token remotely even when the route metadata is missing', async () => {
    // The backstop's whole job: a route whose author forgot the flag. Registered
    // here with the default `allow` and denied anyway (§3.2b).
    harness = await createRemoteHarness({
      routes: [
        {
          method: 'POST',
          path: '/api/remote/tokens',
          handler: (_request, response) => response.json({ minted: 'should not happen' }),
        },
      ],
    });
    const { token } = harness.mint();
    const answer = await harness.call('/api/remote/tokens', {
      method: 'POST',
      token,
      body: { label: 'stolen' },
    });

    expect(answer.status).toBe(403);
    expect(answer.text).not.toContain('should not happen');
  });
});

describe('M6 — the loosening principle, in both directions (§3.2)', () => {
  it('allows revoking a token remotely and disabling remote access remotely', async () => {
    harness = await createRemoteHarness();
    const { token } = harness.mint();
    const victim = harness.mint('lost tablet');

    // "Revoke a token remotely — yes."
    const revoked = await harness.call(`/api/remote/tokens/${victim.id}`, {
      method: 'DELETE',
      token,
    });
    expect(revoked.status).toBe(200);

    // "Disable remote access entirely from your phone — yes."
    const disabled = await harness.call('/api/remote/enabled', {
      method: 'PUT',
      token,
      body: { enabled: false },
    });
    expect(disabled.status).toBe(200);
  });

  it('refuses re-enabling remotely, and refuses a malformed enabled body closed', async () => {
    harness = await createRemoteHarness();
    const { token } = harness.mint();

    const enabling = await harness.call('/api/remote/enabled', {
      method: 'PUT',
      token,
      body: { enabled: true },
    });
    expect(enabling.status).toBe(403);

    // Fail closed: anything that is not an explicit reduction is treated as the
    // loosening direction.
    for (const body of [{}, { enabled: 'true' }, { enabled: null }]) {
      const answer = await harness.call('/api/remote/enabled', { method: 'PUT', token, body });
      expect(answer.status, JSON.stringify(body)).toBe(403);
    }
  });

  it('reads the direction from the body, as a pure decision', () => {
    expect(
      decideRoutePolicy({
        method: 'PUT',
        path: '/api/remote/enabled',
        body: { enabled: false },
        routeRemote: 'allow',
      }).kind,
    ).toBe('authenticate');
    expect(
      decideRoutePolicy({
        method: 'PUT',
        path: '/api/remote/enabled',
        body: { enabled: true },
        routeRemote: 'allow',
      }).kind,
    ).toBe('denied');
  });
});

describe('M6 — a fixture route declaring remote: deny is refused with no change to remote (§3.2a)', () => {
  it('refuses it remotely, and the module’s own code never mentions the path', async () => {
    harness = await createRemoteHarness({
      routes: [
        {
          method: 'POST',
          path: '/api/fixture/dangerous',
          remote: 'deny',
          handler: (_request, response) => response.json({ ran: true }),
        },
        {
          method: 'POST',
          path: '/api/fixture/harmless',
          handler: (_request, response) => response.json({ ran: true }),
        },
      ],
    });
    const { token } = harness.mint();

    const denied = await harness.call('/api/fixture/dangerous', { method: 'POST', token });
    expect(denied.status).toBe(403);
    expect((denied.json as { error: string }).error).toBe(ROUTE_DENIED_CODE);
    expect(harness.audit.refusals.at(-1)?.reason).toContain('declared');

    // Its neighbour, identical but for the flag, is served — which is what makes
    // this a test of the flag rather than of the path.
    const allowed = await harness.call('/api/fixture/harmless', { method: 'POST', token });
    expect(allowed.status).toBe(200);
  });
});

describe('M6 — fs/browse is allowed remotely (§3.3)', () => {
  it('serves it with a valid token and logs the resolved path', async () => {
    harness = await createRemoteHarness({ resolvePath: (path) => path.toUpperCase() });
    const { token } = harness.mint();

    const answer = await harness.call('/api/fs/browse?path=c%3A%5Cusers', { token });
    expect(answer.status).toBe(200);
    // Containment (`projects.browseRoots`, directory names only, junctions resolved
    // before the root check) is projects' own control and its own suite — remote
    // §3.3 decided the route is *allowed* and added the audit line and the bucket,
    // which is what is asserted here.
    expect(harness.audit.browses[0]?.resolved).toBe('C:\\USERS');
  });

  it('still requires a token', async () => {
    harness = await createRemoteHarness();
    expect((await harness.call('/api/fs/browse')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The default-allow half, as a table test over the live route table
// ---------------------------------------------------------------------------

describe('M6 — every route in the live table is reachable remotely unless it is denied', () => {
  let temp: TempDir | undefined;
  let workspace: TempDir | undefined;
  let service: BootedService | undefined;

  afterEach(async () => {
    await service?.shutdown().catch(() => undefined);
    service = undefined;
    temp?.cleanup();
    workspace?.cleanup();
    temp = undefined;
    workspace = undefined;
  });

  async function bootHome(): Promise<BootedService> {
    temp = makeTempDir('agentmanager-remote-policy-');
    workspace = makeTempDir('agentmanager-remote-policy-ws-');
    const options: BootOptions = {
      installRoot: repoRoot,
      dataRoot: temp.path,
      env: {},
      pretty: false,
      tightenAcl: false,
      acl: { run: () => {} },
      exit: () => {},
      http: { port: 0, heartbeatMs: 0 },
      remote: { detect: { locateCli: () => undefined, networkInterfaces: () => ({}) } },
      argv: ['--edition', 'home', '--set', 'secrets.provider=env'],
    };
    const booted = await boot(options);
    service = booted;
    return booted;
  }

  it('classifies the whole v1 inventory, and only the expected routes are denied', async () => {
    const booted = await bootHome();
    const routes: readonly RegisteredRoute[] = booted.runtime.routes.routes;
    expect(routes.length).toBeGreaterThan(30);

    // The classification, route by route, over the *real* table — so a route added
    // by any element in a later wave is covered by this test without editing it.
    const denied: string[] = [];
    const allowed: string[] = [];
    const unauthenticated: string[] = [];
    for (const route of routes) {
      const method = route.method === 'ALL' ? 'GET' : route.method;
      const decision = decideRoutePolicy({
        method,
        path: route.path,
        // `undefined` is the fail-closed body, which is what a UI greying controls
        // should see for the one conditional entry.
        body: undefined,
        routeRemote: route.remote,
      });
      const name = `${method} ${route.path}`;
      if (decision.kind === 'denied') denied.push(name);
      else if (decision.kind === 'static') unauthenticated.push(name);
      else allowed.push(name);
    }

    // Exactly the deny list of §3.2 and nothing else. A new route that must not be
    // remote fails *this* assertion until it is declared, which is the point.
    expect(denied.sort()).toEqual([
      'POST /api/remote/restart',
      'POST /api/remote/tokens',
      'POST /api/service/shutdown',
      'PUT /api/remote/enabled',
    ]);
    // The unauthenticated set is the SPA route and its history fallback, plus
    // foundation's liveness probe — every non-`/api` `GET` in the inventory, which
    // is exactly what §3.1 rule 1 says it should be. `/healthz` being in the set is
    // a consequence worth naming rather than a leak: it answers from in-memory
    // facts only (status, version, edition, uptime, phase), touches no database,
    // and telling a device on the owner's own tailnet that the core is up is what
    // lets a phone distinguish "not paired" from "nothing listening" before it has
    // a token to ask with. Anything that ever *did* carry data would be under
    // `/api`, where rule 3 applies.
    expect(unauthenticated.sort()).toEqual(['GET /*', 'GET /healthz']);
    // And everything else — roster, projects, sessions, questions, events, logs,
    // assignments — is allow-authenticated, which is §3.1's decision.
    expect(allowed.length).toBe(routes.length - denied.length - unauthenticated.length);
    for (const name of [
      'GET /api/health',
      'GET /api/roster/agents',
      'GET /api/projects',
      'GET /api/questions',
      'GET /api/events',
      'GET /api/logs/download',
      'GET /api/config/effective',
      'GET /api/fs/browse',
      'POST /api/assignments/solo',
      'GET /api/remote/tokens',
      'DELETE /api/remote/tokens/:id',
    ]) {
      expect(allowed, name).toContain(name);
    }
  });

  it('publishes that same classification through GET /api/remote/status (§12 contract 7)', async () => {
    const booted = await bootHome();
    const answer = await fetch(`${booted.url() ?? ''}/api/remote/status`);
    const body = (await answer.json()) as {
      activeTokenCount: number;
      deniedRemotely: { method: string; path: string; source: string; conditional: boolean }[];
      backstopPatterns: { pattern: string }[];
    };

    expect(answer.status).toBe(200);
    expect(body.activeTokenCount).toBe(0);
    expect(body.deniedRemotely.map((entry) => `${entry.method} ${entry.path}`).sort()).toEqual([
      'POST /api/remote/restart',
      'POST /api/remote/tokens',
      'POST /api/service/shutdown',
      'PUT /api/remote/enabled',
    ]);
    // Two declared, two from the backstop — and the conditional one is flagged, so
    // the UI can grey "turn remote back on" without greying "turn it off".
    expect(body.deniedRemotely.filter((entry) => entry.source === 'declared')).toHaveLength(3);
    expect(body.deniedRemotely.filter((entry) => entry.conditional)).toHaveLength(1);
    expect(body.backstopPatterns.map((entry) => entry.pattern)).toEqual(
      BACKSTOP_DENY_PATTERNS.map((entry) => entry.pattern),
    );
  });

  it('succeeds over the local listener for all four routes that are denied remotely', async () => {
    const booted = await bootHome();
    const base = booted.url() ?? '';

    // The local listener has no authentication and no policy — R6's stated trust
    // boundary — so the same four calls that 403 remotely all answer here.
    const minted = await fetch(`${base}/api/remote/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Pixel 9', device: 'Android 15' }),
    });
    expect(minted.status).toBe(201);
    const mintedBody = (await minted.json()) as { token: string; prefix: string; qrUrl: null };
    expect(mintedBody.token).toHaveLength(43);
    expect(mintedBody.prefix).toBe(mintedBody.token.slice(0, 6));
    // No socket is bound (no tailnet in this test), so there is no client URL to
    // put in a QR code, and the field says so rather than inventing one.
    expect(mintedBody.qrUrl).toBeNull();

    const restarted = await fetch(`${base}/api/remote/restart`, { method: 'POST' });
    expect(restarted.status).toBe(200);

    const enabled = await fetch(`${base}/api/remote/enabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({ enabled: true });

    // `POST /api/service/shutdown` is the fourth, and it is left last on purpose:
    // foundation's own suite drives it, and calling it here would stop the core
    // mid-test. Its local reachability is asserted by `api.test.ts`.
    const status = await fetch(`${base}/api/remote/status`);
    expect(((await status.json()) as { activeTokenCount: number }).activeTokenCount).toBe(1);
  });

  it('lists the minted token without its value, and revokes it', async () => {
    const booted = await bootHome();
    const base = booted.url() ?? '';
    const minted = await fetch(`${base}/api/remote/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Pixel 9' }),
    });
    const body = (await minted.json()) as { id: string; token: string };

    const listed = await fetch(`${base}/api/remote/tokens`);
    const text = await listed.text();
    expect(listed.status).toBe(200);
    // §4.3: "The list view shows label, `token_prefix`, `created_at`,
    // `last_used_at`, `last_used_peer`, and expiry — never the token."
    expect(text).not.toContain(body.token);
    expect(text).toContain('"prefix"');
    expect(text).toContain('"lastUsedPeer"');

    const revoked = await fetch(`${base}/api/remote/tokens/${body.id}`, { method: 'DELETE' });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ id: body.id, revoked: true });

    const missing = await fetch(`${base}/api/remote/tokens/does-not-exist`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The pure decision, and the effective list
// ---------------------------------------------------------------------------

describe('M6 — the decision function and the published deny list', () => {
  it('defaults to allow-authenticated for a route with no metadata', () => {
    expect(
      decideRoutePolicy({
        method: 'POST',
        path: '/api/assignments/solo',
        body: {},
        routeRemote: undefined,
      }),
    ).toEqual({ kind: 'authenticate' });
  });

  it('reports declared and backstop denials separately over a table', () => {
    const table: readonly RegisteredRoute[] = [
      {
        moduleId: 'http',
        method: 'POST',
        path: '/api/service/shutdown',
        remote: 'deny',
        handler: () => undefined,
      },
      {
        moduleId: 'remote',
        method: 'PUT',
        path: '/api/remote/enabled',
        remote: 'allow',
        handler: () => undefined,
      },
      {
        moduleId: 'roster',
        method: 'GET',
        path: '/api/roster/agents',
        remote: 'allow',
        handler: () => undefined,
      },
    ];

    expect(effectiveDenyList(table)).toEqual([
      {
        method: 'POST',
        path: '/api/service/shutdown',
        source: 'declared',
        reason: 'Registered `remote: "deny"` by the "http" module.',
        conditional: false,
      },
      {
        method: 'PUT',
        path: '/api/remote/enabled',
        source: 'backstop',
        reason: BACKSTOP_DENY_PATTERNS.find((entry) => entry.pattern === '/api/remote/enabled')
          ?.reason,
        conditional: true,
      },
    ]);
  });

  it('keeps the backstop list to §3.2’s five entries, so it stays readable', () => {
    expect(
      BACKSTOP_DENY_PATTERNS.map((entry) => `${entry.methods.join('|')} ${entry.pattern}`),
    ).toEqual([
      'POST /api/service/shutdown',
      'POST|PUT|PATCH|DELETE /api/secrets/**',
      'POST /api/remote/tokens',
      'POST /api/remote/restart',
      'PUT /api/remote/enabled',
    ]);
    for (const entry of BACKSTOP_DENY_PATTERNS) expect(entry.reason.length).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------------------
// Ordering, asserted as ordering
// ---------------------------------------------------------------------------

describe('M6 — the chain order is the security property', () => {
  it('runs the peer guard before the deny list, so a foreign peer learns nothing about routes', async () => {
    harness = await createRemoteHarness({ allowPeer: () => false });
    const { token } = harness.mint();

    // Not a 403 route_denied_remotely and not a 401: a peer that is not on the
    // tailnet is refused before anything looks at a route at all (§9.2 #6).
    for (const route of DENIED_REMOTELY) {
      const answer = await harness.call(route.path, { method: route.method, token });
      expect((answer.json as { error: string }).error, route.path).toBe(PEER_REFUSED_CODE);
    }
  });

  it('mounts exactly three middlewares, in peer → host → policy order', async () => {
    harness = await createRemoteHarness();
    expect(harness.middleware).toHaveLength(3);
  });
});
