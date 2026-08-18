/**
 * The pattern engine's three routes (IMPLEMENTATION M5-1, M5-2, M6-6), driven
 * directly against the handler contract for the reason `routes.test.ts` gives:
 * `RouteHandler` was defined so a handler is testable without a socket
 * (foundation §6.4). The same routes are exercised over a real listener in
 * `module.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { bytes, empty, error, json, text } from '../../http/response.js';
import type { HttpResult, RequestContext, ResponseTools } from '../../http/types.js';
import type { RouteDefinition } from '../types.js';

import { createEngineRoutes } from './engineRoutes.js';
import { flush, makeHarness, PROJECT_ID, type Harness } from './__tests__/helpers.js';

let harness: Harness | undefined;

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

interface Wired {
  readonly harness: Harness;
  readonly routes: readonly RouteDefinition[];
  call(
    method: string,
    path: string,
    options?: { params?: Record<string, string> },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

function wire(): Wired {
  harness?.cleanup();
  const h = makeHarness({
    agents: [
      { id: 'ada', roles: ['architect'] },
      { id: 'sam', roles: ['skeptic'] },
    ],
  });
  harness = h;
  const logger = { error: () => undefined, debug: () => undefined } as never;
  const routes = createEngineRoutes({
    engine: h.engine,
    service: h.service,
    conversation: h.conversation,
    fleetStatus: h.fleetStatus,
    logger,
  });

  return {
    harness: h,
    routes,
    async call(method, path, options = {}) {
      const route = routes.find((entry) => entry.method === method && entry.path === path);
      if (route === undefined) throw new Error(`no route ${method} ${path}`);
      const req = {
        method,
        path,
        params: options.params ?? {},
        query: new URLSearchParams(),
        body: undefined,
        origin: 'local',
        requestId: 'req-1',
        logger: { debug: () => undefined },
      } as unknown as RequestContext;
      const result = (await route.handler(req, responseTools)) as HttpResult;
      return {
        status: result.status,
        body: JSON.parse(Buffer.from(result.body ?? '').toString('utf8')) as Record<
          string,
          unknown
        >,
      };
    },
  };
}

async function makePair(wired: Wired, autoStart = true): Promise<string> {
  const created = await wired.harness.service.createAssignment({
    projectId: PROJECT_ID,
    pattern: 'pair',
    goal: 'Write the design',
    members: [
      { agentId: 'ada', role: 'architect' },
      { agentId: 'sam', role: 'skeptic' },
    ],
    scope: { paths: ['docs/x/'], artifactPath: 'docs/x/DESIGN.md' },
    autoStart,
  });
  await flush();
  return created.assignmentId;
}

describe('GET /api/patterns (M5-1)', () => {
  it('serves every pattern with its seats, defaults and allowed roles', async () => {
    const wired = wire();
    const answer = await wired.call('GET', '/api/patterns');
    expect(answer.status).toBe(200);
    const patterns = answer.body['patterns'] as { id: string; seats: { roles: string[] }[] }[];
    expect(patterns.map((pattern) => pattern.id)).toEqual(['solo', 'pair', 'overseer']);
    expect(patterns[1]?.seats.map((seat) => seat.roles)).toEqual([
      ['architect', 'implementer'],
      ['skeptic'],
    ]);
    // §3.5: one seat, and only an overseer may fill it.
    expect(patterns[2]?.seats.map((seat) => seat.roles)).toEqual([['overseer']]);
  });
});

describe('POST /api/assignments/:id/advance (M5-2)', () => {
  it('plans the first turn of an assignment that was created without autoStart', async () => {
    const wired = wire();
    const assignmentId = await makePair(wired, false);

    const answer = await wired.call('POST', '/api/assignments/:id/advance', {
      params: { id: assignmentId },
    });
    expect(answer.status).toBe(200);
    expect(answer.body['outcome']).toMatchObject({ kind: 'planned', seat: 'drafter', round: 1 });
    // The assignment as it now stands comes back with the outcome, so no caller
    // needs a follow-up GET to learn the phase its own request produced.
    expect(answer.body['assignment']).toMatchObject({ phase: 'running' });
  });

  it('reports an idle outcome rather than an error when there is nothing to plan', async () => {
    const wired = wire();
    const assignmentId = await makePair(wired);
    const answer = await wired.call('POST', '/api/assignments/:id/advance', {
      params: { id: assignmentId },
    });
    expect(answer.status).toBe(200);
    expect(answer.body['outcome']).toEqual({ kind: 'idle', reason: 'turn_in_flight' });
  });

  it('answers 404 with a typed body for an unknown assignment', async () => {
    const wired = wire();
    const answer = await wired.call('POST', '/api/assignments/:id/advance', {
      params: { id: 'nope' },
    });
    expect(answer.status).toBe(404);
    expect(answer.body['error']).toBe('assignment_not_found');
  });
});

describe('GET /api/assignments/:id/conversation (M6-6)', () => {
  it('serves the rounds of an assignment with a turn in them', async () => {
    const wired = wire();
    const assignmentId = await makePair(wired);
    const answer = await wired.call('GET', '/api/assignments/:id/conversation', {
      params: { id: assignmentId },
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      assignmentId,
      pattern: 'pair',
      phase: 'running',
      artifactPath: 'docs/x/DESIGN.md',
    });
    const rounds = answer.body['rounds'] as { round: number; entries: { type: string }[] }[];
    expect(rounds[0]?.entries.map((entry) => entry.type)).toEqual(['turn']);
  });

  it('answers 404 for an unknown assignment', async () => {
    const wired = wire();
    const answer = await wired.call('GET', '/api/assignments/:id/conversation', {
      params: { id: 'nope' },
    });
    expect(answer.status).toBe(404);
    expect(answer.body['error']).toBe('assignment_not_found');
  });
});
