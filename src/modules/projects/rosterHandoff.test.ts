/**
 * What projects hands roster, proven against roster's real compiler (projects
 * IMPLEMENTATION M4).
 *
 * M4's acceptance is deliberately worded end-to-end — "verified end-to-end
 * against roster's compiler, not restated locally" — because the interesting
 * claims are all about a boundary:
 *
 * - "A project `allow` rule not present in the agent's baseline is dropped,
 *   unless it is declared under `permissionElevation`";
 * - "elevation is refused with a diagnostic when `policy.allowPermissionElevation`
 *   is false";
 * - "Env entries come back in projects' declared order, positioned after
 *   foundation's `agentEnv` and before the assignment's in roster's merge";
 * - "an unresolvable `secretRef` fails the launch in roster's compiler with a
 *   named error rather than yielding an empty value".
 *
 * Every one of those is a statement about what roster does with what this
 * element produces, so the test imports roster's `compilePermissions` and
 * `compileSession` directly and feeds them a launch context built by the real
 * projects service against a real SQLite file. **Test code is exempt from the
 * no-feature-module-imports-another rule; production code here is not, and
 * imports nothing from roster.**
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Secret, type SecretResolver } from '../../secrets/index.js';
import { loadFixture } from '../roster/__tests__/fixtures.js';
import { compileSession } from '../roster/compileSession.js';
import { compilePermissions, type PermissionPolicy } from '../roster/permissions.js';
import { SessionCompileError } from '../roster/sessionOptions.js';

import { isWorkspaceRefusal, type LaunchContext, type Project } from './types.js';
import {
  fakeGit,
  makeDir,
  makeHarness,
  makeTempDir,
  type TempDir,
  type TestHarness,
} from './__tests__/helpers.js';

const OPEN_POLICY: PermissionPolicy = { allowPermissionElevation: true, globalDeny: [] };
const CLOSED_POLICY: PermissionPolicy = { allowPermissionElevation: false, globalDeny: [] };

/** A rule the coder fixture's baseline neither allows nor denies. */
const OUTSIDE_BASELINE = 'Bash(npm publish*)';

let dataRootDir: TempDir;
let workspaceDir: TempDir;
let harness: TestHarness | undefined;

/** A project with a lease, so the launch context has a `cwd` to report. */
async function bootWithProject(): Promise<{ harness: TestHarness; project: Project }> {
  harness = makeHarness({ dataRoot: dataRootDir.path, git: fakeGit({}) });
  const folder = makeDir(workspaceDir.path, 'billing');
  const project = await harness.service.create({ localPath: folder });
  const lease = await harness.service.acquireWorkspace(project.id, 'assignment-1', { write: true });
  if (isWorkspaceRefusal(lease)) throw new Error('the primary tree was refused');
  return { harness, project };
}

/** The launch context, as the runner would ask for it. */
async function contextFor(h: TestHarness, project: Project): Promise<LaunchContext> {
  return h.service.getEffectiveLaunchContext(project.id, 'assignment-1');
}

/** The project layer of roster's compiler, built from a launch context. */
function projectLayer(context: LaunchContext) {
  return {
    ...(context.permissionOverride === undefined
      ? {}
      : { permissions: context.permissionOverride }),
    ...(context.elevation === undefined ? {} : { elevation: context.elevation }),
  };
}

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-projects-handoff-');
  workspaceDir = makeTempDir('agentmanager-projects-handoff-work-');
  harness = undefined;
});

afterEach(() => {
  harness?.storage.close();
  dataRootDir.cleanup();
  workspaceDir.cleanup();
});

describe('permissions, composed by roster (§1.3, §7.6)', () => {
  it('drops a project allow rule the agent baseline does not grant', async () => {
    const { harness: h, project } = await bootWithProject();
    h.service.update(project.id, {
      defaults: { permissions: { allow: ['Edit', OUTSIDE_BASELINE] } },
    });
    const context = await contextFor(h, project);
    const baseline = loadFixture('coder').permissions;

    const compiled = compilePermissions(
      baseline,
      projectLayer(context),
      { write: true },
      OPEN_POLICY,
    );

    // `Edit` survives (the baseline grants it); the other rule does not, and
    // roster says why rather than dropping it silently.
    expect(compiled.effective.allow).toContain('Edit');
    expect(compiled.effective.allow).not.toContain(OUTSIDE_BASELINE);
    expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'roster.permissions.widening-ignored',
    );
    // And narrowing works in the direction a project is allowed to move: the
    // baseline's other grants are gone, because allow is an intersection.
    expect(compiled.effective.allow).not.toContain('Grep');
  });

  it('grants the same rule when it is declared under permissionElevation', async () => {
    const { harness: h, project } = await bootWithProject();
    h.service.update(project.id, {
      defaults: {
        permissionElevation: {
          allow: [OUTSIDE_BASELINE],
          reason: 'the release agent publishes the package',
        },
      },
    });
    const context = await contextFor(h, project);

    const compiled = compilePermissions(
      loadFixture('coder').permissions,
      projectLayer(context),
      { write: true },
      OPEN_POLICY,
    );

    expect(compiled.effective.allow).toContain(OUTSIDE_BASELINE);
    expect(compiled.effective.elevation).toEqual({
      allow: [OUTSIDE_BASELINE],
      reason: 'the release agent publishes the package',
    });
    expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'roster.permissions.elevation-applied',
    );
  });

  it('refuses the elevation with a diagnostic when policy.allowPermissionElevation is false', async () => {
    const { harness: h, project } = await bootWithProject();
    h.service.update(project.id, {
      defaults: {
        permissionElevation: { allow: [OUTSIDE_BASELINE], reason: 'the release agent publishes' },
      },
    });
    const context = await contextFor(h, project);

    const compiled = compilePermissions(
      loadFixture('coder').permissions,
      projectLayer(context),
      { write: true },
      CLOSED_POLICY,
    );

    expect(compiled.effective.allow).not.toContain(OUTSIDE_BASELINE);
    expect(compiled.effective.elevation).toBeNull();
    const dropped = compiled.diagnostics.find(
      (diagnostic) => diagnostic.code === 'roster.permissions.elevation-dropped',
    );
    expect(dropped?.level).toBe('warn');
    // The reason travels with the refusal: an elevation is refused *by name*.
    expect(dropped?.message).toContain('the release agent publishes');
  });

  it('narrows with deny and ask, which is the direction a project may always move', async () => {
    const { harness: h, project } = await bootWithProject();
    h.service.update(project.id, {
      defaults: { permissions: { deny: ['Bash(npm run test:*)'], ask: ['Edit'], mode: 'default' } },
    });
    const context = await contextFor(h, project);

    const compiled = compilePermissions(
      loadFixture('coder').permissions,
      projectLayer(context),
      { write: true },
      OPEN_POLICY,
    );

    expect(compiled.effective.deny).toContain('Bash(npm run test:*)');
    expect(compiled.effective.ask).toContain('Edit');
    // The baseline says `acceptEdits`; the project says `default`; the ladder
    // minimum is the project's.
    expect(compiled.effective.mode).toBe('default');
  });
});

describe('environment, merged by roster (§1.4, roster §13)', () => {
  it('lands after foundation’s agentEnv and before the assignment’s, in declared order', async () => {
    const { harness: h, project } = await bootWithProject();
    h.service.update(project.id, {
      defaults: {
        env: [
          { name: 'LAYER', value: 'project' },
          { name: 'PROJECT_ONLY', value: 'yes' },
          // A duplicate name inside the project's own list: the *later* entry
          // wins, which is what "in declared order" has to mean.
          { name: 'ORDER_WITHIN', value: 'first' },
          { name: 'ORDER_WITHIN', value: 'second' },
        ],
      },
    });
    const context = await contextFor(h, project);

    const compiled = await compileSession({
      agent: { definition: loadFixture('coder'), persona: '' },
      project: { projectId: project.id, cwd: context.cwd, env: context.env },
      assignment: {
        id: 'assignment-1',
        write: true,
        env: [{ name: 'LAYER', value: 'assignment' }],
      },
      policy: OPEN_POLICY,
      agentEnv: { LAYER: 'foundation', FOUNDATION_ONLY: 'yes' },
      baseEnv: { PATH: 'C:\\Windows\\System32', LAYER: 'process' },
      secrets: { get: () => Promise.resolve(undefined) },
    });

    // The whole order in one assertion: process → agentEnv → project → assignment.
    expect(compiled.options.env?.['LAYER']).toBe('assignment');
    expect(compiled.options.env?.['FOUNDATION_ONLY']).toBe('yes');
    expect(compiled.options.env?.['PROJECT_ONLY']).toBe('yes');
    expect(compiled.options.env?.['ORDER_WITHIN']).toBe('second');
    // The inherited process environment survives the merge (roster §13).
    expect(compiled.options.env?.['PATH']).toBe('C:\\Windows\\System32');

    // And with the assignment silent, the project's value is the one that stands.
    const withoutAssignment = await compileSession({
      agent: { definition: loadFixture('coder'), persona: '' },
      project: { projectId: project.id, cwd: context.cwd, env: context.env },
      assignment: { id: 'assignment-1', write: true },
      policy: OPEN_POLICY,
      agentEnv: { LAYER: 'foundation' },
      baseEnv: {},
      secrets: { get: () => Promise.resolve(undefined) },
    });
    expect(withoutAssignment.options.env?.['LAYER']).toBe('project');
  });

  it('fails the launch with a named error when a secretRef does not resolve', async () => {
    const { harness: h, project } = await bootWithProject();
    const ref = `project.${project.id}.dbPassword`;
    h.service.update(project.id, { defaults: { env: [{ name: 'DB_PASSWORD', secretRef: ref }] } });
    const context = await contextFor(h, project);

    // The context still carries the ref, unresolved — that is projects' half.
    expect(context.env).toEqual([{ name: 'DB_PASSWORD', secretRef: ref }]);

    const empty: SecretResolver = { get: () => Promise.resolve(undefined) };
    let thrown: unknown;
    try {
      await compileSession({
        agent: { definition: loadFixture('coder'), persona: '' },
        project: { projectId: project.id, cwd: context.cwd, env: context.env },
        assignment: { id: 'assignment-1', write: true },
        policy: OPEN_POLICY,
        baseEnv: {},
        secrets: empty,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SessionCompileError);
    const error = thrown as SessionCompileError;
    expect(error.message).toContain(ref);
    expect(error.message).toContain('DB_PASSWORD');
    expect(error.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'roster.secret.unresolved',
    );

    // And with the secret present the launch compiles, with the value in place
    // rather than an empty string.
    const resolver: SecretResolver = {
      get: (key) => Promise.resolve(key === ref ? new Secret('hunter2') : undefined),
    };
    const compiled = await compileSession({
      agent: { definition: loadFixture('coder'), persona: '' },
      project: { projectId: project.id, cwd: context.cwd, env: context.env },
      assignment: { id: 'assignment-1', write: true },
      policy: OPEN_POLICY,
      baseEnv: {},
      secrets: resolver,
    });
    expect(compiled.options.env?.['DB_PASSWORD']).toBe('hunter2');
  });
});

describe('the workspace, as roster sees it', () => {
  it('passes the leased cwd through to the compiled options', async () => {
    const { harness: h, project } = await bootWithProject();
    const context = await contextFor(h, project);

    const compiled = await compileSession({
      agent: { definition: loadFixture('coder'), persona: '' },
      project: {
        projectId: project.id,
        cwd: context.cwd,
        workspace: {
          kind: context.workspace.kind,
          path: context.workspace.path,
          branch: context.workspace.branch,
        },
      },
      assignment: { id: 'assignment-1', write: true },
      policy: OPEN_POLICY,
      baseEnv: {},
      secrets: { get: () => Promise.resolve(undefined) },
    });

    expect(compiled.options.cwd).toBe(project.localPath);
    expect(compiled.options.cwd).toBe(context.workspace.path);
  });
});
