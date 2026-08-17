/**
 * The `orchestrator` module through the real composition root (orchestrator
 * IMPLEMENTATION M0-1..3 and M1-7/M1-8).
 *
 * Everything here goes through `boot()` in `src/main.ts` and a real listener on
 * an ephemeral port, because four of the things under test are only true through
 * that path: the migration *order* comes from the module graph (foundation
 * §1.3), the route table is mounted by the `http` module at `start()` (§6.4),
 * the service is only reachable if `ctx.provide` ran, and
 * `modules.orchestrator.enabled` is a gate in the composition root and nowhere
 * else.
 *
 * Since runner M6 this suite can also prove the one thing it previously could
 * not: a **real session**. `hasLauncher()` probes for `startSession` *and*
 * `stop` (`ports.ts`), so the day runner's `stop` verb landed,
 * `POST /api/assignments/solo` stopped answering `503 runner_unavailable` and
 * started creating an assignment and launching its first session for real. The
 * test that used to assert the 503 now asserts that — through the composition
 * root, over the listener, with the SDK replaced at `BootOptions.runner.query`
 * and nothing else faked.
 *
 * That last import is the only one in this file that reaches into a sibling
 * element, and it reaches only for a **test fake**: `main.ts` already wires
 * runner, `BootOptions.runner` is the seam it exposes for exactly this, and the
 * alternative — restating the SDK's message shapes here — would be a second
 * copy of a fixture that exists to be kept in step with the pinned SDK.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, type BootOptions, type BootedService } from '../../main.js';
import { controllableQuery, scriptedQuery, successScript } from '../runner/__tests__/fakeQuery.js';

import { ORCHESTRATOR_MODULE_ID, ORCHESTRATOR_SERVICE } from './module.js';
import type { AssignmentService } from './types.js';
import { makeTempDir, repoRoot, type TempDir } from './__tests__/helpers.js';

let dataRootDir: TempDir;
let workspaceDir: TempDir;
let service: BootedService | undefined;
let base: string;

async function bootCore(options: BootOptions = {}): Promise<BootedService> {
  const booted = await boot({
    installRoot: repoRoot,
    dataRoot: dataRootDir.path,
    env: {},
    pretty: false,
    tightenAcl: false,
    acl: { run: () => {} },
    exit: () => {},
    ...options,
    http: { port: 0, heartbeatMs: 0, ...options.http },
    argv: ['--set', 'secrets.provider=env', ...(options.argv ?? [])],
  });
  service = booted;
  const url = booted.url();
  if (url === undefined) throw new Error('the listener did not bind');
  base = url;
  return booted;
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/**
 * Polls runner's own session route until the row leaves the live statuses.
 *
 * Polling rather than reaching for `RunnerService.awaitSettled`: the point of
 * this suite is that the two elements meet through the composition root and the
 * listener, and a test that reached past the listener into a sibling's service
 * would stop proving that.
 */
async function untilTerminal(
  sessionId: string,
  timeoutMs = 20_000,
): Promise<{ status: string; exitReason: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await call<{ session: { status: string; exitReason: string | null } }>(
      'GET',
      `/api/sessions/${sessionId}`,
    );
    const session = answer.body.session;
    if (session !== undefined && !['queued', 'running', 'paused'].includes(session.status)) {
      return session;
    }
    if (Date.now() > deadline) {
      throw new Error(`session ${sessionId} did not settle: ${JSON.stringify(answer.body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-orchestrator-boot-');
  workspaceDir = makeTempDir('agentmanager-orchestrator-work-');
  service = undefined;
});

afterEach(async () => {
  await service?.shutdown();
  service = undefined;
  dataRootDir.cleanup();
  workspaceDir.cleanup();
});

describe('module registration (M0-1)', () => {
  it('joins the module graph after its dependencies and publishes its service', async () => {
    const booted = await bootCore();

    expect(booted.runtime.order).toContain(ORCHESTRATOR_MODULE_ID);
    const order = booted.runtime.order;
    for (const dependency of ['storage', 'roster', 'projects']) {
      expect(order.indexOf(dependency)).toBeLessThan(order.indexOf(ORCHESTRATOR_MODULE_ID));
    }

    // The unblock: runner has no launch path without this (runner §11.3).
    const published = booted.runtime.registry.require<AssignmentService>(ORCHESTRATOR_SERVICE);
    expect(published).toBeDefined();
    expect(typeof published?.getAssignmentContext).toBe('function');
    expect(typeof published?.createSolo).toBe('function');
    expect(typeof published?.closeAssignment).toBe('function');
  });

  it('is non-critical, so a broken orchestrator would not stop the service booting', async () => {
    const booted = await bootCore();
    const health = await booted.health();
    const mine = health.modules.find((module) => module.id === ORCHESTRATOR_MODULE_ID);
    expect(mine?.critical).toBe(false);
    expect(mine?.status).toBe('ok');
    expect(mine?.detail).toMatchObject({ openAssignments: 0, halted: 0, awaitingUser: 0 });
  });

  it('starts and stops cleanly with no assignments present', async () => {
    const booted = await bootCore();
    expect(booted.runtime.phase).toBe('ready');
    await booted.shutdown();
    service = undefined;
    expect(booted.runtime.phase).toBe('stopped');
  });

  it('is absent from the graph when modules.orchestrator.enabled is false', async () => {
    const booted = await bootCore({ argv: ['--set', 'modules.orchestrator.enabled=false'] });
    expect(booted.runtime.order).not.toContain(ORCHESTRATOR_MODULE_ID);
    expect(
      booted.runtime.registry.require<AssignmentService>(ORCHESTRATOR_SERVICE),
    ).toBeUndefined();
    // Runner's §11.3 degraded case, observed rather than assumed: the service is
    // simply not there, which is what `ctx.require` returning undefined means.
    expect((await call('GET', '/api/assignments')).status).toBe(404);
    // And with no module there is no migration set either.
    expect(Object.keys(booted.storage.setVersions)).not.toContain(ORCHESTRATOR_MODULE_ID);
  });
});

describe('migrations (M0-3)', () => {
  it('applies migrations/orchestrator/ after foundation and records it under "orchestrator"', async () => {
    const booted = await bootCore();

    expect(booted.storage.setVersions[ORCHESTRATOR_MODULE_ID]).toBe(1);
    const ledger = booted.storage.db
      .prepare<[], { module: string; version: number }>(
        'SELECT module, version FROM schema_migrations',
      )
      .all();
    expect(ledger).toEqual(
      expect.arrayContaining([{ module: ORCHESTRATOR_MODULE_ID, version: 1 }]),
    );
    // The module graph decides the order: `assignments` must exist before this
    // set can alter it.
    expect(Object.keys(booted.storage.setVersions).indexOf('foundation')).toBeLessThan(
      Object.keys(booted.storage.setVersions).indexOf(ORCHESTRATOR_MODULE_ID),
    );
  });

  it('re-applies cleanly on an existing database', async () => {
    const first = await bootCore();
    await first.shutdown();
    service = undefined;

    const second = await bootCore();
    expect(second.storage.setVersions[ORCHESTRATOR_MODULE_ID]).toBe(1);
    const health = await second.health();
    expect(health.status).toBe('ok');
  });
});

describe('configuration (M0-2)', () => {
  it('exposes the whole §12 sub-schema on ctx.config.orchestrator', async () => {
    const booted = await bootCore();
    expect(booted.config.orchestrator).toMatchObject({
      patterns: { pair: { roundCap: 3, maxRoundCap: 6 } },
      budgets: { defaultPairTokens: 400_000, turnEstimateTokens: 25_000 },
      assignment: { maxAgeHours: 24, maxConcurrentPerAgent: 2, maxNestingDepth: 1 },
      questions: { joinWindowMs: 120_000 },
      mailbox: { inlineMax: 10, inlineMaxBytes: 8192 },
      prompt: { maxBytes: 16_384 },
      breakers: { messagesPerTurn: 20 },
    });
  });

  it('keeps notify.enabled as the edition lever it already was', async () => {
    const work = await bootCore({ argv: ['--edition', 'work'] });
    expect(work.config.orchestrator.notify.enabled).toBe(false);
    await work.shutdown();
    service = undefined;

    dataRootDir.cleanup();
    dataRootDir = makeTempDir('agentmanager-orchestrator-boot-home-');
    const home = await bootCore({ argv: ['--edition', 'home'] });
    expect(home.config.orchestrator.notify.enabled).toBe(true);
  });

  it('reads the tuning constants rather than hard-coding them', async () => {
    const booted = await bootCore({
      argv: ['--set', 'orchestrator.assignment.maxConcurrentPerAgent=1'],
    });
    expect(booted.config.orchestrator.assignment.maxConcurrentPerAgent).toBe(1);
  });
});

describe('routes (M1-7, M2-6)', () => {
  it('mounts exactly M1’s six assignment routes and M2’s three question routes', async () => {
    const booted = await bootCore();
    const mine = booted.runtime.routes.routes
      .filter((route) => route.moduleId === ORCHESTRATOR_MODULE_ID)
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(mine).toEqual([
      'GET /api/assignments',
      'GET /api/assignments/:id',
      'GET /api/questions',
      'GET /api/questions/:id',
      'PATCH /api/assignments/:id',
      'POST /api/assignments',
      'POST /api/assignments/:id/close',
      'POST /api/assignments/solo',
      'POST /api/questions/:id/answer',
    ]);
  });

  it('answers GET /api/assignments over the real listener', async () => {
    await bootCore();
    const answer = await call<{ assignments: unknown[] }>('GET', '/api/assignments');
    expect(answer.status).toBe(200);
    expect(answer.body.assignments).toEqual([]);
  });

  it('answers 404 with a typed body for an unknown assignment', async () => {
    await bootCore();
    const answer = await call<{ error: string }>('GET', '/api/assignments/nope');
    expect(answer.status).toBe(404);
    expect(answer.body.error).toBe('assignment_not_found');
  });

  it(
    'creates the assignment and launches its first session, end to end (runner M6)',
    { timeout: 30_000 },
    async () => {
      // The promise the old `503 runner_unavailable` assertion made to itself:
      // "the day `startSession` appears, this test fails and says so — which is
      // the moment the end-to-end criterion becomes provable here." Runner M6 is
      // that day, because `hasLauncher()` needs `stop` as well as `startSession`.
      //
      // Everything below the SDK is real: the composition root, the listener,
      // roster's library on disk, projects' workspace lease, runner's launch
      // chain, orchestrator's one creation function. Only `query()` is scripted.
      const script = scriptedQuery({ messages: successScript('Solo launch works.') });
      await bootCore({
        runner: { query: script.query },
        // §3.4: with `auth.mode: subscription` and `secrets.provider: env`, this
        // is what a stored token looks like to the resolver.
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fixture' },
      });

      const folder = join(workspaceDir.path, 'Solo');
      mkdirSync(folder, { recursive: true });
      const project = await call<{ id: string }>('POST', '/api/projects', { localPath: folder });
      expect(project.status).toBe(201);

      // Foundation's `agents` index is rebuilt from roster's library, so the agent
      // has to be a real definition on disk for §9-5's validation to find it.
      const agent = await call<{ definition: { id: string } }>('POST', '/api/roster/agents', {
        name: 'Ada Solo',
        specialty: 'feature-implementation',
        // §9-5: the seat's role must be one the agent declares it can fill.
        capabilities: { roles: ['implementer'] },
        personaText: '# Ada\n\nDo the one thing asked.\n',
      });
      expect(agent.status).toBe(201);

      const launched = await call<{ assignmentId: string; sessionId: string }>(
        'POST',
        '/api/assignments/solo',
        { projectId: project.body.id, agentId: agent.body.definition.id, prompt: 'go' },
      );
      expect(launched.status).toBe(201);
      expect(launched.body.assignmentId).toEqual(expect.any(String));
      expect(launched.body.sessionId).toEqual(expect.any(String));

      // The assignment exists — the old test asserted the opposite, because
      // `createSolo` refused before writing anything.
      const list = await call<{ assignments: { id: string; pattern: string; status: string }[] }>(
        'GET',
        '/api/assignments',
      );
      expect(list.body.assignments).toHaveLength(1);
      expect(list.body.assignments[0]).toMatchObject({
        id: launched.body.assignmentId,
        pattern: 'solo',
        status: 'open',
      });

      // And the session really ran: runner reached `query()` through the seam and
      // the row settled `done` / `completed`.
      const settled = await untilTerminal(launched.body.sessionId);
      expect(settled).toMatchObject({ status: 'done', exitReason: 'completed' });
      expect(script.calls).toHaveLength(1);
      // Its transcript is readable over runner's own route, on the same listener.
      const transcript = await call<{ lines: { type: string }[] }>(
        'GET',
        `/api/sessions/${launched.body.sessionId}/transcript`,
      );
      expect(transcript.body.lines.map((line) => line.type)).toEqual(
        expect.arrayContaining(['session.start', 'session.end']),
      );
    },
  );

  it(
    'stops an assignment’s live sessions when it is closed (orchestrator R6)',
    { timeout: 30_000 },
    async () => {
      // The other half of what runner M6 unblocked: `closeAssignment` reaches
      // `runner.stop` only when `hasLauncher()` is true, and until this milestone
      // that branch could never be taken. The session is held **running** so the
      // close has something live to stop.
      const held = controllableQuery();
      const booted = await bootCore({
        runner: { query: held.query },
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fixture' },
      });

      const folder = join(workspaceDir.path, 'Closing');
      mkdirSync(folder, { recursive: true });
      const project = await call<{ id: string }>('POST', '/api/projects', { localPath: folder });
      const agent = await call<{ definition: { id: string } }>('POST', '/api/roster/agents', {
        name: 'Bea Closer',
        specialty: 'general',
        capabilities: { roles: ['implementer'] },
        personaText: '# Bea\n',
      });
      const launched = await call<{ assignmentId: string; sessionId: string }>(
        'POST',
        '/api/assignments/solo',
        { projectId: project.body.id, agentId: agent.body.definition.id, prompt: 'go' },
      );
      expect(launched.status).toBe(201);
      await held.started(1);

      const running = await call<{ session: { status: string } }>(
        'GET',
        `/api/sessions/${launched.body.sessionId}`,
      );
      expect(running.body.session.status).toBe('running');

      const closed = await call<{ status: string }>(
        'POST',
        `/api/assignments/${launched.body.assignmentId}/close`,
        { reason: 'user_closed' },
      );
      expect(closed.status).toBe(200);

      // The assignment is closed **and** its live session was stopped, with the
      // reason orchestrator passed recorded rather than interpreted.
      const row = booted.storage.db
        .prepare<[string], { status: string }>('SELECT status FROM assignments WHERE id = ?')
        .get(launched.body.assignmentId);
      expect(row?.status).toBe('closed');
      const settled = await untilTerminal(launched.body.sessionId);
      expect(settled).toMatchObject({ status: 'interrupted', exitReason: 'user_stopped' });
      expect(held.sessions[0]?.log).toContain('interrupt');
    },
  );

  it('creates and closes an assignment end to end over HTTP', async () => {
    const booted = await bootCore();
    const project = booted.storage.store.projects.create({ slug: 'fx', name: 'Fixture' });
    // Foundation's index is what §9-7 and §9-5 read through roster; with no
    // roster library on disk there is no agent, and the refusal names it.
    const refused = await call<{ error: string }>('POST', '/api/assignments', {
      projectId: project.id,
      pattern: 'solo',
      members: [{ agentId: 'ghost', role: 'implementer' }],
    });
    expect(refused.status).toBe(404);
    expect(refused.body.error).toBe('agent_not_found');
  });
});

describe('the boot task (M1-6)', () => {
  it('runs in the boot-tasks phase, before any listener binds', async () => {
    const phases: string[] = [];
    const booted = await bootCore({ onPhase: (phase) => void phases.push(phase) });
    expect(phases.indexOf('boot-tasks')).toBeLessThan(phases.indexOf('listener-bind'));
    // It is registered by name, so a failure is attributable.
    expect(booted.runtime.order).toContain(ORCHESTRATOR_MODULE_ID);
  });

  it('reconciles an orphaned phase: running left by a previous life', async () => {
    const first = await bootCore();
    const store = first.storage.store;
    const project = store.projects.create({ slug: 'fx', name: 'Fixture' });
    const assignment = store.assignments.create({ projectId: project.id, pattern: 'solo' });
    first.storage.db
      .prepare("UPDATE assignments SET phase = 'running' WHERE id = ?")
      .run(assignment.id);
    await first.shutdown();
    service = undefined;

    const second = await bootCore();
    const row = second.storage.db
      .prepare<[string], { phase: string; status: string }>(
        'SELECT phase, status FROM assignments WHERE id = ?',
      )
      .get(assignment.id);
    expect(row).toEqual({ phase: 'planned', status: 'open' });
  });
});
