/**
 * Clone from a repo URL (projects DESIGN §2.2; IMPLEMENTATION M3).
 *
 * M3's four acceptance criteria, each with a named test:
 *
 * 1. "Cloning a small public repo produces an `active` project whose
 *    `localPath` contains a working checkout, with at least one intermediate
 *    `project.clone.progress` event observed";
 * 2. "A bad URL and an auth failure both end as `project.clone.failed` carrying
 *    git's stderr; no project row and no directory remain";
 * 3. "A `provisioning` project is rejected by the launch-context call";
 * 4. "Target path already exists and is non-empty → refused before any clone
 *    starts".
 *
 * **The "public repo" is local.** Criterion 1 is about the clone *path* — git's
 * transport, `--progress` on stderr, a real working checkout at the end — and a
 * test that reaches github.com is a test of the network and of whoever owns that
 * repository. A bare repository behind a `file://` URL exercises every one of
 * those with the real `git` executable and the real spawn-based runner.
 *
 * The auth failure is the one case a local fixture genuinely cannot produce
 * without inventing a credential helper to fail, so it is injected at the runner
 * seam — which is exactly what the seam is for, and the assertion is that git's
 * stderr reaches the event verbatim rather than that git said it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGitCloneRunner, parseCloneProgress } from './clone.js';
import { parseRepoUrl } from './repoUrl.js';
import { isWorkspaceRefusal } from './types.js';
import {
  fileUrl,
  hasGit,
  makeBareRepo,
  makeGitRepo,
  makeHarness,
  makeTempDir,
  refusalFrom,
  scriptedCloneRunner,
  type TempDir,
  type TestHarness,
} from './__tests__/helpers.js';

let dataRootDir: TempDir;
let workDir: TempDir;
let harness: TestHarness | undefined;

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-projects-clone-data-');
  workDir = makeTempDir('agentmanager-projects-clone-work-');
  harness = undefined;
});

afterEach(() => {
  // The SQLite handle holds the data root open on Windows, so it closes before
  // the directory is removed rather than after.
  harness?.storage.close();
  harness = undefined;
  dataRootDir.cleanup();
  workDir.cleanup();
});

/** The projects root lives outside the data root: §1.1 refuses anything inside it. */
function projectsRoot(): string {
  return resolve(workDir.path, 'projects');
}

function harnessWith(cloneRunner?: Parameters<typeof makeHarness>[0]['cloneRunner']): TestHarness {
  harness = makeHarness({
    dataRoot: dataRootDir.path,
    projectsRoot: projectsRoot(),
    ...(cloneRunner === undefined ? {} : { cloneRunner }),
  });
  return harness;
}

/** A bare repository to clone from, and the `file://` URL that names it. */
function fixtureOrigin(name = 'fixture'): string {
  const source = resolve(workDir.path, `${name}-source`);
  makeGitRepo(source);
  return fileUrl(makeBareRepo(source, resolve(workDir.path, `${name}.git`)));
}

// ---------------------------------------------------------------------------
// URL parsing (§2.2 step 1)
// ---------------------------------------------------------------------------

describe('parseRepoUrl (§2.2 step 1)', () => {
  it.each([
    ['https://github.com/owner/repo.git', 'https', 'github.com', 'repo'],
    ['https://github.com/owner/repo', 'https', 'github.com', 'repo'],
    ['ssh://git@github.com/owner/repo.git', 'ssh', 'github.com', 'repo'],
    // git's scp-like form, which is not a URL and must not be handed to `new URL`.
    ['git@github.com:owner/repo.git', 'ssh', 'github.com', 'repo'],
    ['git@gitlab.example.com:group/sub/thing.git', 'ssh', 'gitlab.example.com', 'thing'],
  ])('parses %s', (url, scheme, host, name) => {
    const parsed = parseRepoUrl(url);
    expect(parsed.scheme).toBe(scheme);
    expect(parsed.host).toBe(host);
    expect(parsed.name).toBe(name);
    expect(parsed.url).toBe(url);
  });

  it('names a local path as the wrong dialog rather than as an unsupported scheme', () => {
    expect(() => parseRepoUrl('C:\\Code\\App')).toThrowError(/Add existing folder/);
    expect(() => parseRepoUrl('\\\\server\\share\\repo')).toThrowError(/Add existing folder/);
  });

  it.each([
    ['', 'the URL is empty'],
    ['   ', 'the URL is empty'],
    ['not a url at all', 'scp-like'],
    ['ftp://example.com/repo.git', 'not a transport'],
  ])('refuses %s with a reason', (url, fragment) => {
    expect(() => parseRepoUrl(url)).toThrowError(new RegExp(fragment));
  });

  it('carries the field name so the form can highlight it', () => {
    expect(refusalFrom(() => parseRepoUrl(42)).code).toBe('invalid_repo_url');
  });
});

describe('parseCloneProgress', () => {
  it.each([
    ["Cloning into 'C:\\tmp\\app'...", 'Cloning', null],
    ['Receiving objects:  47% (14/29)', 'Receiving objects', 47],
    ['remote: Counting objects:  100% (3/3), done.', 'Counting objects', 100],
    ['Resolving deltas: 100% (1/1), done.', 'Resolving deltas', 100],
    ['remote: Enumerating objects: 3, done.', 'Enumerating objects', null],
  ])('classifies %s', (line, phase, percent) => {
    expect(parseCloneProgress(line)).toEqual({ phase, percent });
  });

  it('classifies nothing it does not recognise, so a warning is not a progress bar', () => {
    expect(parseCloneProgress('warning: redirecting to https://example.com/')).toBeUndefined();
    expect(parseCloneProgress('   ')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M3 acceptance 1
// ---------------------------------------------------------------------------

describe.runIf(hasGit())('cloning a repository (M3 acceptance 1)', () => {
  it('produces an active project with a working checkout, having reported progress', async () => {
    const h = harnessWith(createGitCloneRunner());
    const origin = fixtureOrigin();

    const started = h.service.clone({ repoUrl: origin });

    // §2.2 step 2: the row exists *before* the clone finishes, which is what
    // lets the user close the dialog.
    expect(started.project.status).toBe('provisioning');
    expect(started.project.vcs).toBe('git');
    expect(started.project.localPath).toBe(resolve(projectsRoot(), 'fixture'));

    const outcome = await started.completed;
    expect(outcome.status).toBe('completed');

    const project = h.repository.get(started.project.id);
    expect(project?.status).toBe('active');
    // §2.2 step 4: "on success the row flips to `active` and `defaultBranch` is
    // filled".
    expect(project?.defaultBranch).toBe('main');
    expect(project?.repoUrl).toBe(origin);

    // A *working* checkout, not a bare mirror: the file from the fixture commit
    // is on disk and `.git` is a directory.
    const checkout = project?.localPath ?? '';
    expect(readFileSync(resolve(checkout, 'README.md'), 'utf8')).toContain('fixture');
    expect(existsSync(resolve(checkout, '.git'))).toBe(true);

    const progress = h.events.filter((event) => event.type === 'project.clone.progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]?.ids.projectId).toBe(started.project.id);
    expect(progress.map((event) => (event.payload as { phase: string }).phase)).toContain(
      'Cloning',
    );

    const completed = h.events.find((event) => event.type === 'project.clone.completed');
    expect(completed?.payload).toMatchObject({
      projectId: started.project.id,
      defaultBranch: 'main',
    });
  });

  it('takes the target path and the name the form reviewed', async () => {
    const h = harnessWith(createGitCloneRunner());
    const target = resolve(workDir.path, 'somewhere-else', 'checkout');

    const started = h.service.clone({
      repoUrl: fixtureOrigin('named'),
      targetPath: target,
      name: 'The Reviewed Name',
    });
    await started.completed;

    const project = h.repository.get(started.project.id);
    expect(project?.name).toBe('The Reviewed Name');
    expect(project?.slug).toBe('the-reviewed-name');
    expect(project?.localPath).toBe(target);
  });
});

// ---------------------------------------------------------------------------
// M3 acceptance 2
// ---------------------------------------------------------------------------

describe.runIf(hasGit())('a bad URL (M3 acceptance 2)', () => {
  it('fails, carries git’s stderr, and leaves no row and no directory', async () => {
    const h = harnessWith(createGitCloneRunner());
    const missing = fileUrl(resolve(workDir.path, 'no-such-repository.git'));

    const started = h.service.clone({ repoUrl: missing });
    const projectId = started.project.id;
    // The row existed while the job ran — which is what makes the rollback a
    // rollback rather than a check that ran first.
    expect(h.repository.get(projectId)).toBeDefined();

    const outcome = await started.completed;
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('the clone unexpectedly succeeded');
    expect(outcome.stderr.length).toBeGreaterThan(0);

    const failed = h.events.find((event) => event.type === 'project.clone.failed');
    expect(failed?.ids.projectId).toBe(projectId);
    // Verbatim: git names the path it could not read, and paraphrasing would
    // lose it.
    expect((failed?.payload as { stderr: string }).stderr).toBe(outcome.stderr);

    expect(h.repository.get(projectId)).toBeUndefined();
    expect(existsSync(resolve(projectsRoot(), 'no-such-repository'))).toBe(false);
  });
});

describe('an auth failure (M3 acceptance 2)', () => {
  it('fails with git’s stderr verbatim, and rolls the row and directory back', async () => {
    const stderr =
      "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/owner/private.git/'";
    const h = harnessWith(
      scriptedCloneRunner((args) => {
        // The runner is asked for the real clone command, and answers the way a
        // credential helper rejection does: the target it created stays behind.
        const target = args.at(-1);
        if (target !== undefined) mkdirSync(target, { recursive: true });
        return { ok: false, stderr };
      }),
    );

    const started = h.service.clone({ repoUrl: 'https://github.com/owner/private.git' });
    const outcome = await started.completed;

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('the clone unexpectedly succeeded');
    expect(outcome.stderr).toBe(stderr);
    expect(outcome.rowDeleted).toBe(true);
    expect(outcome.directoryRemoved).toBe(true);

    expect(h.repository.get(started.project.id)).toBeUndefined();
    expect(existsSync(resolve(projectsRoot(), 'private'))).toBe(false);
    expect(
      (
        h.events.find((event) => event.type === 'project.clone.failed')?.payload as {
          stderr: string;
        }
      ).stderr,
    ).toContain('Authentication failed');
  });

  it('keeps a target directory the user made themselves', async () => {
    // §2.2 step 4: the directory is removed "**only if** the clone created it".
    const target = resolve(workDir.path, 'mine');
    mkdirSync(target, { recursive: true });

    const h = harnessWith(scriptedCloneRunner(() => ({ ok: false, stderr: 'fatal: nope' })));
    const started = h.service.clone({
      repoUrl: 'https://example.com/owner/mine.git',
      targetPath: target,
    });
    await started.completed;

    expect(existsSync(target)).toBe(true);
    expect(h.repository.get(started.project.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M3 acceptance 3
// ---------------------------------------------------------------------------

describe('a provisioning project (M3 acceptance 3)', () => {
  it('is rejected by the launch-context call', async () => {
    const h = harnessWith(
      // Never resolves during the test: the row stays `provisioning`, which is
      // the state under test.
      () => new Promise(() => undefined),
    );
    const started = h.service.clone({ repoUrl: 'https://example.com/owner/slow.git' });

    await expect(
      h.service.getEffectiveLaunchContext(started.project.id, 'assignment-1'),
    ).rejects.toMatchObject({ code: 'project_not_launchable', projectStatus: 'provisioning' });
  });

  it('is refused a workspace, retryably — a clone finishes on its own', async () => {
    const h = harnessWith(() => new Promise(() => undefined));
    const started = h.service.clone({ repoUrl: 'https://example.com/owner/slow.git' });

    const result = await h.service.acquireWorkspace(started.project.id, 'assignment-1', {
      write: true,
    });
    expect(isWorkspaceRefusal(result)).toBe(true);
    if (!isWorkspaceRefusal(result)) throw new Error('the workspace was not refused');
    expect(result.code).toBe('project_not_launchable');
    expect(result.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M3 acceptance 4
// ---------------------------------------------------------------------------

describe('a target that already exists (M3 acceptance 4)', () => {
  it('is refused before any clone starts, leaving no row', () => {
    let invoked = 0;
    const h = harnessWith(() => {
      invoked += 1;
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    });

    const target = resolve(projectsRoot(), 'occupied');
    mkdirSync(target, { recursive: true });
    writeFileSync(resolve(target, 'something.txt'), 'already here', 'utf8');

    expect(
      refusalFrom(() =>
        h.service.clone({ repoUrl: 'https://example.com/owner/occupied.git', targetPath: target }),
      ).code,
    ).toBe('clone_target_exists');

    expect(invoked).toBe(0);
    expect(h.repository.list({ includeArchived: true })).toHaveLength(0);
  });

  it('allows an existing but empty target — git accepts one, and so does this', async () => {
    const h = harnessWith(scriptedCloneRunner(() => ({ ok: true })));
    const target = resolve(projectsRoot(), 'empty-but-there');
    mkdirSync(target, { recursive: true });

    const started = h.service.clone({
      repoUrl: 'https://example.com/owner/empty-but-there.git',
      targetPath: target,
    });
    const outcome = await started.completed;
    expect(outcome.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Inspect (§2.2 step 1)
// ---------------------------------------------------------------------------

describe('POST /api/projects/inspect { repoUrl } (§2.2 step 1)', () => {
  it('derives the name, the slug and a target under projectsRoot', () => {
    const h = harnessWith();
    const inspection = h.service.inspectRepoUrl('https://github.com/owner/My-App.git');

    expect(inspection).toMatchObject({
      name: 'My-App',
      slug: 'my-app',
      host: 'github.com',
      targetPath: resolve(projectsRoot(), 'My-App'),
      targetExists: false,
      targetEmpty: true,
    });
    expect(inspection.warnings).toEqual([]);
  });

  it('reports a target that already exists and is not empty, without refusing', () => {
    const h = harnessWith();
    const target = resolve(projectsRoot(), 'taken');
    mkdirSync(target, { recursive: true });
    writeFileSync(resolve(target, 'file.txt'), 'x', 'utf8');

    const inspection = h.service.inspectRepoUrl('https://github.com/owner/taken.git');
    expect(inspection.targetExists).toBe(true);
    expect(inspection.targetEmpty).toBe(false);
    expect(inspection.warnings.map((warning) => warning.code)).toContain('target-not-empty');
  });

  it('deduplicates the proposed slug against the registry', () => {
    const h = harnessWith();
    const folder = resolve(workDir.path, 'taken-slug');
    mkdirSync(folder, { recursive: true });
    h.repository.create({
      name: 'App',
      slug: 'app',
      localPath: folder,
      localPathKey: folder.toLowerCase(),
      vcs: 'none',
    });

    expect(h.service.inspectRepoUrl('https://github.com/owner/app.git').slug).toBe('app-2');
  });

  it('refuses a target that would nest inside an existing project', () => {
    const h = harnessWith();
    const parent = resolve(workDir.path, 'outer');
    mkdirSync(parent, { recursive: true });
    h.repository.create({
      name: 'Outer',
      slug: 'outer',
      localPath: parent,
      localPathKey: parent.toLowerCase(),
      vcs: 'none',
    });

    expect(
      refusalFrom(() =>
        h.service.inspectRepoUrl('https://github.com/owner/inner.git', resolve(parent, 'inner')),
      ).code,
    ).toBe('nested_project');
  });

  it('refuses a target inside AgentManager’s own data root', () => {
    const h = harnessWith();
    expect(
      refusalFrom(() =>
        h.service.inspectRepoUrl(
          'https://github.com/owner/inside.git',
          resolve(dataRootDir.path, 'inside'),
        ),
      ).code,
    ).toBe('path_in_data_root');
  });
});
