/**
 * The three question routes of IMPLEMENTATION M2-6, driven directly against the
 * handler contract — no socket (foundation §6.4).
 *
 * The load-bearing assertion is not "200 with a body": it is that
 * `POST /api/questions/:id/answer` is **one** path that behaves identically for
 * the desktop and for the tailnet, and that `answered_via` comes from the
 * listener the request arrived on rather than from anything the client can say
 * (§16-3).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { bytes, empty, error, json, text } from '../../http/response.js';
import type { HttpResult, RequestContext, ResponseTools } from '../../http/types.js';
import type { RouteDefinition } from '../types.js';

import { createQuestionRoutes } from './questionRoutes.js';
import { makeHarness, PROJECT_ID, type Harness } from './__tests__/helpers.js';

let harness: Harness | undefined;

const responseTools: ResponseTools = {
  json,
  text,
  bytes,
  empty,
  error,
  sse: () => {
    throw new Error('no question route opens an SSE stream');
  },
};

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const ADA = { id: 'ada', roles: ['architect'] as const };

interface Wired {
  readonly harness: Harness;
  readonly routes: readonly RouteDefinition[];
  call(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      params?: Record<string, string>;
      query?: string;
      origin?: 'local' | 'remote';
    },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

function wire(): Wired {
  harness?.cleanup();
  const h = makeHarness({ agents: [ADA] });
  harness = h;
  const routes = createQuestionRoutes({
    inbox: h.inbox,
    logger: { error: () => undefined, debug: () => undefined } as never,
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
        query: new URLSearchParams(options.query ?? ''),
        body: options.body,
        origin: options.origin ?? 'local',
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

/** An open solo assignment, a session row, and one raised card. */
async function seedQuestion(h: Harness): Promise<{ questionId: string; assignmentId: string }> {
  const created = await h.service.createAssignment({
    projectId: PROJECT_ID,
    pattern: 'solo',
    members: [{ agentId: 'ada', role: 'architect' }],
  });
  const session = h.storage.store.sessions.create({
    assignmentId: created.assignmentId,
    agentId: 'ada',
    projectId: PROJECT_ID,
    status: 'running',
  });
  let questionId = '';
  void h.inbox.ask({
    assignmentId: created.assignmentId,
    sessionId: session.id,
    agentId: 'ada',
    kind: 'question',
    prompt: 'Postgres or SQLite?',
    options: [
      { id: 'disk', label: 'SQLite on disk' },
      { id: 'pg', label: 'Postgres' },
    ],
    holdUntil: '2026-08-16T10:15:00.000Z',
    expiresAt: '2026-08-17T10:00:00.000Z',
    recommendation: { agentId: 'ada', stance: 'disk', strength: 'strong', rationale: 'simpler' },
    onRaised: (id) => (questionId = id),
  });
  await Promise.resolve();
  return { questionId, assignmentId: created.assignmentId };
}

describe('GET /api/questions (M2-6)', () => {
  it('returns the pinned card projection in one request', async () => {
    const w = wire();
    const seeded = await seedQuestion(w.harness);

    const answer = await w.call('GET', '/api/questions', { query: 'status=open' });
    expect(answer.status).toBe(200);
    const [card] = answer.body['questions'] as Record<string, unknown>[];
    expect(card).toMatchObject({
      id: seeded.questionId,
      kind: 'question',
      status: 'open',
      assignmentId: seeded.assignmentId,
      projectId: PROJECT_ID,
      disagreement: false,
      contested: false,
    });
    expect(card?.['recommendations']).toEqual([
      {
        agentId: 'ada',
        role: 'architect',
        stance: 'disk',
        strength: 'strong',
        rationale: 'simpler',
      },
    ]);
  });

  it('refuses a status outside the closed set by name', async () => {
    const w = wire();
    const answer = await w.call('GET', '/api/questions', { query: 'status=maybe' });
    expect(answer.status).toBe(400);
    expect(answer.body['error']).toBe('invalid_request');
  });
});

describe('GET /api/questions/:id (M2-6)', () => {
  it('answers with the card, and 404s an unknown id without a stack', async () => {
    const w = wire();
    const seeded = await seedQuestion(w.harness);

    const found = await w.call('GET', '/api/questions/:id', { params: { id: seeded.questionId } });
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ id: seeded.questionId, prompt: 'Postgres or SQLite?' });

    const missing = await w.call('GET', '/api/questions/:id', { params: { id: 'nope' } });
    expect(missing.status).toBe(404);
    expect(missing.body['error']).toBe('question_not_found');
    expect(JSON.stringify(missing.body)).not.toMatch(/\bat .*\.ts:/);
  });
});

describe('POST /api/questions/:id/answer (M2-6, §16-3)', () => {
  it('answers from the local listener and records answered_via: local', async () => {
    const w = wire();
    const seeded = await seedQuestion(w.harness);

    const answered = await w.call('POST', '/api/questions/:id/answer', {
      params: { id: seeded.questionId },
      body: { optionIds: ['disk'], labels: ['SQLite on disk'] },
    });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ status: 'answered', answeredVia: 'local' });
  });

  it('is the same path from the tailnet, and records answered_via: remote', async () => {
    const w = wire();
    const seeded = await seedQuestion(w.harness);

    const answered = await w.call('POST', '/api/questions/:id/answer', {
      params: { id: seeded.questionId },
      body: { optionIds: ['pg'] },
      origin: 'remote',
    });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ answeredVia: 'remote' });
  });

  it('never takes answered_via from the body — a client cannot forge the audit trail', async () => {
    const w = wire();
    const seeded = await seedQuestion(w.harness);

    const answered = await w.call('POST', '/api/questions/:id/answer', {
      params: { id: seeded.questionId },
      body: { optionIds: ['pg'], answeredVia: 'local' },
      origin: 'remote',
    });
    expect(answered.body['answeredVia']).toBe('remote');
  });

  it('409s a second answer and 400s an empty one', async () => {
    const w = wire();
    const seeded = await seedQuestion(w.harness);

    await w.call('POST', '/api/questions/:id/answer', {
      params: { id: seeded.questionId },
      body: { optionIds: ['pg'] },
    });
    const again = await w.call('POST', '/api/questions/:id/answer', {
      params: { id: seeded.questionId },
      body: { optionIds: ['disk'] },
    });
    expect(again.status).toBe(409);
    expect(again.body['error']).toBe('question_not_open');

    const other = await seedQuestion(w.harness);
    const empty_ = await w.call('POST', '/api/questions/:id/answer', {
      params: { id: other.questionId },
      body: {},
    });
    expect(empty_.status).toBe(400);
  });

  it('every route is remote-reachable, because answering from a phone is the product', () => {
    const w = wire();
    expect(w.routes.every((route) => route.remote !== 'deny')).toBe(true);
  });
});
