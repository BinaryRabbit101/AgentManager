/**
 * `POST /api/roster/agents/:id/validate` — the dry-run compile of DESIGN §9.1.
 *
 * The endpoint the ui's launch flow was written against and has been degrading
 * without: `web/src/launch/permissionPreview.ts` asks for it once per agent ×
 * project and, on a `404`, replaces the panel with "permission preview available
 * soon". Its accessor reads exactly two fields — `effective` and `diagnostics` —
 * so those two are what these tests hold the response to, byte for byte in
 * shape.
 *
 * §9.1's reason, which is the reason the tests assert on *sameness* rather than
 * on plausibility: "before launching, show the user the effective permission set
 * for this agent on this project, including any elevation. Permission
 * composition that the user cannot see is permission composition they will not
 * trust."
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { effectivePermissionsSchema } from './contracts.js';
import { compileSession } from './compileSession.js';
import { createRosterRoutes } from './routes.js';
import {
  createRosterService,
  type ProjectDefaultsProvider,
  type RosterService,
} from './service.js';
import type { PermissionPolicy } from './permissions.js';
import {
  callRoute,
  makeHarness,
  makeTempDir,
  silentLogger,
  writeFixtureAgent,
  type Harness,
  type TempDir,
} from './__tests__/helpers.js';

const STRICT_POLICY: PermissionPolicy = {
  allowPermissionElevation: false,
  globalDeny: ['Bash(curl*)'],
};

const PROJECT: ProjectDefaultsProvider = {
  get: (projectId) => {
    if (projectId !== 'littlepocketmuseum') throw new Error('no such project');
    return {
      id: projectId,
      localPath: 'C:\\code\\littlepocketmuseum',
      defaults: {
        permissions: { deny: ['Bash(git push*)'], ask: ['Edit'] },
        permissionElevation: { allow: ['Bash(npm install*)'], reason: 'sandbox project' },
      },
    };
  },
};

let temp: TempDir;
let harness: Harness;

function serviceWith(
  options: {
    readonly policy?: PermissionPolicy;
    readonly projects?: ProjectDefaultsProvider | undefined;
  } = {},
): RosterService {
  const service = createRosterService({
    store: harness.store,
    uiState: harness.uiState,
    agents: harness.storage.store.agents,
    sessions: harness.storage.store.sessions,
    bus: harness.bus,
    policy: options.policy ?? STRICT_POLICY,
    projects: () => options.projects ?? PROJECT,
  });
  // Its own registry, loaded from the same library the harness wrote into.
  service.load();
  return service;
}

beforeEach(() => {
  temp = makeTempDir('agentmanager-roster-validate-');
  harness = makeHarness({ dataRoot: temp.path });
  writeFixtureAgent(harness.libraryRoot, 'coder');
  harness.service.reload();
});

afterEach(() => {
  harness.close();
  temp.cleanup();
});

describe('the dry-run compile (DESIGN §9.1)', () => {
  it('returns the same EffectivePermissions the runner would get for the pair', async () => {
    const service = serviceWith();
    const result = await service.validate('priya-bugfix', { projectId: 'littlepocketmuseum' });

    // The contract shape, validated by the contract's own schema.
    expect(effectivePermissionsSchema.safeParse(result.effective).success).toBe(true);

    // And the same set the compiler produces for the same inputs, field for
    // field: the endpoint runs the one composer, it does not have its own.
    const agent = service.registry.get('priya-bugfix');
    expect(agent).toBeDefined();
    const compiled = await compileSession({
      agent: agent!,
      project: {
        projectId: 'littlepocketmuseum',
        cwd: 'C:\\code\\littlepocketmuseum',
        permissionOverride: { deny: ['Bash(git push*)'], ask: ['Edit'] },
        elevation: { allow: ['Bash(npm install*)'], reason: 'sandbox project' },
      },
      assignment: { id: 'roster-validate', write: true },
      policy: STRICT_POLICY,
      baseEnv: {},
      secrets: { get: () => Promise.resolve(undefined) },
    });

    expect(result.effective).toEqual(compiled.effective);
    // The project's narrowing is really in force, and the global deny with it.
    expect(result.effective.deny).toContain('Bash(git push*)');
    expect(result.effective.deny).toContain('Bash(curl*)');
    expect(result.effective.ask).toContain('Edit');
  });

  it('flags the elevation the project declares, and says it was not applied', async () => {
    const service = serviceWith();
    const result = await service.validate('priya-bugfix', { projectId: 'littlepocketmuseum' });

    expect(result.declaredElevation).toEqual({
      allow: ['Bash(npm install*)'],
      reason: 'sandbox project',
    });
    // The work edition: declared, refused, and *visible* — shown disabled with a
    // reason rather than hidden (ui §6).
    expect(result.allowPermissionElevation).toBe(false);
    expect(result.effective.elevation).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'roster.permissions.elevation-dropped',
    );

    // …and applied when policy allows it, on the same inputs.
    const permissive = serviceWith({
      policy: { allowPermissionElevation: true, globalDeny: [] },
    });
    const applied = await permissive.validate('priya-bugfix', { projectId: 'littlepocketmuseum' });
    expect(applied.effective.elevation).toEqual({
      allow: ['Bash(npm install*)'],
      reason: 'sandbox project',
    });
  });

  it('composes the roster baseline alone when no project is named', async () => {
    const service = serviceWith();
    const result = await service.validate('priya-bugfix', {});

    expect(result.projectId).toBeNull();
    expect(result.declaredElevation).toBeNull();
    expect(result.effective.allow).toContain('Read');
    expect(result.assumedWriteAccess).toBe(true);
  });

  it('shows what a read-only assignment would narrow it to', async () => {
    const service = serviceWith();
    const readOnly = await service.validate('priya-bugfix', { write: false });

    expect(readOnly.assumedWriteAccess).toBe(false);
    expect(readOnly.effective.deny).toContain('Edit');
    expect(readOnly.effective.allow).not.toContain('Edit');
  });
});

describe('the route (DESIGN §9.1)', () => {
  it('answers 200 with { effective, diagnostics } — the two fields the ui reads', async () => {
    const routes = createRosterRoutes({ service: serviceWith(), logger: silentLogger() });
    const answer = await callRoute(routes, 'POST', '/api/roster/agents/:id/validate', {
      params: { id: 'priya-bugfix' },
      body: { projectId: 'littlepocketmuseum' },
    });

    expect(answer.status).toBe(200);
    const body = answer.body as { effective?: unknown; diagnostics?: unknown };
    expect(body.effective).toBeDefined();
    expect(Array.isArray(body.diagnostics)).toBe(true);
    // The ui's `ValidateResponse` narrows on exactly this (permissionPreview.ts).
    const effective = body.effective as Record<string, unknown>;
    for (const key of ['mode', 'allow', 'deny', 'ask', 'elevation']) {
      expect(Object.keys(effective)).toContain(key);
    }
  });

  it('is a 404 for an unknown agent and for an unknown project, not a 500', async () => {
    const routes = createRosterRoutes({ service: serviceWith(), logger: silentLogger() });

    const noAgent = await callRoute(routes, 'POST', '/api/roster/agents/:id/validate', {
      params: { id: 'nobody' },
      body: {},
    });
    expect(noAgent.status).toBe(404);

    const noProject = await callRoute(routes, 'POST', '/api/roster/agents/:id/validate', {
      params: { id: 'priya-bugfix' },
      body: { projectId: 'not-a-project' },
    });
    expect(noProject.status).toBe(404);
    expect((noProject.body as { error?: string }).error).toBe('project_not_found');
  });

  it('never returns a secret value, even when the agent has integrations', async () => {
    writeFixtureAgent(harness.libraryRoot, 'email-responder');
    harness.service.reload();
    const routes = createRosterRoutes({ service: serviceWith(), logger: silentLogger() });

    const answer = await callRoute(routes, 'POST', '/api/roster/agents/:id/validate', {
      params: { id: 'marcus-inbox' },
      body: {},
    });

    expect(answer.status).toBe(200);
    // The preview compiles with a placeholder for an unresolved ref rather than
    // refusing, and the placeholder never reaches the response — the body
    // carries permissions and diagnostics, not options.
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain('unresolved:');
    expect(text).not.toContain('GMAIL_TOKEN');
    expect(text).not.toContain('ya29.');
  });
});
