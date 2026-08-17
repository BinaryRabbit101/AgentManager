/**
 * The module's own wiring: the SDK seam, the registry lookups, and the two bus
 * subscriptions.
 *
 * `launch.test.ts` drives the chain directly; this drives
 * `createRunnerModule(...).init(ctx)` — the path production takes — so what is
 * under test here is that the pieces are *connected*: `RunnerModuleOptions.query`
 * reaches `query()`, `ctx.require` reaches roster and projects, orchestrator's
 * `getAssignmentContext` is preferred over runner's stub the moment it appears,
 * and `assignment.closed` releases the workspace lease.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Storage } from '../../storage/index.js';

import type { AssignmentContext } from './contracts.js';
import { createRunnerModule, RUNNER_SERVICE, type RunnerInternals } from './module.js';
import type { RunnerService } from './service.js';
import { makeTempDir, openTestStorage, type TempDir } from './__tests__/helpers.js';
import { scriptedQuery, successScript } from './__tests__/fakeQuery.js';
import { fakeProjects, fakeRoster, fakeSecrets } from './__tests__/launchHarness.js';
import { createTestModuleContext, type TestModuleContext } from './__tests__/moduleContext.js';

let temp: TempDir;
let storage: Storage;

beforeEach(() => {
  temp = makeTempDir('agentmanager-runner-module-launch-');
  storage = openTestStorage(`${temp.path}\\data`);
});

afterEach(() => {
  storage.close();
  temp.cleanup();
});

interface Wired {
  readonly ctx: TestModuleContext;
  readonly internals: RunnerInternals;
  readonly service: RunnerService;
  readonly stop: () => void;
}

function wire(options: {
  readonly query: ReturnType<typeof scriptedQuery>;
  readonly roster?: ReturnType<typeof fakeRoster>;
  readonly projects?: ReturnType<typeof fakeProjects>;
  readonly orchestrator?: unknown;
}): Wired {
  const ctx = createTestModuleContext({
    storage,
    moduleId: 'runner',
    secrets: fakeSecrets({ 'claude.oauthToken': 'sk-ant-oat01-fixture' }),
  });
  ctx.register('roster', options.roster ?? fakeRoster());
  ctx.register('projects', options.projects ?? fakeProjects());
  if (options.orchestrator !== undefined) ctx.register('orchestrator', options.orchestrator);

  let internals: RunnerInternals | undefined;
  const handle = createRunnerModule(() => storage, {
    query: options.query.query,
    onReady: (ready) => {
      internals = ready;
    },
  }).init(ctx);
  if (internals === undefined) throw new Error('the module did not report its internals');
  if (handle instanceof Promise) throw new Error('runner initialises synchronously');

  const service = ctx.provided.get(RUNNER_SERVICE) as RunnerService;
  return {
    ctx,
    internals,
    service,
    stop: () => {
      void handle.stop?.();
    },
  };
}

function seed(): { projectId: string; assignmentId: string; agentId: string } {
  const project = storage.store.projects.create({ slug: 'fixture', name: 'Fixture' });
  storage.store.agents.upsert({ id: 'agent-1', name: 'Agent One' });
  const assignment = storage.store.assignments.create({ projectId: project.id, pattern: 'solo' });
  return { projectId: project.id, assignmentId: assignment.id, agentId: 'agent-1' };
}

describe('the injectable SDK seam', () => {
  it('drives a whole session through the published service', async () => {
    const script = scriptedQuery({ messages: successScript('Module wiring works.') });
    const wired = wire({ query: script });
    try {
      const ids = seed();
      const started = await wired.service.startSession({
        assignmentId: ids.assignmentId,
        agentId: ids.agentId,
        projectId: ids.projectId,
        prompt: 'Prove the wiring.',
      });
      const settled = await wired.service.awaitSettled(started.sessionId);

      expect(settled.status).toBe('done');
      expect(settled.exitReason).toBe('completed');
      expect(script.calls).toHaveLength(1);
      // The transcript is readable through the same service the UI uses.
      const tail = await wired.service.getTranscriptTail(started.sessionId);
      expect(tail.lines.map((line) => line.type)).toContain('session.start');
      expect(tail.lines.map((line) => line.type)).toContain('session.end');
    } finally {
      wired.stop();
    }
  });
});

describe('the registry lookups (§11.3)', () => {
  it('uses runner’s stub while orchestrator is absent', async () => {
    const script = scriptedQuery({ messages: successScript() });
    const roster = fakeRoster();
    const wired = wire({ query: script, roster });
    try {
      const ids = seed();
      const started = await wired.service.startSession({
        assignmentId: ids.assignmentId,
        agentId: ids.agentId,
        projectId: ids.projectId,
        prompt: 'x',
      });
      await wired.service.awaitSettled(started.sessionId);

      // The stub's answer, straight off the persisted row.
      expect(roster.inputs[0]?.assignment).toEqual({
        id: ids.assignmentId,
        write: true,
        scopeRules: {},
      });
    } finally {
      wired.stop();
    }
  });

  it('prefers orchestrator’s getAssignmentContext the moment it is registered', async () => {
    const script = scriptedQuery({ messages: successScript() });
    const roster = fakeRoster();
    const wired = wire({ query: script, roster });
    try {
      const ids = seed();
      const context: AssignmentContext = {
        id: ids.assignmentId,
        pattern: 'pair',
        status: 'open',
        role: 'implementer',
        write: false,
        scopeRules: { deny: ['Bash'], ask: ['Write'] },
        tokenBudget: 5000,
        tokensUsed: 12,
        roundCap: 3,
        roundsUsed: 1,
      };
      // Registered *after* the module initialised, which is the whole point:
      // the provider is resolved per launch, so orchestrator M1 replacing the
      // stub is a registry lookup rather than a code change.
      wired.ctx.register('orchestrator', {
        getAssignmentContext: () => Promise.resolve(context),
      });

      const started = await wired.service.startSession({
        assignmentId: ids.assignmentId,
        agentId: ids.agentId,
        projectId: ids.projectId,
        prompt: 'x',
      });
      await wired.service.awaitSettled(started.sessionId);

      expect(roster.inputs[0]?.assignment).toEqual({
        id: ids.assignmentId,
        role: 'implementer',
        write: false,
        scopeRules: { deny: ['Bash'], ask: ['Write'] },
      });
    } finally {
      wired.stop();
    }
  });

  it('refuses the launch when projects is not on the registry (fatal, §11.3)', async () => {
    const script = scriptedQuery({ messages: successScript() });
    const ctx = createTestModuleContext({ storage, moduleId: 'runner' });
    ctx.register('roster', fakeRoster());
    let internals: RunnerInternals | undefined;
    const handle = createRunnerModule(() => storage, {
      query: script.query,
      onReady: (ready) => {
        internals = ready;
      },
    }).init(ctx);
    expect(internals).toBeDefined();
    expect(handle).not.toBeInstanceOf(Promise);

    const ids = seed();
    const service = ctx.provided.get(RUNNER_SERVICE) as RunnerService;
    const started = await service.startSession({
      assignmentId: ids.assignmentId,
      agentId: ids.agentId,
      projectId: ids.projectId,
      prompt: 'x',
    });
    const settled = await service.awaitSettled(started.sessionId);
    expect(settled.status).toBe('failed');
    expect(settled.exitReason).toBe('launch_failed');
  });
});

describe('the bus subscriptions', () => {
  it('releases the workspace lease on assignment.closed (§15.1-5)', async () => {
    const script = scriptedQuery({ messages: successScript() });
    const projects = fakeProjects();
    const wired = wire({ query: script, projects });
    try {
      const ids = seed();
      const started = await wired.service.startSession({
        assignmentId: ids.assignmentId,
        agentId: ids.agentId,
        projectId: ids.projectId,
        prompt: 'x',
      });
      await wired.service.awaitSettled(started.sessionId);
      expect(projects.releases).toHaveLength(0);

      wired.ctx.bus.emit({
        type: 'assignment.closed',
        ids: { assignmentId: ids.assignmentId },
        payload: { closeReason: 'user_closed' },
      });
      // The handler is `void`-ed into the microtask queue, as a bus listener
      // must be — one turn is enough for the release to land.
      await Promise.resolve();
      await Promise.resolve();
      expect(projects.releases).toEqual(['lease-1']);
    } finally {
      wired.stop();
    }
  });

  it('stops admitting once the module stops', async () => {
    const script = scriptedQuery({ messages: successScript() });
    const wired = wire({ query: script });
    const ids = seed();
    wired.stop();

    const started = await wired.service.startSession({
      assignmentId: ids.assignmentId,
      agentId: ids.agentId,
      projectId: ids.projectId,
      prompt: 'x',
    });
    // The row exists — a queue entry is pure intent and loses nothing (§9.1) —
    // but nothing is admitted.
    expect(wired.internals.sessions.require(started.sessionId).status).toBe('queued');
    expect(script.calls).toHaveLength(0);
  });
});
