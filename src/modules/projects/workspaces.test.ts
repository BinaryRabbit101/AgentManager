/**
 * Workspace leases against real git repositories (projects IMPLEMENTATION M6).
 *
 * M6's acceptance is a list of eight concrete situations, and every one of them
 * is below, exercised through the real service, a real SQLite file and — where
 * a worktree is involved — the real `git` executable in a temp directory. A
 * faked `git worktree add` would prove that this element calls git; what has to
 * be proven is that the *result* is a checkout on the right branch, cut from the
 * right commit, that leaves the user's own tree untouched.
 *
 * The suite skips itself when `git` is not on PATH, the same way M2's does.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isWorkspaceRefusal, type Project, type WorkspaceLease } from './types.js';
import type { CommandResult } from './worktree.js';
import { worktreeNaming } from './worktree.js';
import {
  hasGit,
  makeDir,
  makeGitRepo,
  makeHarness,
  makeTempDir,
  recordingCommandRunner,
  type TempDir,
  type TestHarness,
} from './__tests__/helpers.js';

let dataRootDir: TempDir;
let workspaceDir: TempDir;
let worktreesDir: TempDir;
let harness: TestHarness | undefined;

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

interface BootOptions {
  readonly runCommand?: (
    command: string,
    cwd: string,
    env: Readonly<Record<string, string>>,
  ) => Promise<CommandResult>;
  readonly longPaths?: () => boolean | undefined;
  readonly onLog?: (level: 'info' | 'warn', message: string) => void;
}

function boot(options: BootOptions = {}): TestHarness {
  harness = makeHarness({
    dataRoot: dataRootDir.path,
    worktreesRoot: worktreesDir.path,
    ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
    ...(options.longPaths === undefined ? {} : { longPaths: options.longPaths }),
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
  });
  return harness;
}

/** A registered project backed by a real repository with one commit. */
async function gitProject(h: TestHarness, name = 'billing'): Promise<Project> {
  const folder = resolve(workspaceDir.path, name);
  makeGitRepo(folder);
  return h.service.create({ localPath: folder });
}

/** A registered project that is a plain folder (§4.2's forced `shared`). */
async function plainProject(h: TestHarness, name = 'notes'): Promise<Project> {
  return h.service.create({ localPath: makeDir(workspaceDir.path, name) });
}

async function acquire(
  h: TestHarness,
  project: Project,
  assignmentId: string,
  write = true,
): Promise<WorkspaceLease> {
  const result = await h.service.acquireWorkspace(project.id, assignmentId, { write });
  if (isWorkspaceRefusal(result)) {
    throw new Error(`expected a lease, got a refusal: ${result.code} — ${result.reason}`);
  }
  return result;
}

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-projects-ws-');
  workspaceDir = makeTempDir('agentmanager-projects-ws-work-');
  worktreesDir = makeTempDir('agentmanager-projects-ws-trees-');
  harness = undefined;
});

afterEach(() => {
  harness?.storage.close();
  dataRootDir.cleanup();
  workspaceDir.cleanup();
  worktreesDir.cleanup();
});

describe.skipIf(!hasGit())('the §4.1 rule', () => {
  it('gives one write assignment the primary tree at project.localPath', async () => {
    const h = boot();
    const project = await gitProject(h);

    const lease = await acquire(h, project, 'assignment-1');

    expect(lease.kind).toBe('primary');
    expect(lease.path).toBe(project.localPath);
    expect(lease.write).toBe(true);
    expect(lease.branch).toBeNull();
    expect(lease.state).toBe('active');
    const acquired = h.events.filter((event) => event.type === 'workspace.acquired');
    expect(acquired).toHaveLength(1);
    expect(acquired[0]?.persist).toBe(true);
  });

  it('gives the second concurrent writer a worktree on its own branch, leaving the primary untouched', async () => {
    const h = boot();
    const project = await gitProject(h);
    const head = git(project.localPath, 'rev-parse', 'HEAD');
    const statusBefore = git(project.localPath, 'status', '--porcelain');
    const branchBefore = git(project.localPath, 'rev-parse', '--abbrev-ref', 'HEAD');

    await acquire(h, project, 'assignment-1');
    const second = await acquire(h, project, 'assignment-2');

    const naming = worktreeNaming(worktreesDir.path, project.slug, 'assignment-2');
    expect(second.kind).toBe('worktree');
    expect(second.path).toBe(naming.path);
    expect(second.branch).toBe(naming.branch);
    expect(second.baseCommit).toBe(head);
    expect(existsSync(join(second.path, 'README.md'))).toBe(true);

    // A real checkout, on the named branch, cut from the primary tree's HEAD.
    expect(git(second.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(naming.branch);
    expect(git(second.path, 'rev-parse', 'HEAD')).toBe(head);

    // And the user's own checkout is exactly where it was.
    expect(git(project.localPath, 'status', '--porcelain')).toBe(statusBefore);
    expect(git(project.localPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branchBefore);
  });

  it('runs a read/plan assignment in the primary tree without taking the hold', async () => {
    const h = boot();
    const project = await gitProject(h);

    // A reader first: it must not make the next writer look like a *second* one.
    const reader = await acquire(h, project, 'reader', false);
    expect(reader.kind).toBe('primary');
    expect(reader.write).toBe(false);

    const writer = await acquire(h, project, 'writer');
    expect(writer.kind).toBe('primary');

    // And a reader alongside a writer still shares the primary tree.
    const second = await acquire(h, project, 'reader-2', false);
    expect(second.kind).toBe('primary');
    expect(second.path).toBe(project.localPath);
  });

  it('serialises concurrent acquisitions so exactly one takes the primary tree', async () => {
    const h = boot();
    const project = await gitProject(h);

    const [first, second] = await Promise.all([
      h.service.acquireWorkspace(project.id, 'assignment-1', { write: true }),
      h.service.acquireWorkspace(project.id, 'assignment-2', { write: true }),
    ]);
    if (isWorkspaceRefusal(first) || isWorkspaceRefusal(second)) {
      throw new Error('neither concurrent acquisition should have been refused');
    }

    expect([first.kind, second.kind].sort()).toEqual(['primary', 'worktree']);
  });

  it('re-acquiring for the same assignment returns the lease it already holds', async () => {
    const h = boot();
    const project = await gitProject(h);

    const first = await acquire(h, project, 'assignment-1');
    const again = await acquire(h, project, 'assignment-1');

    expect(again.id).toBe(first.id);
    expect(h.leases.list(project.id, { state: 'active' })).toHaveLength(1);
  });
});

describe.skipIf(!hasGit())('workspacePolicy (§4.2)', () => {
  it('refuses the second writer under "shared", with a typed, retryable reason', async () => {
    const h = boot();
    const project = await gitProject(h);
    h.service.update(project.id, { workspacePolicy: 'shared' });

    await acquire(h, project, 'assignment-1');
    const refused = await h.service.acquireWorkspace(project.id, 'assignment-2', { write: true });

    if (!isWorkspaceRefusal(refused)) throw new Error('the second writer should have been refused');
    expect(refused.code).toBe('shared_policy');
    // The condition clears when the other assignment finishes, so a queue may retry.
    expect(refused.retryable).toBe(true);
    expect(refused.reason).toContain('assignment-1');
    // Nothing was written and no directory was created.
    expect(h.leases.list(project.id, { state: 'active' })).toHaveLength(1);
    expect(existsSync(join(worktreesDir.path, project.slug))).toBe(false);
  });

  it('treats a non-git project as "shared" whatever the policy says', async () => {
    const h = boot();
    const project = await plainProject(h);
    h.service.update(project.id, { workspacePolicy: 'worktree' });

    const first = await acquire(h, project, 'assignment-1');
    expect(first.kind).toBe('primary');

    const refused = await h.service.acquireWorkspace(project.id, 'assignment-2', { write: true });
    if (!isWorkspaceRefusal(refused)) throw new Error('the second writer should have been refused');
    expect(refused.code).toBe('not_a_repository');
    expect(refused.retryable).toBe(true);
  });

  it('gives even the first writer a worktree under "worktree"', async () => {
    const h = boot();
    const project = await gitProject(h);
    h.service.update(project.id, { workspacePolicy: 'worktree' });

    const lease = await acquire(h, project, 'assignment-1');
    expect(lease.kind).toBe('worktree');
    expect(existsSync(lease.path)).toBe(true);

    // A reader still gets the primary tree: `worktree` is about writers (§4.1).
    const reader = await acquire(h, project, 'reader', false);
    expect(reader.kind).toBe('primary');
  });
});

describe.skipIf(!hasGit())('release and cleanup (§4.4, §7.12)', () => {
  async function worktreeFor(h: TestHarness, project: Project): Promise<WorkspaceLease> {
    await acquire(h, project, 'holder');
    return acquire(h, project, 'worker');
  }

  it('removes the directory and the branch when the worktree is untouched', async () => {
    const h = boot();
    const project = await gitProject(h);
    const lease = await worktreeFor(h, project);

    const result = await h.service.releaseWorkspace(lease.id);

    expect(result).toMatchObject({ removed: true, retained: false, branchDeleted: true });
    expect(existsSync(lease.path)).toBe(false);
    expect(git(project.localPath, 'branch', '--list', lease.branch ?? '')).toBe('');
    expect(h.leases.get(lease.id)?.state).toBe('released');
    expect(h.events.some((event) => event.type === 'workspace.released')).toBe(true);
  });

  it('retains a worktree that has a commit, and lists it as review needed with the count', async () => {
    const h = boot();
    const project = await gitProject(h);
    const lease = await worktreeFor(h, project);

    writeFileSync(join(lease.path, 'fix.txt'), 'the fix\n', 'utf8');
    git(lease.path, 'add', 'fix.txt');
    git(lease.path, 'commit', '-m', 'the fix');

    const result = await h.service.releaseWorkspace(lease.id);

    expect(result.retained).toBe(true);
    expect(result.removed).toBe(false);
    expect(result.review).toMatchObject({ commits: 1, dirty: false, present: true });
    // Agent output is never silently discarded: directory and branch both stay.
    expect(existsSync(lease.path)).toBe(true);
    expect(git(project.localPath, 'branch', '--list', lease.branch ?? '')).toContain(
      lease.branch ?? '',
    );

    const listed = await h.service.listWorkspaces(project.id);
    const entry = listed.find((candidate) => candidate.id === lease.id);
    expect(entry?.review).toMatchObject({ commits: 1, present: true });
  });

  it('retains a worktree with uncommitted work, including untracked files', async () => {
    const h = boot();
    const project = await gitProject(h);
    const lease = await worktreeFor(h, project);
    writeFileSync(join(lease.path, 'scratch.md'), 'half a thought\n', 'utf8');

    const result = await h.service.releaseWorkspace(lease.id);

    expect(result.retained).toBe(true);
    expect(result.review).toMatchObject({ commits: 0, dirty: true });
    expect(existsSync(join(lease.path, 'scratch.md'))).toBe(true);
  });

  it('removes a retained worktree only on the confirmed cleanup action, keeping an unmerged branch', async () => {
    const h = boot();
    const project = await gitProject(h);
    const lease = await worktreeFor(h, project);
    writeFileSync(join(lease.path, 'fix.txt'), 'the fix\n', 'utf8');
    git(lease.path, 'add', 'fix.txt');
    git(lease.path, 'commit', '-m', 'the fix');
    await h.service.releaseWorkspace(lease.id);

    const cleaned = await h.service.cleanupWorkspace(lease.id);

    expect(cleaned.removed).toBe(true);
    expect(existsSync(lease.path)).toBe(false);
    // `git branch -d` refuses an unmerged branch, and this element never uses
    // `-D`: the commits survive the directory (§4.4).
    expect(cleaned.branchDeleted).toBe(false);
    expect(git(project.localPath, 'branch', '--list', lease.branch ?? '')).toContain(
      lease.branch ?? '',
    );
  });

  it('keeps a worktree when the caller asks it to', async () => {
    const h = boot();
    const project = await gitProject(h);
    const lease = await worktreeFor(h, project);

    const result = await h.service.releaseWorkspace(lease.id, { cleanup: 'keep' });
    expect(result.retained).toBe(true);
    expect(existsSync(lease.path)).toBe(true);
  });

  it('re-acquires the retained worktree of the same assignment rather than cutting a second', async () => {
    const h = boot();
    const project = await gitProject(h);
    const lease = await worktreeFor(h, project);
    writeFileSync(join(lease.path, 'fix.txt'), 'the fix\n', 'utf8');
    git(lease.path, 'add', 'fix.txt');
    git(lease.path, 'commit', '-m', 'the fix');
    await h.service.releaseWorkspace(lease.id);

    const again = await acquire(h, project, 'worker');

    // The same branch, the same directory, the same lease: the assignment picks
    // its own retained work back up instead of stranding it (§4.4).
    expect(again.id).toBe(lease.id);
    expect(again.state).toBe('active');
    expect(again.path).toBe(lease.path);
    expect(h.leases.list(project.id).filter((entry) => entry.kind === 'worktree')).toHaveLength(1);
  });

  it('releasing the primary tree frees it for the next writer', async () => {
    const h = boot();
    const project = await gitProject(h);
    const first = await acquire(h, project, 'assignment-1');

    await h.service.releaseWorkspace(first.id);
    const next = await acquire(h, project, 'assignment-2');

    expect(next.kind).toBe('primary');
    expect(next.path).toBe(project.localPath);
  });
});

describe.skipIf(!hasGit())('orphan recovery (§4.4)', () => {
  it('orphans leases from a previous run, surfaces them in health, and does not double-lease', async () => {
    const h = boot();
    const project = await gitProject(h);
    await acquire(h, project, 'holder');
    const worktree = await acquire(h, project, 'worker');

    // "Killing the service mid-assignment and restarting": the boot task runs
    // before any listener binds, and every `active` lease is from the last life.
    const reconciliation = await h.service.reconcileWorkspaces();

    expect(reconciliation.orphaned).toHaveLength(2);
    expect(reconciliation.pruned).toEqual([project.id]);
    expect(h.leases.get(worktree.id)?.state).toBe('orphaned');
    // An orphaned lease was never released, so it carries no releasedAt.
    expect(h.leases.get(worktree.id)?.releasedAt).toBeNull();

    const orphanCondition = h.service
      .health(project.id)
      .conditions.find((condition) => condition.code === 'orphaned-worktrees');
    expect(orphanCondition?.level).toBe('warn');
    expect(orphanCondition?.message).toContain('2');

    // Re-acquiring for the same assignment adopts the surviving worktree rather
    // than cutting a second one on a second branch.
    const again = await acquire(h, project, 'worker');
    expect(again.id).toBe(worktree.id);
    expect(again.state).toBe('active');
    expect(again.path).toBe(worktree.path);
    expect(h.leases.list(project.id).filter((lease) => lease.kind === 'worktree')).toHaveLength(1);
  });

  it('does not adopt an orphaned worktree whose directory is gone', async () => {
    const h = boot();
    const project = await gitProject(h);
    await acquire(h, project, 'holder');
    const worktree = await acquire(h, project, 'worker');
    await h.service.releaseWorkspace(worktree.id);
    // Released *and* removed, then orphaned by hand: the directory is not there
    // to adopt, so a fresh acquisition must cut a new one.
    h.leases.setState(worktree.id, 'orphaned');

    await acquire(h, project, 'holder-2');
    const fresh = await acquire(h, project, 'worker');
    expect(fresh.id).not.toBe(worktree.id);
    expect(existsSync(fresh.path)).toBe(true);
  });
});

describe.skipIf(!hasGit())('Windows specifics (§4.4)', () => {
  it('warns once — not per acquisition — when LongPathsEnabled is off', async () => {
    const warnings: string[] = [];
    const h = boot({
      longPaths: () => false,
      onLog: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
    });
    const project = await gitProject(h);

    await acquire(h, project, 'holder');
    await acquire(h, project, 'worker-1');
    await acquire(h, project, 'worker-2');

    const longPathWarnings = warnings.filter((message) => message.includes('long paths'));
    expect(longPathWarnings).toHaveLength(1);
  });

  it('refuses a worktree for a project on a network share, naming the reason', async () => {
    const h = boot();
    // A UNC project cannot be registered through `inspect` on a machine with no
    // share, so the row is written directly — the refusal under test is about
    // the stored path, not about registration.
    const project = h.repository.create({
      name: 'Shared Billing',
      slug: 'shared-billing',
      localPath: '\\\\fileserver\\repos\\billing',
      localPathKey: '\\\\fileserver\\repos\\billing',
      vcs: 'git',
    });

    await acquire(h, project, 'holder');
    const refused = await h.service.acquireWorkspace(project.id, 'worker', { write: true });

    if (!isWorkspaceRefusal(refused)) throw new Error('a UNC worktree should have been refused');
    expect(refused.code).toBe('unc_path');
    expect(refused.reason).toContain('network share');
    expect(refused.reason).toContain('\\\\fileserver\\repos\\billing');
    // Under `auto` the primary tree will free up, so a queue may retry.
    expect(refused.retryable).toBe(true);

    // Under `worktree` there is no fallback at all, and the refusal says so.
    h.service.update(project.id, { workspacePolicy: 'worktree' });
    const hopeless = await h.service.acquireWorkspace(project.id, 'worker-2', { write: true });
    if (!isWorkspaceRefusal(hopeless)) throw new Error('a UNC worktree should have been refused');
    expect(hopeless.retryable).toBe(false);
  });
});

describe.skipIf(!hasGit())('the setup command (§4.4)', () => {
  it('runs in the new worktree with the project’s literal env, and never resolves a secretRef', async () => {
    const runner = recordingCommandRunner();
    const h = boot({ runCommand: runner });
    const project = await gitProject(h);
    h.service.update(project.id, {
      defaults: {
        setupCommand: 'npm ci',
        env: [
          { name: 'APP_ENV', value: 'test' },
          { name: 'DB_PASSWORD', secretRef: `project.${project.id}.dbPassword` },
        ],
      },
    });

    await acquire(h, project, 'holder');
    const lease = await acquire(h, project, 'worker');

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.command).toBe('npm ci');
    expect(runner.calls[0]?.cwd).toBe(lease.path);
    expect(runner.calls[0]?.env['APP_ENV']).toBe('test');
    // The reveal sites are foundation's two, and this is not one of them: the
    // ref is simply not in the setup command's environment.
    expect(runner.calls[0]?.env['DB_PASSWORD']).toBeUndefined();
  });

  it('refuses the lease and removes the worktree when setup fails', async () => {
    const h = boot({
      runCommand: () =>
        Promise.resolve({ ok: false, stdout: '', stderr: 'npm ERR! missing lockfile' }),
    });
    const project = await gitProject(h);
    h.service.update(project.id, { defaults: { setupCommand: 'npm ci' } });

    await acquire(h, project, 'holder');
    const refused = await h.service.acquireWorkspace(project.id, 'worker', { write: true });

    if (!isWorkspaceRefusal(refused)) throw new Error('a failed setup should have been refused');
    expect(refused.code).toBe('setup_failed');
    expect(refused.reason).toContain('npm ERR! missing lockfile');
    expect(refused.retryable).toBe(false);

    const naming = worktreeNaming(worktreesDir.path, project.slug, 'worker');
    expect(existsSync(naming.path)).toBe(false);
    expect(git(project.localPath, 'branch', '--list', naming.branch)).toBe('');
    // And no lease row survives a refusal.
    expect(h.leases.list(project.id, { state: 'active' })).toHaveLength(1);
  });
});

describe.skipIf(!hasGit())('refusals that are not about policy', () => {
  it('refuses a worktree while the repository is mid-merge', async () => {
    const h = boot();
    const project = await gitProject(h);
    writeFileSync(join(project.localPath, '.git', 'MERGE_HEAD'), 'deadbeef\n', 'utf8');

    await acquire(h, project, 'holder');
    const refused = await h.service.acquireWorkspace(project.id, 'worker', { write: true });

    if (!isWorkspaceRefusal(refused)) throw new Error('a mid-merge repository should be refused');
    expect(refused.code).toBe('repository_busy');
    expect(refused.reason).toContain('merge');
    // A human has to finish the merge; queueing would never clear it.
    expect(refused.retryable).toBe(false);
  });

  it('refuses a worktree cut from a dirty primary tree when the assignment needs a clean base', async () => {
    const h = boot();
    const project = await gitProject(h);
    writeFileSync(join(project.localPath, 'README.md'), '# fixture\n\nedited\n', 'utf8');

    await acquire(h, project, 'holder');
    const refused = await h.service.acquireWorkspace(project.id, 'worker', {
      write: true,
      requireCleanBase: true,
    });

    if (!isWorkspaceRefusal(refused)) throw new Error('a dirty base should have been refused');
    expect(refused.code).toBe('dirty_primary');
    expect(refused.retryable).toBe(false);

    // Without the flag the same acquisition succeeds: a dirty tree is normal.
    const lease = await acquire(h, project, 'worker');
    expect(lease.kind).toBe('worktree');
  });

  it('refuses every acquisition on an archived or provisioning project', async () => {
    const h = boot();
    const project = await gitProject(h);
    h.repository.update(project.id, { status: 'provisioning' });

    const provisioning = await h.service.acquireWorkspace(project.id, 'assignment-1', {
      write: true,
    });
    if (!isWorkspaceRefusal(provisioning)) throw new Error('provisioning should be refused');
    expect(provisioning.code).toBe('project_not_launchable');
    // The clone finishes on its own, so the runner may queue and retry.
    expect(provisioning.retryable).toBe(true);

    h.repository.update(project.id, { status: 'active' });
    h.repository.archive(project.id);
    const archived = await h.service.acquireWorkspace(project.id, 'assignment-1', { write: true });
    if (!isWorkspaceRefusal(archived)) throw new Error('an archived project should be refused');
    expect(archived.retryable).toBe(false);
  });
});
