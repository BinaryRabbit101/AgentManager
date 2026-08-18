/**
 * The six routes of IMPLEMENTATION M1-7, driven directly against the handler
 * contract — no socket, because `RouteHandler` was defined so a handler is
 * testable without one (foundation §6.4).
 *
 * What these assert beyond "the happy path returns 201" is the refusal
 * translation: every {@link OrchestratorError} must reach the client as
 * foundation's one error shape with its own `code` and status, and no stack may
 * ever appear in a body.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { bytes, empty, error, json, text } from '../../http/response.js';
import type { HttpResult, RequestContext, ResponseTools } from '../../http/types.js';
import type { RouteDefinition } from '../types.js';

import { createAssignmentRoutes } from './routes.js';
import { makeHarness, PROJECT_ID, type Harness } from './__tests__/helpers.js';

let harness: Harness | undefined;

/**
 * The same helpers the real server hands a handler (`http/server.ts`), minus
 * `sse`, which no route here opens. Using the shipped functions rather than
 * re-implementing them is what makes an assertion on a status or a body an
 * assertion about the response a client would actually receive.
 */
const responseTools: ResponseTools = {
  json,
  text,
  bytes,
  empty,
  error,
  sse: () => {
    throw new Error('no route in this element opens an SSE stream');
  },
};

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const ADA = { id: 'ada', roles: ['implementer', 'architect'] as const };
const SAM = { id: 'sam', roles: ['skeptic'] as const };

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
  const h = makeHarness({ agents: [ADA, SAM], ...options });
  harness = h;
  const logger = { error: () => undefined, debug: () => undefined } as never;
  const routes = createAssignmentRoutes({ service: h.service, logger });

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

describe('the route table', () => {
  it('registers exactly IMPLEMENTATION M1-7’s six routes', () => {
    const { routes } = wire();
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'GET /api/assignments',
      'GET /api/assignments/:id',
      'PATCH /api/assignments/:id',
      'POST /api/assignments',
      'POST /api/assignments/:id/close',
      'POST /api/assignments/solo',
    ]);
  });

  it('leaves every route remotely reachable — the launch is the product (D3, D5)', () => {
    const { routes } = wire();
    // "start an agent from my phone over the tailnet" is the whole point, and
    // nothing here reads a file, a secret or a token.
    for (const route of routes) expect(route.remote).toBeUndefined();
  });
});

describe('POST /api/assignments/solo', () => {
  it('returns 201 with { assignmentId, sessionId }', async () => {
    const w = wire();
    const answer = await w.call('POST', '/api/assignments/solo', {
      body: { projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' },
    });
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ sessionId: 'session-1', warnings: [] });
    expect(answer.body['assignmentId']).toEqual(expect.any(String));
  });

  it.each([
    [{ agentId: 'ada', prompt: 'go' }, 'projectId'],
    [{ projectId: PROJECT_ID, prompt: 'go' }, 'agentId'],
    [{ projectId: PROJECT_ID, agentId: 'ada' }, 'prompt'],
  ])('400s on a missing field, naming it', async (body, field) => {
    const w = wire();
    const answer = await w.call('POST', '/api/assignments/solo', { body });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: 'invalid_request', field });
  });

  it('400s on a role outside the pinned five', async () => {
    const w = wire();
    const answer = await w.call('POST', '/api/assignments/solo', {
      body: { projectId: PROJECT_ID, agentId: 'ada', prompt: 'go', role: 'wizard' },
    });
    expect(answer.status).toBe(400);
    expect(answer.body['field']).toBe('role');
  });

  it('translates a §9 refusal into its own code and status, with no stack', async () => {
    const w = wire();
    // An id the roster does not know: a real invariant, unlike the capability
    // hints the owner decision of 2026-08-18 turned into warnings (§9-5/§9-6).
    const answer = await w.call('POST', '/api/assignments/solo', {
      body: { projectId: PROJECT_ID, agentId: 'ghost', prompt: 'go' },
    });
    // The refusal's own status, from `statusFor` — not a blanket 400.
    expect(answer.status).toBe(404);
    expect(answer.body['error']).toBe('agent_not_found');
    expect(JSON.stringify(answer.body)).not.toContain('at Object');
    expect(answer.body['refusals']).toHaveLength(1);
  });

  it('launches an agent seated in a role it does not declare, and says so (2026-08-18)', async () => {
    const w = wire();
    const answer = await w.call('POST', '/api/assignments/solo', {
      body: { projectId: PROJECT_ID, agentId: 'ada', prompt: 'go', role: 'skeptic' },
    });
    expect(answer.status).toBe(201);
    expect(
      (answer.body['warnings'] as { code: string }[]).map((warning) => warning.code),
    ).toContain('role_not_declared');
  });

  it('cannot claim createdBy — an HTTP caller may not choose which rules apply', async () => {
    const w = wire();
    const answer = await w.call('POST', '/api/assignments/solo', {
      body: {
        projectId: PROJECT_ID,
        agentId: 'ada',
        prompt: 'go',
        createdBy: 'overseer:ada',
        parentAssignmentId: 'anything',
      },
    });
    expect(answer.status).toBe(201);
    const view = w.harness.service.get(answer.body['assignmentId'] as string);
    expect(view.createdBy).toBe('user');
    expect(view.parentAssignmentId).toBeNull();
  });
});

describe('POST /api/assignments', () => {
  it('returns 201 with warnings and no gate for a user-created pair', async () => {
    const w = wire();
    const answer = await w.call('POST', '/api/assignments', {
      body: {
        projectId: PROJECT_ID,
        pattern: 'pair',
        goal: 'Draft it',
        members: [
          { agentId: 'ada', role: 'architect' },
          { agentId: 'sam', role: 'skeptic' },
        ],
        scope: { paths: ['docs/'], artifactPath: 'docs/D.md' },
      },
    });
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ status: 'open', phase: 'running', warnings: [] });
  });

  it('400s on a pattern outside the vocabulary', async () => {
    const w = wire();
    const answer = await w.call('POST', '/api/assignments', {
      body: { projectId: PROJECT_ID, pattern: 'chorus', members: [] },
    });
    expect(answer.body['field']).toBe('pattern');
  });

  it('409s when the project is not active', async () => {
    const w = wire({ projectStatus: 'archived' });
    const answer = await w.call('POST', '/api/assignments', {
      body: {
        projectId: PROJECT_ID,
        pattern: 'solo',
        members: [{ agentId: 'ada', role: 'implementer' }],
      },
    });
    expect(answer.status).toBe(409);
    expect(answer.body['error']).toBe('project_not_active');
  });
});

describe('GET /api/assignments', () => {
  it('lists and filters', async () => {
    const w = wire();
    await w.call('POST', '/api/assignments/solo', {
      body: { projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' },
    });
    const all = await w.call('GET', '/api/assignments');
    expect((all.body['assignments'] as unknown[]).length).toBe(1);

    const byPhase = await w.call('GET', '/api/assignments', { query: 'phase=halted' });
    expect(byPhase.body['assignments']).toEqual([]);
  });

  it('400s on a status, phase or limit outside its vocabulary', async () => {
    const w = wire();
    expect((await w.call('GET', '/api/assignments', { query: 'status=maybe' })).status).toBe(400);
    expect((await w.call('GET', '/api/assignments', { query: 'phase=spinning' })).status).toBe(400);
    expect((await w.call('GET', '/api/assignments', { query: 'limit=0' })).status).toBe(400);
  });
});

describe('GET / PATCH / close on one assignment', () => {
  it('404s an unknown id', async () => {
    const w = wire();
    const answer = await w.call('GET', '/api/assignments/:id', { params: { id: 'nope' } });
    expect(answer.status).toBe(404);
    expect(answer.body['error']).toBe('assignment_not_found');
  });

  it('patches budget, cap and goal', async () => {
    const w = wire();
    const created = await w.call('POST', '/api/assignments/solo', {
      body: { projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' },
    });
    const id = created.body['assignmentId'] as string;
    const patched = await w.call('PATCH', '/api/assignments/:id', {
      params: { id },
      body: { tokenBudget: 50_000, roundCap: 2, goal: 'refined' },
    });
    expect(patched.body).toMatchObject({ tokenBudget: 50_000, roundCap: 2, goal: 'refined' });
  });

  it('400s a negative budget rather than storing it', async () => {
    const w = wire();
    const created = await w.call('POST', '/api/assignments/solo', {
      body: { projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' },
    });
    const answer = await w.call('PATCH', '/api/assignments/:id', {
      params: { id: created.body['assignmentId'] as string },
      body: { tokenBudget: -1 },
    });
    expect(answer.status).toBe(400);
  });

  it('closes with the default reason and returns the closed record', async () => {
    const w = wire();
    const created = await w.call('POST', '/api/assignments/solo', {
      body: { projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' },
    });
    const answer = await w.call('POST', '/api/assignments/:id/close', {
      params: { id: created.body['assignmentId'] as string },
      body: {},
    });
    expect(answer.body).toMatchObject({
      status: 'closed',
      closeReason: 'user_closed',
      phase: 'closed',
    });
  });

  it('400s a close reason outside the closed set', async () => {
    const w = wire();
    const created = await w.call('POST', '/api/assignments/solo', {
      body: { projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' },
    });
    const answer = await w.call('POST', '/api/assignments/:id/close', {
      params: { id: created.body['assignmentId'] as string },
      body: { reason: 'because' },
    });
    expect(answer.status).toBe(400);
    expect(answer.body['field']).toBe('reason');
  });

  it('409s a patch on a closed assignment', async () => {
    const w = wire();
    const created = await w.call('POST', '/api/assignments/solo', {
      body: { projectId: PROJECT_ID, agentId: 'ada', prompt: 'go' },
    });
    const id = created.body['assignmentId'] as string;
    await w.call('POST', '/api/assignments/:id/close', { params: { id }, body: {} });
    const answer = await w.call('PATCH', '/api/assignments/:id', {
      params: { id },
      body: { goal: 'too late' },
    });
    expect(answer.status).toBe(409);
    expect(answer.body['error']).toBe('assignment_closed');
  });
});
