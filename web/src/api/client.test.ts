import { describe, expect, it, vi } from 'vitest';

import { ApiClient, TOKEN_STORAGE_KEY, browserTokenStore } from './client';
import { STATUS_OUTCOME_KINDS } from './result';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function clientWith(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
  options: { token?: string } = {},
): { client: ApiClient; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  let token = options.token ?? null;
  const client = new ApiClient({
    fetch: ((input: string, init: RequestInit) => {
      calls.push({ url: input, init });
      return Promise.resolve(responder(input, init));
    }) as unknown as typeof globalThis.fetch,
    tokens: {
      get: () => token,
      set: (next) => {
        token = next;
      },
    },
  });
  return { client, calls };
}

describe('ApiClient — relative /api and one origin (§1.3, §3.1)', () => {
  it('prefixes /api exactly once and never builds an absolute URL', () => {
    const { client } = clientWith(() => jsonResponse(200, {}));
    expect(client.url('/roster/agents')).toBe('/api/roster/agents');
    expect(client.url('/api/roster/agents')).toBe('/api/roster/agents');
    expect(client.url('/projects', { includeArchived: 'true' })).toBe(
      '/api/projects?includeArchived=true',
    );
    // No base URL to configure: every request the app makes is same-origin.
    expect(client.url('/health')).not.toMatch(/^https?:/u);
  });

  it('omits undefined query values rather than sending "undefined"', () => {
    const { client } = clientWith(() => jsonResponse(200, {}));
    expect(client.url('/events', { types: 'roster.*', since: undefined })).toBe(
      '/api/events?types=roster.*',
    );
  });

  it('asks for no-store, because a reconnect must not render a cached roster', async () => {
    const { client, calls } = clientWith(() => jsonResponse(200, { agents: [] }));
    await client.request('/roster/agents');
    expect(calls[0]?.init.cache).toBe('no-store');
  });
});

describe('ApiClient — the bearer (§3.1)', () => {
  it('attaches Authorization only when a token is held', async () => {
    const withoutToken = clientWith(() => jsonResponse(200, {}));
    await withoutToken.client.request('/health');
    expect(withoutToken.calls[0]?.init.headers).not.toHaveProperty('authorization');

    const withToken = clientWith(() => jsonResponse(200, {}), { token: 'abc' });
    await withToken.client.request('/health');
    expect(withToken.calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer abc' });
  });

  it('stores the token under exactly one localStorage key', () => {
    const store = browserTokenStore(window.localStorage);
    store.set('t0ken');
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('t0ken');
    store.set(null);
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});

describe('ApiClient — the five typed status-code outcomes (§3.1)', () => {
  it('names all five', () => {
    expect(STATUS_OUTCOME_KINDS).toEqual([
      'unauthorized',
      'denied-remotely',
      'grant-required',
      'rate-limited',
      'remote-unavailable',
    ]);
  });

  it('401 → unauthorized, and clears the stored token', async () => {
    const onUnauthorized = vi.fn();
    let token: string | null = 'expired';
    const client = new ApiClient({
      fetch: (() =>
        Promise.resolve(
          jsonResponse(401, { error: 'unauthorized', message: 'That token is no longer valid.' }),
        )) as unknown as typeof globalThis.fetch,
      tokens: {
        get: () => token,
        set: (next) => {
          token = next;
        },
      },
      onUnauthorized,
    });

    const result = await client.request('/roster/agents');
    expect(result.kind).toBe('unauthorized');
    expect(result).toMatchObject({ message: 'That token is no longer valid.' });
    expect(token).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('403 route_denied_remotely → denied-remotely, not a generic error', async () => {
    const { client } = clientWith(() =>
      jsonResponse(403, {
        error: 'route_denied_remotely',
        message: 'Creating a token is not available remotely.',
      }),
    );
    const result = await client.request('/remote/tokens');
    expect(result.kind).toBe('denied-remotely');
    expect(result).toMatchObject({ message: 'Creating a token is not available remotely.' });
  });

  it('403 with another code stays a verbatim error', async () => {
    const { client } = clientWith(() =>
      jsonResponse(403, { error: 'forbidden', message: 'Nope.' }),
    );
    const result = await client.request('/anything');
    expect(result).toMatchObject({
      kind: 'error',
      status: 403,
      code: 'forbidden',
      message: 'Nope.',
    });
  });

  it('409 remote_access_required → grant-required, carrying every agent id', async () => {
    const { client } = clientWith(() =>
      jsonResponse(409, {
        error: 'remote_access_required',
        message: 'Priya is not allowed to be started remotely.',
        agentIds: ['priya', 'sam'],
      }),
    );
    const result = await client.request('/assignments/solo', { method: 'POST', body: {} });
    expect(result).toMatchObject({
      kind: 'grant-required',
      agentIds: ['priya', 'sam'],
    });
  });

  it('429 → rate-limited with Retry-After honoured', async () => {
    const { client } = clientWith(() =>
      jsonResponse(
        429,
        { error: 'rate_limited', message: 'Too many attempts.' },
        {
          'retry-after': '30',
        },
      ),
    );
    const result = await client.request('/fs/browse');
    expect(result).toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 30 });
  });

  it('503 remote_unavailable → remote-unavailable', async () => {
    const { client } = clientWith(() =>
      jsonResponse(503, {
        error: 'remote_unavailable',
        message: 'Tailscale is not up yet.',
      }),
    );
    const result = await client.request('/remote/status');
    expect(result).toMatchObject({ kind: 'remote-unavailable' });
  });
});

describe('ApiClient — messages are the server’s own (§3.1)', () => {
  it('surfaces an arbitrary refusal verbatim, with its details', async () => {
    const { client } = clientWith(() =>
      jsonResponse(409, {
        error: 'nested_project',
        message: 'C:\\Code\\App\\sub is inside the registered project C:\\Code\\App.',
        path: 'C:\\Code\\App\\sub',
      }),
    );
    const result = await client.request('/projects', { method: 'POST', body: {} });
    expect(result).toMatchObject({
      kind: 'error',
      status: 409,
      code: 'nested_project',
      message: 'C:\\Code\\App\\sub is inside the registered project C:\\Code\\App.',
      details: { path: 'C:\\Code\\App\\sub' },
    });
  });

  it('a network failure is `offline`, distinct from every status outcome', async () => {
    const client = new ApiClient({
      fetch: (() =>
        Promise.reject(new Error('fetch failed'))) as unknown as typeof globalThis.fetch,
      tokens: { get: () => null, set: () => undefined },
    });
    const result = await client.request('/health');
    expect(result.kind).toBe('offline');
  });
});

describe('ApiClient — the object-URL helper (§3.1)', () => {
  it('fetches an avatar through the client and hands back an object URL', async () => {
    const { client, calls } = clientWith(
      () =>
        new Response(new Blob(['png']), { status: 200, headers: { 'content-type': 'image/png' } }),
      { token: 'phone' },
    );
    const result = await client.objectUrl('/roster/agents/priya/avatar');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.startsWith('blob:')).toBe(true);
    // The whole point: this request carries the bearer, which `<img src>` cannot.
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer phone' });
  });

  it('reports a refusal rather than an unusable URL', async () => {
    const { client } = clientWith(() =>
      jsonResponse(401, { error: 'unauthorized', message: 'no' }),
    );
    const result = await client.objectUrl('/roster/agents/priya/avatar');
    expect(result.kind).toBe('unauthorized');
  });
});
