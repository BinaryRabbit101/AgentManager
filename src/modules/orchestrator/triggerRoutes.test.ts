/**
 * §2.8's six routes, driven directly against the handler contract — no socket,
 * because `RouteHandler` was defined so a handler is testable without one
 * (foundation §6.4).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { bytes, empty, error, json, text } from '../../http/response.js';
import type { HttpResult, RequestContext, ResponseTools } from '../../http/types.js';
import type { RouteDefinition } from '../types.js';

import { createTriggerRoutes } from './triggerRoutes.js';
import { makeHarness, PROJECT_ID, type Harness } from './__tests__/helpers.js';

let harness: Harness | undefined;

const responseTools: ResponseTools = {
  json,
  text,
  bytes,
  empty,
  error,
  sse: () => {
    throw new Error('no trigger route opens an SSE stream');
  },
};

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

interface Wired {
  readonly harness: Harness;
  readonly routes: readonly RouteDefinition[];
  call(
    method: string,
    path: string,
    options?: { body?: unknown; params?: Record<string, string>; query?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

function wire(options: Parameters<typeof makeHarness>[0] = {}): Wired {
  harness?.cleanup();
  const h = makeHarness({ agents: [{ id: 'ada', roles: ['implementer'] }], ...options });
  harness = h;
  const logger = { error: () => undefined, debug: () => undefined } as never;
  const routes = createTriggerRoutes({ triggers: h.triggers, logger });

  return {
    harness: h,
    routes,
    async call(method, path, callOptions = {}) {
      const route = routes.find((entry) => entry.method === method && entry.path === path);
      if (route === undefined) throw new Error(`no route ${method} ${path}`);
      const req = {
        method,
        path,
        params: callOptions.params ?? {},
        query: new URLSearchParams(callOptions.query ?? ''),
        body: callOptions.body,
        origin: 'local',
        requestId: 'req-1',
        logger: { debug: () => undefined },
      } as unknown as RequestContext;
      const result = (await route.handler(req, responseTools)) as HttpResult;
      return {
        status: result.status,
        body: JSON.parse(result.body?.toString('utf8') ?? '{}') as Record<string, unknown>,
      };
    },
  };
}

const BODY = {
  projectId: PROJECT_ID,
  templateId: 'todo-ticket-replies',
  agentIds: ['ada'],
  everyMinutes: 60,
};

describe('the trigger route table (§11.1)', () => {
  it('registers exactly §2.8’s six routes', () => {
    const { routes } = wire();
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/triggers/:id',
      'GET /api/triggers',
      'GET /api/triggers/:id',
      'PATCH /api/triggers/:id',
      'POST /api/triggers',
      'POST /api/triggers/:id/run',
    ]);
  });

  it('leaves every route remotely reachable — the phone can fire one later (D5)', () => {
    const { routes } = wire();
    for (const route of routes) expect(route.remote).toBeUndefined();
  });
});

describe('POST /api/triggers', () => {
  it('creates a trigger and arms it', async () => {
    const wired = wire();
    const created = await wired.call('POST', '/api/triggers', { body: BODY });
    expect(created.status).toBe(201);
    expect(created.body['enabled']).toBe(true);
    expect(created.body['nextFireAt']).toEqual(expect.any(String));
  });

  it('refuses a body-shape mistake by name', async () => {
    const wired = wire();
    const bad = await wired.call('POST', '/api/triggers', {
      body: { ...BODY, activeHours: { from: 8 } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body['error']).toBe('invalid_request');
  });

  it('refuses a rule violation by name too', async () => {
    const wired = wire();
    const bad = await wired.call('POST', '/api/triggers', {
      body: { ...BODY, everyMinutes: 0 },
    });
    expect(bad.status).toBe(400);
    expect(bad.body['field']).toBe('everyMinutes');
  });
});

describe('GET/PATCH/DELETE /api/triggers/:id', () => {
  it('filters the list by project', async () => {
    const wired = wire();
    await wired.call('POST', '/api/triggers', { body: BODY });
    const mine = await wired.call('GET', '/api/triggers', { query: `projectId=${PROJECT_ID}` });
    expect((mine.body['triggers'] as unknown[]).length).toBe(1);
    const other = await wired.call('GET', '/api/triggers', { query: 'projectId=nope' });
    expect(other.body['triggers']).toEqual([]);
  });

  it('answers 404 for a trigger that is not there', async () => {
    const wired = wire();
    const missing = await wired.call('GET', '/api/triggers/:id', { params: { id: 'nope' } });
    expect(missing.status).toBe(404);
    expect(missing.body['error']).toBe('trigger_not_found');
  });

  it('turns a trigger off without losing what it says', async () => {
    const wired = wire();
    const created = await wired.call('POST', '/api/triggers', { body: BODY });
    const id = created.body['id'] as string;
    const off = await wired.call('PATCH', '/api/triggers/:id', {
      params: { id },
      body: { enabled: false },
    });
    expect(off.body['enabled']).toBe(false);
    expect(off.body['nextFireAt']).toBeNull();
    expect(off.body['templateId']).toBe('todo-ticket-replies');
  });

  it('deletes one', async () => {
    const wired = wire();
    const created = await wired.call('POST', '/api/triggers', { body: BODY });
    const id = created.body['id'] as string;
    expect((await wired.call('DELETE', '/api/triggers/:id', { params: { id } })).status).toBe(200);
    expect((await wired.call('GET', '/api/triggers/:id', { params: { id } })).status).toBe(404);
  });
});

describe('POST /api/triggers/:id/run', () => {
  it('fires now and answers with the outcome and the refreshed row', async () => {
    const wired = wire();
    const created = await wired.call('POST', '/api/triggers', { body: BODY });
    const id = created.body['id'] as string;

    const ran = await wired.call('POST', '/api/triggers/:id/run', { params: { id } });
    expect(ran.status).toBe(200);
    expect(ran.body['outcome']).toBe('fired');
    expect((ran.body['trigger'] as { lastOutcome: string }).lastOutcome).toBe('fired');
  });

  it('answers 200 with a reason when preflight refuses, not an HTTP failure', async () => {
    const wired = wire({
      preflight: { gateLiable: { ada: [{ tool: 'Bash', remembered: false }] } },
    });
    const created = await wired.call('POST', '/api/triggers', { body: BODY });
    const id = created.body['id'] as string;

    const ran = await wired.call('POST', '/api/triggers/:id/run', { params: { id } });
    // A block is an *answer*: "Run now" is not broken on the one day it
    // correctly refused to launch into a gate nobody is there to answer.
    expect(ran.status).toBe(200);
    expect(ran.body).toMatchObject({ outcome: 'blocked', reason: 'permission-gate:Bash' });
  });
});
