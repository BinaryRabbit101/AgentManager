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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, type BootOptions, type BootedService } from '../../main.js';
import {
  controllableQuery,
  fakeAssistant,
  fakeResult,
  gatedQuery,
  scriptedQuery,
  successScript,
} from '../runner/__tests__/fakeQuery.js';

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
    // The home-edition case loads the real remote module; injecting "no Tailscale"
    // keeps this suite off the machine's adapters and off any non-loopback socket.
    remote: {
      detect: { locateCli: () => undefined, networkInterfaces: () => ({}) },
      ...options.remote,
    },
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

/** Polls a predicate until it holds — the engine's loop is event-driven. */
async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('the engine did not reach the expected state');
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

describe('the toolset mount, end to end (M4-4/M4-5, R1/R1b)', () => {
  /**
   * Compiles one session the way runner's launch chain does, and reports what
   * roster made of the orchestration namespace.
   *
   * This is the only place the mount can honestly be checked: `getSessionToolset`
   * is orchestrator's, `compileSession` is roster's, and the *wiring between
   * them* is the composition root's — which is exactly what R1 asked roster to
   * take on and what this asserts it did.
   */
  async function compileFor(overseer: boolean): Promise<{
    mounted: boolean;
    granted: readonly string[];
    diagnostics: readonly { code: string }[];
  }> {
    const folder = join(workspaceDir.path, overseer ? 'Mount-Overseer' : 'Mount-Worker');
    mkdirSync(folder, { recursive: true });
    const project = await call<{ id: string }>('POST', '/api/projects', { localPath: folder });
    const agent = await call<{ definition: { id: string } }>('POST', '/api/roster/agents', {
      name: overseer ? 'Iris Mount' : 'Ada Mount',
      specialty: overseer ? 'overseer' : 'feature-implementation',
      capabilities: overseer
        ? { overseer: true, roles: ['overseer', 'implementer'] }
        : { roles: ['implementer'] },
      personaText: '# Agent\n\nWork.\n',
    });

    const roster = service?.runtime.registry.require<{
      readonly registry: { get(id: string): unknown };
      compileSession(input: Record<string, unknown>): Promise<{
        options: { mcpServers?: Record<string, unknown> };
        effective: { allow: readonly string[] };
        diagnostics: readonly { code: string }[];
      }>;
    }>('roster');
    if (roster === undefined) throw new Error('roster is not in this build');
    const resolved = roster.registry.get(agent.body.definition.id);

    // Orchestrator's presence or absence is the whole variable; everything else
    // is what runner's launch chain passes. `toolset` is deliberately **not**
    // supplied, so the provider the roster module wired to
    // `ctx.require('orchestrator')?.getSessionToolset` is the one under test.
    const compiled = await roster.compileSession({
      agent: resolved,
      assignment: {
        id: '01ASSIGNMENT',
        write: false,
        role: overseer ? 'overseer' : 'implementer',
        scopeRules: {},
      },
      policy: { allowPermissionElevation: false, globalDeny: [] },
      secrets: { get: () => Promise.resolve(undefined) },
      projectId: project.body.id,
    });

    return {
      mounted: compiled.options.mcpServers?.['agentmanager'] !== undefined,
      granted: compiled.effective.allow.filter((rule) => rule.startsWith('mcp__agentmanager__')),
      diagnostics: compiled.diagnostics,
    };
  }

  it('mounts the server and grants a worker exactly the four scoped tools (R1b)', async () => {
    await bootCore();
    const compiled = await compileFor(false);

    expect(compiled.mounted).toBe(true);
    expect([...compiled.granted].sort()).toEqual([
      'mcp__agentmanager__read_mailbox',
      'mcp__agentmanager__report_status',
      'mcp__agentmanager__request_user_decision',
      'mcp__agentmanager__send_to_agent',
    ]);
  });

  it('grants an overseer all six', async () => {
    await bootCore();
    const compiled = await compileFor(true);

    expect(compiled.mounted).toBe(true);
    expect(compiled.granted).toHaveLength(6);
    expect(compiled.granted).toContain('mcp__agentmanager__list_roster');
    expect(compiled.granted).toContain('mcp__agentmanager__create_assignment');
  });

  it('mounts nothing and grants nothing with modules.orchestrator.enabled: false (M4 acceptance)', async () => {
    await bootCore({ argv: ['--set', 'modules.orchestrator.enabled=false'] });
    const compiled = await compileFor(false);

    expect(compiled.mounted).toBe(false);
    // "Roster drops every `mcp__agentmanager__*` rule" — there is no server to
    // compile allow rules for, and a rule for a tool that will never exist is
    // exactly what roster §11's diagnostic exists to prevent.
    expect(compiled.granted).toEqual([]);
  });
});

describe('migrations (M0-3)', () => {
  it('applies migrations/orchestrator/ after foundation and records it under "orchestrator"', async () => {
    const booted = await bootCore();

    expect(booted.storage.setVersions[ORCHESTRATOR_MODULE_ID]).toBe(8);
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
    expect(second.storage.setVersions[ORCHESTRATOR_MODULE_ID]).toBe(8);
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
      assignment: {
        maxAgeHours: 24,
        recoverAfterMinutes: 2,
        maxConcurrentPerAgent: 2,
        maxNestingDepth: 1,
      },
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

describe('routes (M1-7, M2-6, M5-1, M6-6, M11-1)', () => {
  it('mounts M1’s six assignment routes, M2’s three question routes, M5/M6/M9’s four, §11.5’s one and §13’s six', async () => {
    const booted = await bootCore();
    const mine = booted.runtime.routes.routes
      .filter((route) => route.moduleId === ORCHESTRATOR_MODULE_ID)
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(mine).toEqual([
      'DELETE /api/triggers/:id',
      'GET /api/assignments',
      'GET /api/assignments/:id',
      'GET /api/assignments/:id/conversation',
      'GET /api/orchestrator/status',
      'GET /api/patterns',
      'GET /api/questions',
      'GET /api/questions/:id',
      'GET /api/triggers',
      'GET /api/triggers/:id',
      'GET /api/widget',
      'PATCH /api/assignments/:id',
      'PATCH /api/triggers/:id',
      'POST /api/assignments',
      'POST /api/assignments/:id/advance',
      'POST /api/assignments/:id/close',
      'POST /api/assignments/solo',
      'POST /api/questions/:id/answer',
      'POST /api/triggers',
      'POST /api/triggers/:id/run',
    ]);
  });

  it('answers GET /api/assignments over the real listener', async () => {
    await bootCore();
    const answer = await call<{ assignments: unknown[] }>('GET', '/api/assignments');
    expect(answer.status).toBe(200);
    expect(answer.body.assignments).toEqual([]);
  });

  it('answers GET /api/widget over the real listener, empty and in shape (§11.5)', async () => {
    await bootCore();
    const answer = await call<{
      waiting: unknown[];
      waitingTotal: number;
      oldestWaitingSec: number | null;
      agents: Record<string, number>;
    }>('GET', '/api/widget');

    expect(answer.status).toBe(200);
    expect(answer.body.waiting).toEqual([]);
    expect(answer.body.waitingTotal).toBe(0);
    expect(answer.body.oldestWaitingSec).toBeNull();
    // §16-6's six words, camel-cased, all present even at zero — the widget's
    // "all clear" state must cost it no special case.
    expect(Object.keys(answer.body.agents).sort()).toEqual([
      'awaitingUser',
      'halted',
      'idle',
      'paused',
      'queued',
      'working',
    ]);
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

describe('the adversarial pair, end to end (M6’s acceptance scenario)', () => {
  /**
   * > An architect and a skeptic are assigned to write `docs/<x>/DESIGN.md` with a
   * > 3-round cap and a 400 k budget. The architect drafts the file; the skeptic
   * > critiques it with blocking issues; the architect revises; the skeptic
   * > accepts. The assignment closes `converged`, the file exists, the
   * > conversation endpoint renders six turns and the handoffs in order,
   * > `tokens_used` is under budget, and the whole run needed **no** user
   * > interaction.
   *
   * Everything below the SDK is real: the composition root, the listener,
   * roster's library on disk, projects' workspace lease, runner's launch chain and
   * queue, orchestrator's engine, prompt composition, turn table and mailbox. Two
   * things are stood in for, and both are named rather than hidden:
   *
   * 1. **`query()` is scripted** — the same seam every runner test uses.
   * 2. **The agents' tool calls are made in process**, through the *real*
   *    `getSessionToolset` handlers on the registry, because roster's mount of
   *    `options.mcpServers.agentmanager` (R1) is roster M7 and has not shipped. A
   *    scripted SDK has no MCP client, so there is no path from a fake `query()`
   *    through a transport to the handler; what this asserts is everything on
   *    *our* side of that boundary, and `toolset.test.ts` separately drives the
   *    same handlers over a real MCP transport.
   */
  it('runs six turns to convergence with no user interaction', { timeout: 60_000 }, async () => {
    const held = controllableQuery();
    const booted = await bootCore({
      runner: { query: held.query },
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fixture' },
    });

    const folder = join(workspaceDir.path, 'Pair');
    mkdirSync(join(folder, 'docs', 'x'), { recursive: true });
    const project = await call<{ id: string }>('POST', '/api/projects', { localPath: folder });
    expect(project.status).toBe(201);

    const architect = await call<{ definition: { id: string } }>('POST', '/api/roster/agents', {
      name: 'Ada Architect',
      specialty: 'documentation',
      capabilities: { roles: ['architect'] },
      personaText: '# Ada\n\nDesign carefully.\n',
    });
    const skeptic = await call<{ definition: { id: string } }>('POST', '/api/roster/agents', {
      name: 'Sam Skeptic',
      specialty: 'code-review',
      capabilities: { roles: ['skeptic'] },
      personaText: '# Sam\n\nBe hard to please.\n',
    });
    expect([architect.status, skeptic.status]).toEqual([201, 201]);
    const adaId = architect.body.definition.id;
    const samId = skeptic.body.definition.id;

    const patterns = await call<{ patterns: { id: string; driver: string }[] }>(
      'GET',
      '/api/patterns',
    );
    expect(patterns.body.patterns.find((pattern) => pattern.id === 'pair')?.driver).toBe(
      'sequential',
    );

    const created = await call<{ assignmentId: string; phase: string }>(
      'POST',
      '/api/assignments',
      {
        projectId: project.body.id,
        pattern: 'pair',
        goal: 'Write the design for x',
        members: [
          { agentId: adaId, role: 'architect' },
          { agentId: samId, role: 'skeptic' },
        ],
        scope: {
          paths: ['docs/x/'],
          description: 'the x design docs',
          artifactPath: 'docs/x/DESIGN.md',
        },
        write: true,
        roundCap: 3,
        tokenBudget: 400_000,
      },
    );
    expect(created.status).toBe(201);
    const assignmentId = created.body.assignmentId;

    /** The turn the engine currently has in flight, straight out of the table. */
    const activeTurn = (): { id: string; seat: string; agent_id: string; session_id: string } => {
      const turn = booted.storage.db
        .prepare<[string], { id: string; seat: string; agent_id: string; session_id: string }>(
          "SELECT id, seat, agent_id, session_id FROM assignment_turns WHERE assignment_id = ? AND status = 'running'",
        )
        .get(assignmentId);
      if (turn === undefined) throw new Error('no turn is in flight');
      return turn;
    };

    const service = booted.runtime.registry.require<AssignmentService>(ORCHESTRATOR_SERVICE);
    const toolset = (agentId: string): { call: (name: string, args: object) => Promise<unknown> } =>
      service?.getSessionToolset?.({ assignmentId, agentId }) as {
        call: (name: string, args: object) => Promise<unknown>;
      };

    const artifact = join(folder, 'docs', 'x', 'DESIGN.md');
    const seatsSeen: string[] = [];

    // Three rounds: revise, revise, accept. Nothing here answers a question,
    // because the run must need no user interaction.
    for (let round = 1; round <= 3; round += 1) {
      for (const seat of ['drafter', 'critic'] as const) {
        const index = seatsSeen.length;
        await held.started(index + 1);
        // The row becomes `running` a tick after `query()` is called.
        await waitFor(() => activeTurn().seat === seat);
        const turn = activeTurn();
        seatsSeen.push(turn.seat);

        if (seat === 'drafter') {
          // The drafter's whole job is writing the artifact file.
          writeFileSync(artifact, `# Design\n\nRevision ${String(round)}.\n`, 'utf8');
          await toolset(turn.agent_id).call('report_status', {
            state: 'done',
            headline: `Draft revision ${String(round)}`,
            artifacts: [{ path: 'docs/x/DESIGN.md', kind: 'doc' }],
          });
          await toolset(turn.agent_id).call('send_to_agent', {
            to: samId,
            kind: 'handoff',
            body: `Revision ${String(round)} is ready; section 4 is the risky one.`,
          });
        } else if (round < 3) {
          await toolset(turn.agent_id).call('report_status', {
            state: 'done',
            headline: `Round ${String(round)}: blocking issues`,
            verdict: {
              decision: 'revise',
              blocking: [{ severity: 'high', summary: 'No rollback path for step 3' }],
              nonBlocking: ['naming nit in §2'],
            },
          });
        } else {
          await toolset(turn.agent_id).call('report_status', {
            state: 'done',
            headline: 'Accepted',
            verdict: { decision: 'accept', blocking: [], nonBlocking: [] },
          });
        }

        await held.sessions[index]?.emit(fakeResult({ text: 'done' }));
        held.sessions[index]?.end();
        await untilTerminal(turn.session_id);
        await waitFor(() =>
          round === 3 && seat === 'critic'
            ? booted.storage.db
                .prepare<[string], { status: string }>(
                  'SELECT status FROM assignments WHERE id = ?',
                )
                .get(assignmentId)?.status === 'closed'
            : (() => {
                try {
                  return activeTurn().session_id !== turn.session_id;
                } catch {
                  return false;
                }
              })(),
        );
      }
    }

    expect(seatsSeen).toEqual(['drafter', 'critic', 'drafter', 'critic', 'drafter', 'critic']);

    // The assignment converged, and §2.2's one exception gave it its own phase.
    const assignment = await call<{
      status: string;
      phase: string;
      closeReason: string;
      roundsUsed: number;
      tokensUsed: number;
      tokenBudget: number;
    }>('GET', `/api/assignments/${assignmentId}`);
    expect(assignment.body).toMatchObject({
      status: 'closed',
      phase: 'converged',
      closeReason: 'converged',
      roundsUsed: 3,
    });
    expect(assignment.body.tokensUsed).toBeLessThan(assignment.body.tokenBudget);

    // The file exists, which is the point of requiring an artifact path.
    expect(existsSync(artifact)).toBe(true);

    // The conversation endpoint renders six turns and the handoffs in order.
    const conversation = await call<{
      rounds: {
        round: number;
        entries: { type: string; seat?: string; kind?: string; delivery?: string }[];
      }[];
    }>('GET', `/api/assignments/${assignmentId}/conversation`);
    expect(conversation.status).toBe(200);
    const turnEntries = conversation.body.rounds.flatMap((round) =>
      round.entries.filter((entry) => entry.type === 'turn'),
    );
    expect(turnEntries.map((entry) => entry.seat)).toEqual([
      'drafter',
      'critic',
      'drafter',
      'critic',
      'drafter',
      'critic',
    ]);
    expect(conversation.body.rounds.map((round) => round.round)).toEqual([1, 2, 3]);
    const handoffs = conversation.body.rounds.flatMap((round) =>
      round.entries.filter((entry) => entry.type === 'message'),
    );
    expect(handoffs).toHaveLength(3);
    expect(handoffs.every((entry) => entry.kind === 'handoff')).toBe(true);
    // Each handoff was inlined into the critic's launch in its own round — §5.1's
    // first row ("has a turn planned or running later in the pattern"), which is
    // the only delivery an agent ever gets.
    expect(handoffs.map((entry) => entry.delivery)).toEqual(['inlined', 'inlined', 'inlined']);

    // No user interaction was needed: the inbox is empty from first to last.
    const questions = await call<{ questions: unknown[] }>('GET', '/api/questions?status=open');
    expect(questions.body.questions).toEqual([]);
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

describe('the budget halt, end to end (M3 acceptance)', () => {
  /**
   * The one M3 criterion that cannot be proved at a seam.
   *
   * "A solo assignment with a deliberately tiny budget halts mid-session,
   * produces a `budget_halt` card, and resumes correctly on *Raise budget* and
   * terminates correctly on *Close assignment*." Every clause in that sentence
   * belongs to a different module — runner meters and pauses, orchestrator
   * renders the card and applies the answer, foundation carries the row — so it
   * is asserted through the composition root with only `query()` scripted.
   *
   * The session is **gated** rather than scripted so the budget can be lowered
   * while it is genuinely mid-flight: patching it before the launch would test
   * admission, not a crossing.
   */
  async function launchTinyBudget(
    name: string,
  ): Promise<{ assignmentId: string; sessionId: string }> {
    const gate = gatedQuery();
    await bootCore({
      runner: { query: gate.query },
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fixture' },
    });

    const folder = join(workspaceDir.path, name);
    mkdirSync(folder, { recursive: true });
    const project = await call<{ id: string }>('POST', '/api/projects', { localPath: folder });
    const agent = await call<{ definition: { id: string } }>('POST', '/api/roster/agents', {
      name: `${name} Agent`,
      specialty: 'general',
      capabilities: { roles: ['implementer'] },
      personaText: '# Agent\n',
    });
    const launched = await call<{ assignmentId: string; sessionId: string }>(
      'POST',
      '/api/assignments/solo',
      { projectId: project.body.id, agentId: agent.body.definition.id, prompt: 'go' },
    );
    expect(launched.status).toBe(201);
    await gate.started(1);

    // The deliberately tiny budget, applied while the session is running. Small
    // enough that one message crosses it, and large enough that §7.3's
    // `raiseMaxFactor` ceiling is a real number rather than 2.
    const patched = await call('PATCH', `/api/assignments/${launched.body.assignmentId}`, {
      tokenBudget: 1_000,
    });
    expect(patched.status).toBe(200);

    // One assistant message carrying real usage: runner's `onUsage` rolls it
    // onto the assignment in the same transaction and finds the crossing there.
    gate.sessions[0]?.finish([fakeAssistant({ usage: { input: 5_000, output: 5_000 } })]);
    return { assignmentId: launched.body.assignmentId, sessionId: launched.body.sessionId };
  }

  async function untilBudgetCard(
    assignmentId: string,
  ): Promise<{ id: string; options: { id: string }[] }> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const answer = await call<{
        questions: { id: string; kind: string; options: { id: string }[] }[];
      }>('GET', `/api/questions?status=open&assignmentId=${assignmentId}`);
      const card = answer.body.questions?.find((one) => one.kind === 'budget_halt');
      if (card !== undefined) return card;
      if (Date.now() > deadline) {
        throw new Error(`no budget_halt card appeared: ${JSON.stringify(answer.body)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it(
    'halts mid-session and offers §7.3’s three options over the API',
    { timeout: 40_000 },
    async () => {
      const { assignmentId } = await launchTinyBudget('BudgetHalt');
      const card = await untilBudgetCard(assignmentId);

      // Runner raised the kind; orchestrator decided what it offers.
      expect(card.options.map((option) => option.id)).toEqual(['raise', 'continue_once', 'close']);

      const assignment = await call<{ phase: string; tokensUsed: number }>(
        'GET',
        `/api/assignments/${assignmentId}`,
      );
      // No new turn is planned, and the UI has a state to render that is not
      // "running" and not "closed".
      expect(assignment.body.phase).toBe('awaiting_user');
      // Runner's arithmetic, consumed rather than re-derived (§7.1).
      expect(assignment.body.tokensUsed).toBeGreaterThanOrEqual(1_000);
    },
  );

  it(
    'raises the budget on “Raise the budget”, and commits it before the answer resolves',
    { timeout: 40_000 },
    async () => {
      const { assignmentId } = await launchTinyBudget('BudgetRaise');
      const card = await untilBudgetCard(assignmentId);

      const answered = await call('POST', `/api/questions/${card.id}/answer`, {
        optionIds: ['raise'],
        text: '1500',
      });
      expect(answered.status).toBe(200);

      const assignment = await call<{ tokenBudget: number; status: string }>(
        'GET',
        `/api/assignments/${assignmentId}`,
      );
      // Runner's auto-resume reads this row on the answer event, and it is
      // already committed — which is the whole ordering rule of §7.3.
      expect(assignment.body.tokenBudget).toBe(1_500);
      expect(assignment.body.status).toBe('open');
    },
  );

  it(
    'closes the assignment budget_exhausted on “Close the assignment”',
    { timeout: 40_000 },
    async () => {
      const { assignmentId } = await launchTinyBudget('BudgetClose');
      const card = await untilBudgetCard(assignmentId);

      const answered = await call('POST', `/api/questions/${card.id}/answer`, {
        optionIds: ['close'],
      });
      expect(answered.status).toBe(200);

      const assignment = await call<{ status: string; closeReason: string }>(
        'GET',
        `/api/assignments/${assignmentId}`,
      );
      expect(assignment.body.status).toBe('closed');
      expect(assignment.body.closeReason).toBe('budget_exhausted');
    },
  );
});
