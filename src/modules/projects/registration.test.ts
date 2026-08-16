/**
 * Register an existing folder: inspect + create (projects IMPLEMENTATION M2).
 *
 * Acceptance, criterion by criterion:
 *
 * - "Inspecting a git repo returns name, slug, `repoUrl`, `defaultBranch`,
 *   `vcs: 'git'`" — *a git repository*, against a repository built by the real
 *   `git` executable in a temp directory;
 * - "Inspecting a plain folder returns `vcs: 'none'` and no repo fields;
 *   creation succeeds" — *a plain folder*;
 * - "Nested registration … is refused with a message naming the conflicting
 *   project" — *nesting*;
 * - "A path that does not exist, is a file, or is not writable each returns a
 *   distinct typed error, not a stack trace" — *the folder itself*;
 * - "Inspect completes in well under a second on a large repo (no full tree
 *   walk)" — *cost*;
 * - and M1's "a second registration of any of them is rejected with a typed
 *   conflict", including through a junction — *identity*.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DuplicateProjectError,
  GitWorktreePathError,
  NestedProjectError,
  PathInDataRootError,
  PathNotDirectoryError,
  PathNotFoundError,
  PathNotWritableError,
  ProjectsError,
} from './errors.js';
import type { GitRunner } from './git.js';
import { isDirectoryEmpty, probeWritable } from './inspect.js';
import {
  fakeGit,
  fillWithFiles,
  hasGit,
  makeDir,
  makeGitRepo,
  makeHarness,
  makeTempDir,
  type TempDir,
  type TestHarness,
} from './__tests__/helpers.js';

/** Temp dirs, kept apart on purpose: "inside the data root" is a refusal (§1.1). */
let dataRootDir: TempDir;
let workspaceDir: TempDir;
let harness: TestHarness | undefined;

interface BootOptions {
  /** Present-but-`undefined` means "use the real `git` executable". */
  readonly git?: GitRunner | undefined;
  readonly probeWritable?: ((directory: string) => string | undefined) | undefined;
}

/**
 * Storage plus the service, wired as the module wires them.
 *
 * The default git runner answers nothing, which is exactly right for the plain
 * folders most of these tests use: nothing ever asks it.
 */
function boot(options: BootOptions = {}): TestHarness {
  const git = 'git' in options ? options.git : fakeGit({});
  harness = makeHarness({
    dataRoot: dataRootDir.path,
    ...(git === undefined ? {} : { git }),
    ...(options.probeWritable === undefined ? {} : { probeWritable: options.probeWritable }),
  });
  return harness;
}

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-projects-data-');
  workspaceDir = makeTempDir('agentmanager-projects-work-');
  harness = undefined;
});

afterEach(() => {
  harness?.storage.close();
  dataRootDir.cleanup();
  workspaceDir.cleanup();
});

describe('a plain folder', () => {
  it('inspects as vcs "none" with no repository fields, and registers', async () => {
    const { service, repository } = boot();
    const folder = makeDir(workspaceDir.path, 'Widget Factory');
    writeFileSync(resolve(folder, 'notes.txt'), 'hello', 'utf8');

    const inspection = await service.inspect(folder);
    expect(inspection.vcs).toBe('none');
    expect(inspection.repoUrl).toBeNull();
    expect(inspection.defaultBranch).toBeNull();
    expect(inspection.name).toBe('Widget Factory');
    expect(inspection.slug).toBe('widget-factory');
    expect(inspection.localPath).toBe(folder);
    expect(inspection.localPathKey).toBe(folder.toLowerCase());
    expect(inspection.warnings).toEqual([]);

    const project = await service.create({ localPath: folder });
    expect(project.vcs).toBe('none');
    expect(project.status).toBe('active');
    expect(project.slug).toBe('widget-factory');
    expect(project.localPath).toBe(folder);
    expect(repository.getByPathKey(folder.toLowerCase())?.id).toBe(project.id);
  });

  it('accepts the reviewed values the form posts back', async () => {
    const { service } = boot();
    const folder = makeDir(workspaceDir.path, 'raw');

    const project = await service.create({
      localPath: folder,
      name: 'Polished Name',
      slug: 'polished',
      notes: '# Brief\n\nwhat this is',
      workspacePolicy: 'shared',
    });

    expect(project.name).toBe('Polished Name');
    expect(project.slug).toBe('polished');
    expect(project.notes).toContain('# Brief');
    expect(project.workspacePolicy).toBe('shared');
  });

  it('emits a persisted project.created event', async () => {
    const { service, storage, events } = boot();
    const folder = makeDir(workspaceDir.path, 'evented');

    const project = await service.create({ localPath: folder });

    const created = events.filter((event) => event.type === 'project.created');
    expect(created).toHaveLength(1);
    expect(created[0]?.ids.projectId).toBe(project.id);
    expect(created[0]?.persist).toBe(true);
    // `persist: true` means a row, not just a live notification (foundation §6.5).
    expect(storage.store.events.list({ types: ['project.created'] })).toHaveLength(1);
  });

  it('warns that an empty folder is empty, without refusing it', async () => {
    const { service } = boot();
    const folder = makeDir(workspaceDir.path, 'nothing-here');

    const inspection = await service.inspect(folder);
    expect(inspection.warnings.map((warning) => warning.code)).toEqual(['empty-folder']);
    await expect(service.create({ localPath: folder })).resolves.toMatchObject({ vcs: 'none' });
  });
});

describe('a git repository', () => {
  it.skipIf(!hasGit())(
    'inspects as vcs "git" with name, slug, repoUrl and defaultBranch',
    async () => {
      const { service } = boot({ git: undefined });
      const folder = resolve(workspaceDir.path, 'Checkout');
      makeGitRepo(folder, { remote: 'https://example.invalid/checkout.git' });

      const inspection = await service.inspect(folder);

      expect(inspection.vcs).toBe('git');
      expect(inspection.name).toBe('Checkout');
      expect(inspection.slug).toBe('checkout');
      expect(inspection.repoUrl).toBe('https://example.invalid/checkout.git');
      expect(inspection.defaultBranch).toBe('main');
      expect(inspection.warnings).toEqual([]);

      const project = await service.create({ localPath: folder });
      expect(project.vcs).toBe('git');
      expect(project.repoUrl).toBe('https://example.invalid/checkout.git');
      expect(project.defaultBranch).toBe('main');
    },
  );

  it.skipIf(!hasGit())('reports a repository with no origin as git with no repoUrl', async () => {
    const { service } = boot({ git: undefined });
    const folder = resolve(workspaceDir.path, 'local-only');
    makeGitRepo(folder);

    const inspection = await service.inspect(folder);
    expect(inspection.vcs).toBe('git');
    expect(inspection.repoUrl).toBeNull();
    expect(inspection.defaultBranch).toBe('main');
  });

  it.skipIf(!hasGit())('warns when the tree has uncommitted changes', async () => {
    const { service } = boot({ git: undefined });
    const folder = resolve(workspaceDir.path, 'dirty');
    makeGitRepo(folder);
    writeFileSync(resolve(folder, 'README.md'), '# changed\n', 'utf8');

    const inspection = await service.inspect(folder);
    expect(inspection.warnings.map((warning) => warning.code)).toContain('dirty-repo');
  });

  it('refuses a folder whose .git is a file — an existing worktree (§2.1)', async () => {
    const { service } = boot();
    const folder = makeDir(workspaceDir.path, 'a-worktree');
    writeFileSync(resolve(folder, '.git'), 'gitdir: C:\\Code\\App\\.git\\worktrees\\a', 'utf8');

    await expect(service.inspect(folder)).rejects.toBeInstanceOf(GitWorktreePathError);
    await expect(service.inspect(folder)).rejects.toMatchObject({
      code: 'git_worktree_path',
      status: 400,
    });
  });

  it('reads the remote’s HEAD in preference to the checked-out branch', async () => {
    const { service } = boot({
      git: fakeGit({
        'remote get-url origin': { ok: true, stdout: 'git@example.invalid:x/y.git\n', stderr: '' },
        'symbolic-ref --short refs/remotes/origin/HEAD': {
          ok: true,
          stdout: 'origin/trunk\n',
          stderr: '',
        },
        'symbolic-ref --short HEAD': { ok: true, stdout: 'feature/thing\n', stderr: '' },
        'status --porcelain --untracked-files=no': { ok: true, stdout: '', stderr: '' },
      }),
    });
    const folder = makeDir(workspaceDir.path, 'remote-head');
    mkdirSync(resolve(folder, '.git'));

    const inspection = await service.inspect(folder);
    expect(inspection.vcs).toBe('git');
    expect(inspection.defaultBranch).toBe('trunk');
    expect(inspection.repoUrl).toBe('git@example.invalid:x/y.git');
  });
});

describe('the folder itself', () => {
  it('gives a distinct typed error for a path that does not exist', async () => {
    const { service } = boot();
    const missing = resolve(workspaceDir.path, 'nope');

    await expect(service.inspect(missing)).rejects.toBeInstanceOf(PathNotFoundError);
    const error = await service.inspect(missing).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'path_not_found', status: 400 });
    expect((error as ProjectsError).message).toContain(missing);
  });

  it('gives a distinct typed error for a file', async () => {
    const { service } = boot();
    const file = resolve(workspaceDir.path, 'a-file.txt');
    writeFileSync(file, 'not a folder', 'utf8');

    await expect(service.inspect(file)).rejects.toBeInstanceOf(PathNotDirectoryError);
    await expect(service.inspect(file)).rejects.toMatchObject({
      code: 'path_not_directory',
      status: 400,
    });
  });

  it('gives a distinct typed error for a folder it cannot write to', async () => {
    // Substituted rather than ACL'd: `fs.access(W_OK)` ignores Windows ACLs, so
    // the probe is the seam — its real implementation is exercised below.
    const { service } = boot({ probeWritable: () => 'access is denied' });
    const folder = makeDir(workspaceDir.path, 'read-only');

    await expect(service.inspect(folder)).rejects.toBeInstanceOf(PathNotWritableError);
    await expect(service.inspect(folder)).rejects.toMatchObject({
      code: 'path_not_writable',
      status: 400,
    });
  });

  it('never surfaces a stack: every refusal carries a code, a status and details', async () => {
    const { service } = boot();
    const file = resolve(workspaceDir.path, 'x.txt');
    writeFileSync(file, '', 'utf8');

    const error = (await service.inspect(file).catch((cause: unknown) => cause)) as ProjectsError;
    expect(error).toBeInstanceOf(ProjectsError);
    expect(typeof error.code).toBe('string');
    expect(typeof error.status).toBe('number');
    expect(error.details['localPath']).toBe(file);
  });

  it('refuses anything inside AgentManager’s own data root', async () => {
    const { service } = boot();
    const inside = makeDir(dataRootDir.path, 'state', 'sneaky');

    await expect(service.inspect(inside)).rejects.toBeInstanceOf(PathInDataRootError);
    await expect(service.inspect(dataRootDir.path)).rejects.toBeInstanceOf(PathInDataRootError);
  });

  describe('the real writability probe', () => {
    it('says yes for a normal folder and no for one that is not there', () => {
      const folder = makeDir(workspaceDir.path, 'writable');
      expect(probeWritable(folder)).toBeUndefined();
      expect(probeWritable(resolve(workspaceDir.path, 'absent'))).toBeDefined();
    });

    it('leaves nothing behind', () => {
      const folder = makeDir(workspaceDir.path, 'clean-after');
      expect(probeWritable(folder)).toBeUndefined();
      expect(isDirectoryEmpty(folder)).toBe(true);
    });
  });
});

describe('identity', () => {
  it('refuses a second registration of the same folder under any casing', async () => {
    const { service, repository } = boot();
    const folder = makeDir(workspaceDir.path, 'Code', 'App');
    const first = await service.create({ localPath: folder });

    for (const spelling of [folder, folder.toLowerCase(), `${folder}\\`, folder.toUpperCase()]) {
      const error = (await service
        .create({ localPath: spelling })
        .catch((cause: unknown) => cause)) as DuplicateProjectError;
      expect(error).toBeInstanceOf(DuplicateProjectError);
      expect(error.code).toBe('project_exists');
      expect(error.status).toBe(409);
      expect(error.details['existingProjectId']).toBe(first.id);
      expect(error.message).toContain(first.name);
    }

    expect(repository.list()).toHaveLength(1);
  });

  it('refuses a second registration through a junction pointing at the same folder', async () => {
    const { service, repository } = boot();
    const folder = makeDir(workspaceDir.path, 'Code', 'App');
    const junction = resolve(workspaceDir.path, 'LinkToApp');
    symlinkSync(folder, junction, 'junction');

    const first = await service.create({ localPath: folder });

    // The case a lexical containment check passes and a realpath check catches.
    const inspected = await service.inspect(junction).catch((cause: unknown) => cause);
    expect(inspected).toBeInstanceOf(DuplicateProjectError);
    expect((inspected as DuplicateProjectError).details['existingProjectId']).toBe(first.id);

    await expect(service.create({ localPath: junction })).rejects.toBeInstanceOf(
      DuplicateProjectError,
    );
    expect(repository.list()).toHaveLength(1);
  });

  it('stores a junction under the real folder’s identity, not the link’s', async () => {
    const { service } = boot();
    const folder = makeDir(workspaceDir.path, 'Real');
    const junction = resolve(workspaceDir.path, 'Link');
    symlinkSync(folder, junction, 'junction');

    const project = await service.create({ localPath: junction });
    expect(project.localPath).toBe(folder);
    expect(project.localPathKey).toBe(folder.toLowerCase());
  });

  it('deduplicates slugs across separate folders with the same basename', async () => {
    const { service } = boot();
    const slugs: string[] = [];
    for (const parent of ['one', 'two', 'three']) {
      const folder = makeDir(workspaceDir.path, parent, 'app');
      slugs.push((await service.create({ localPath: folder })).slug);
    }
    expect(slugs).toEqual(['app', 'app-2', 'app-3']);
  });
});

describe('nesting', () => {
  it('refuses a folder inside an existing project, naming it', async () => {
    const { service, repository } = boot();
    const parent = makeDir(workspaceDir.path, 'Monorepo');
    const registered = await service.create({ localPath: parent, name: 'The Monorepo' });
    const child = makeDir(parent, 'packages', 'api');

    const error = (await service
      .create({ localPath: child })
      .catch((cause: unknown) => cause)) as NestedProjectError;

    expect(error).toBeInstanceOf(NestedProjectError);
    expect(error.code).toBe('nested_project');
    expect(error.status).toBe(409);
    expect(error.relation).toBe('inside');
    expect(error.message).toContain('The Monorepo');
    expect(error.details['conflictingProjectId']).toBe(registered.id);
    expect(repository.list()).toHaveLength(1);
  });

  it('refuses a folder that contains an existing project, naming it', async () => {
    const { service } = boot();
    const child = makeDir(workspaceDir.path, 'outer', 'inner');
    const registered = await service.create({ localPath: child, name: 'The Inner One' });

    const error = (await service
      .create({ localPath: resolve(workspaceDir.path, 'outer') })
      .catch((cause: unknown) => cause)) as NestedProjectError;

    expect(error).toBeInstanceOf(NestedProjectError);
    expect(error.relation).toBe('contains');
    expect(error.message).toContain('The Inner One');
    expect(error.details['conflictingProjectId']).toBe(registered.id);
  });

  it('allows a sibling whose name is a prefix of an existing project', async () => {
    const { service } = boot();
    await service.create({ localPath: makeDir(workspaceDir.path, 'app') });
    // `application` starts with `app` but is not inside it.
    await expect(
      service.create({ localPath: makeDir(workspaceDir.path, 'application') }),
    ).resolves.toMatchObject({ slug: 'application' });
  });

  it('counts archived projects, whose folder is still theirs', async () => {
    const { service, repository } = boot();
    const folder = makeDir(workspaceDir.path, 'Archived');
    const project = await service.create({ localPath: folder });
    repository.archive(project.id);

    await expect(service.create({ localPath: folder })).rejects.toBeInstanceOf(
      DuplicateProjectError,
    );
  });
});

describe('cost', () => {
  it('inspects a folder with thousands of files in well under a second', async () => {
    const { service } = boot();
    const folder = makeDir(workspaceDir.path, 'big');
    fillWithFiles(folder, 3000);

    const started = performance.now();
    const inspection = await service.inspect(folder);
    const elapsed = performance.now() - started;

    expect(inspection.name).toBe('big');
    // The cost of a tree walk over 3000 entries would show here; one `opendir`
    // read and a couple of `stat`s do not (§2.1).
    expect(elapsed).toBeLessThan(1000);
  });

  it('answers "is it empty" from one directory entry', () => {
    const empty = makeDir(workspaceDir.path, 'empty');
    const full = makeDir(workspaceDir.path, 'full');
    fillWithFiles(full, 500);

    expect(isDirectoryEmpty(empty)).toBe(true);
    expect(isDirectoryEmpty(full)).toBe(false);
    expect(isDirectoryEmpty(resolve(workspaceDir.path, 'missing'))).toBe(false);
  });
});

describe('create re-runs every check inspect ran', () => {
  it('refuses a path deleted between the two calls', async () => {
    const { service } = boot();
    const folder = makeDir(workspaceDir.path, 'transient');
    const inspection = await service.inspect(folder);
    expect(inspection.vcs).toBe('none');

    // The window a client cannot close: inspect and create are separate calls.
    const { rmSync } = await import('node:fs');
    rmSync(folder, { recursive: true, force: true });

    await expect(service.create({ localPath: folder })).rejects.toBeInstanceOf(PathNotFoundError);
  });
});
