/**
 * `getEffectiveLaunchContext` (projects IMPLEMENTATION M4).
 *
 * The acceptance criterion this file owns is a negative one, which is why it is
 * asserted rather than assumed:
 *
 * > "The launch context is raw input: it carries no `permissions` key, resolves
 * > no `secretRef`, and merges no environment — asserted by a test that plants a
 * > ref and finds it still a ref."
 *
 * Plus the two refusals around it: a `provisioning` project is rejected by the
 * launch-context call (M3's acceptance, enforced here because this is the call),
 * and an assignment with no lease has no `cwd` to be given.
 *
 * What the *result* means downstream — that a project `allow` outside the
 * agent's baseline is dropped, that the env lands between `agentEnv` and the
 * assignment's, that an unresolvable ref fails the launch — is proven against
 * roster's real compiler in `rosterHandoff.test.ts`, not restated here.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ProjectNotFoundError,
  ProjectNotLaunchableError,
  WorkspaceNotLeasedError,
} from './errors.js';
import { isWorkspaceRefusal, type Project } from './types.js';
import {
  fakeGit,
  makeDir,
  makeHarness,
  makeTempDir,
  type TempDir,
  type TestHarness,
} from './__tests__/helpers.js';

let dataRootDir: TempDir;
let workspaceDir: TempDir;
let harness: TestHarness | undefined;

/** A plain (non-git) project, so every lease here is the primary tree (§4.1). */
async function bootWithProject(): Promise<{
  harness: TestHarness;
  project: Project;
  folder: string;
}> {
  harness = makeHarness({ dataRoot: dataRootDir.path, git: fakeGit({}) });
  const folder = makeDir(workspaceDir.path, 'billing');
  const project = await harness.service.create({ localPath: folder });
  return { harness, project, folder };
}

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-projects-launch-');
  workspaceDir = makeTempDir('agentmanager-projects-launch-work-');
  harness = undefined;
});

afterEach(() => {
  harness?.storage.close();
  dataRootDir.cleanup();
  workspaceDir.cleanup();
});

describe('raw inputs, not an effective anything (§5)', () => {
  it('carries no permissions key, no merged env and no resolved secretRef', async () => {
    const { harness: h, project } = await bootWithProject();
    h.service.update(project.id, {
      defaults: {
        permissions: {
          allow: ['Edit'],
          deny: ['Bash(git push*)'],
          ask: ['WebFetch'],
          mode: 'default',
        },
        permissionElevation: {
          allow: ['Bash(git push*)'],
          reason: 'the release agent pushes tags',
        },
        env: [
          { name: 'APP_ENV', value: 'test' },
          { name: 'DB_PASSWORD', secretRef: `project.${project.id}.dbPassword` },
        ],
      },
    });
    const lease = await h.service.acquireWorkspace(project.id, 'assignment-1', { write: true });
    expect(isWorkspaceRefusal(lease)).toBe(false);

    const context = await h.service.getEffectiveLaunchContext(project.id, 'assignment-1');

    // No composition happened: the override is exactly what was stored, and
    // there is no key claiming to be an effective set.
    expect(Object.keys(context).sort()).toEqual([
      'cwd',
      'elevation',
      'env',
      'permissionOverride',
      'workspace',
    ]);
    expect('permissions' in context).toBe(false);
    expect(context.permissionOverride).toEqual({
      allow: ['Edit'],
      deny: ['Bash(git push*)'],
      ask: ['WebFetch'],
      mode: 'default',
    });
    expect(context.elevation).toEqual({
      allow: ['Bash(git push*)'],
      reason: 'the release agent pushes tags',
    });

    // The planted ref is still a ref, and nothing from the process environment
    // has been merged in: the list is the project's two entries, in order.
    expect(context.env).toEqual([
      { name: 'APP_ENV', value: 'test' },
      { name: 'DB_PASSWORD', secretRef: `project.${project.id}.dbPassword` },
    ]);
    expect(context.env.some((entry) => entry.name === 'PATH')).toBe(false);
  });

  it('takes cwd from the lease, not from the project folder', async () => {
    const { harness: h, project } = await bootWithProject();
    // A worktree lease written directly: what matters here is that the launch
    // context follows the lease, which for a second concurrent writer is a
    // different directory from `localPath` (§4.1).
    const lease = h.leases.create({
      projectId: project.id,
      assignmentId: 'assignment-2',
      kind: 'worktree',
      path: 'C:\\worktrees\\billing\\abc12345',
      branch: 'agentmanager/abc12345-billing',
      baseCommit: 'deadbeef',
      write: true,
    });

    const context = await h.service.getEffectiveLaunchContext(project.id, 'assignment-2');
    expect(context.cwd).toBe('C:\\worktrees\\billing\\abc12345');
    expect(context.cwd).not.toBe(project.localPath);
    expect(context.workspace).toEqual(lease);
  });

  it('resolves instructionsPath against the project folder, and omits it when unreadable', async () => {
    const { harness: h, project, folder } = await bootWithProject();
    writeFileSync(resolve(folder, 'BRIEF.md'), '# Billing\n\nPHP 8.2.', 'utf8');
    h.service.update(project.id, { defaults: { instructionsPath: 'BRIEF.md' } });
    await h.service.acquireWorkspace(project.id, 'assignment-1', { write: true });

    const context = await h.service.getEffectiveLaunchContext(project.id, 'assignment-1');
    expect(context.instructions).toContain('PHP 8.2.');

    h.service.update(project.id, { defaults: { instructionsPath: 'MISSING.md' } });
    const without = await h.service.getEffectiveLaunchContext(project.id, 'assignment-1');
    // A brief that is not there is a setting to fix, not a launch to block.
    expect(without.instructions).toBeUndefined();
  });

  it('returns an empty env list for a project that configures none', async () => {
    const { harness: h, project } = await bootWithProject();
    await h.service.acquireWorkspace(project.id, 'assignment-1', { write: false });
    const context = await h.service.getEffectiveLaunchContext(project.id, 'assignment-1');
    expect(context.env).toEqual([]);
    expect(context.permissionOverride).toBeUndefined();
    expect(context.elevation).toBeUndefined();
  });
});

describe('refusals', () => {
  it('rejects a provisioning project (§2.2)', async () => {
    const { harness: h, project } = await bootWithProject();
    await h.service.acquireWorkspace(project.id, 'assignment-1', { write: true });
    h.repository.update(project.id, { status: 'provisioning' });

    await expect(
      h.service.getEffectiveLaunchContext(project.id, 'assignment-1'),
    ).rejects.toBeInstanceOf(ProjectNotLaunchableError);
  });

  it('rejects an archived project', async () => {
    const { harness: h, project } = await bootWithProject();
    await h.service.acquireWorkspace(project.id, 'assignment-1', { write: true });
    h.repository.archive(project.id);

    await expect(
      h.service.getEffectiveLaunchContext(project.id, 'assignment-1'),
    ).rejects.toBeInstanceOf(ProjectNotLaunchableError);
  });

  it('rejects an assignment that holds no lease, rather than handing back localPath', async () => {
    const { harness: h, project } = await bootWithProject();
    await expect(
      h.service.getEffectiveLaunchContext(project.id, 'never-acquired'),
    ).rejects.toBeInstanceOf(WorkspaceNotLeasedError);
  });

  it('rejects an unknown project id', async () => {
    const { harness: h } = await bootWithProject();
    await expect(
      h.service.getEffectiveLaunchContext('01JZZZZZZZZZZZZZZZZZZZZZZZ', 'assignment-1'),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('stops seeing a released lease', async () => {
    const { harness: h, project } = await bootWithProject();
    const lease = await h.service.acquireWorkspace(project.id, 'assignment-1', { write: true });
    if (isWorkspaceRefusal(lease)) throw new Error('the primary tree was refused');

    await h.service.releaseWorkspace(lease.id);
    await expect(
      h.service.getEffectiveLaunchContext(project.id, 'assignment-1'),
    ).rejects.toBeInstanceOf(WorkspaceNotLeasedError);
  });
});
