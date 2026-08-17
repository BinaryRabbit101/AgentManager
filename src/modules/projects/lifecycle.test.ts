/**
 * Lifecycle and health (projects DESIGN §2.3, §7.10; IMPLEMENTATION M9).
 *
 * M9's first three acceptance criteria — the browse endpoint's two are
 * `browse.test.ts`'s, where they landed with the endpoint itself:
 *
 * 1. "Archived projects are excluded from the default list and refuse new
 *    assignments; history is intact after restore";
 * 2. "Remove deletes registry rows only; the project directory **still exists**
 *    afterwards, and transcripts survive unless `pruneTranscripts=true`";
 * 3. "Renaming the folder on disk shows health `missing`; relocate to the new
 *    path preserves the project id, its activity timeline, and its work items."
 *
 * Criterion 3 renames a real directory rather than mocking `existsSync`: the
 * condition being tested is "the folder is not where the row says it is", and a
 * mocked filesystem tests the mock.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isWorkspaceRefusal, type Project } from './types.js';
import {
  hasGit,
  makeGitRepo,
  makeHarness,
  makeTempDir,
  realGit,
  type TempDir,
  type TestHarness,
} from './__tests__/helpers.js';

let dataRootDir: TempDir;
let workDir: TempDir;
let harness: TestHarness | undefined;

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-projects-lifecycle-data-');
  workDir = makeTempDir('agentmanager-projects-lifecycle-work-');
  harness = undefined;
});

afterEach(() => {
  harness?.storage.close();
  harness = undefined;
  dataRootDir.cleanup();
  workDir.cleanup();
});

function open(options: { git?: boolean } = {}): TestHarness {
  harness = makeHarness({
    dataRoot: dataRootDir.path,
    projectsRoot: resolve(workDir.path, 'projects'),
    worktreesRoot: resolve(workDir.path, 'worktrees'),
    ...(options.git === true ? { git: realGit() } : {}),
  });
  return harness;
}

async function makeProject(h: TestHarness, name = 'App'): Promise<Project> {
  const folder = resolve(workDir.path, name);
  mkdirSync(folder, { recursive: true });
  return h.service.create({ localPath: folder });
}

async function codes(h: TestHarness, projectId: string): Promise<string[]> {
  return (await h.service.health(projectId)).conditions.map((condition) => condition.code);
}

// ---------------------------------------------------------------------------
// M9 acceptance 1
// ---------------------------------------------------------------------------

describe('archive and restore (M9 acceptance 1)', () => {
  it('hides the project, refuses new assignments, and keeps everything on restore', async () => {
    const h = open();
    const project = await makeProject(h);
    const item = h.service.createWorkItem(project.id, { kind: 'bug', title: 'still here' });
    h.storage.store.assignments.create({
      id: 'assignment-history',
      projectId: project.id,
      pattern: 'solo',
    });

    const archived = h.service.archive(project.id);
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).not.toBeNull();

    // Excluded from the default list, present when asked for.
    expect(h.service.list()).toHaveLength(0);
    expect(h.service.list({ includeArchived: true })).toHaveLength(1);

    // "blocks new assignments" — and not retryably: an archived project needs a
    // human to restore it, so queueing would never come good (§4.4).
    const refusal = await h.service.acquireWorkspace(project.id, 'assignment-new', {
      write: true,
    });
    expect(isWorkspaceRefusal(refusal)).toBe(true);
    if (!isWorkspaceRefusal(refusal)) throw new Error('the archived project accepted work');
    expect(refusal.code).toBe('project_not_launchable');
    expect(refusal.retryable).toBe(false);

    expect(h.events.find((event) => event.type === 'project.archived')?.payload).toMatchObject({
      id: project.id,
    });

    // Nothing on disk changed (§2.3).
    expect(existsSync(project.localPath)).toBe(true);

    const restored = h.service.restore(project.id);
    expect(restored.status).toBe('active');
    expect(restored.archivedAt).toBeNull();
    expect(h.service.list()).toHaveLength(1);

    // History is intact: the timeline entry and the backlog survived untouched.
    expect(h.service.activity(project.id).entries.map((entry) => entry.assignmentId)).toEqual([
      'assignment-history',
    ]);
    expect(h.service.listWorkItems(project.id).map((entry) => entry.id)).toEqual([item.id]);

    // And it is launchable again.
    const lease = await h.service.acquireWorkspace(project.id, 'assignment-after', {
      write: true,
    });
    expect(isWorkspaceRefusal(lease)).toBe(false);
  });

  it('is idempotent in both directions', async () => {
    const h = open();
    const project = await makeProject(h, 'Twice');
    const first = h.service.archive(project.id);
    expect(h.service.archive(project.id).archivedAt).toBe(first.archivedAt);
    h.service.restore(project.id);
    expect(h.service.restore(project.id).status).toBe('active');
  });

  it('refuses the launch context for an archived project', async () => {
    const h = open();
    const project = await makeProject(h, 'Blocked');
    const lease = await h.service.acquireWorkspace(project.id, 'assignment-1', { write: true });
    expect(isWorkspaceRefusal(lease)).toBe(false);

    h.service.archive(project.id);
    await expect(
      h.service.getEffectiveLaunchContext(project.id, 'assignment-1'),
    ).rejects.toMatchObject({ code: 'project_not_launchable', projectStatus: 'archived' });
  });
});

// ---------------------------------------------------------------------------
// M9 acceptance 2
// ---------------------------------------------------------------------------

describe('remove (M9 acceptance 2, §7.10)', () => {
  it('deletes registry rows only, leaving the folder and the transcripts alone', async () => {
    const h = open();
    const project = await makeProject(h, 'Removed');
    writeFileSync(resolve(project.localPath, 'work.txt'), 'the user’s own file', 'utf8');
    h.service.createWorkItem(project.id, { kind: 'bug', title: 'goes with it' });

    // A session with a transcript, on a project that keeps no assignment row —
    // foundation refuses the delete while history exists, which is its own rule
    // (§1.4) and has its own test below.
    const result = await h.service.remove(project.id);

    expect(result).toMatchObject({ projectId: project.id, transcriptsPruned: 0 });
    expect(h.repository.get(project.id)).toBeUndefined();
    // The registry's own rows went with it, by cascade.
    expect(h.workItems.list(project.id)).toEqual([]);

    // §7.10: "Never deletes the project folder."
    expect(existsSync(project.localPath)).toBe(true);
    expect(existsSync(resolve(project.localPath, 'work.txt'))).toBe(true);

    expect(h.events.find((event) => event.type === 'project.removed')?.payload).toMatchObject({
      id: project.id,
      localPath: project.localPath,
      folderDeleted: false,
    });
  });

  it('keeps transcripts unless pruneTranscripts is asked for', async () => {
    const h = open();
    const project = await makeProject(h, 'Transcripts');
    h.storage.store.assignments.create({ id: 'a-1', projectId: project.id, pattern: 'solo' });
    const session = h.storage.store.sessions.create({
      assignmentId: 'a-1',
      agentId: 'ada',
      projectId: project.id,
      status: 'done',
    });
    const writer = h.storage.store.transcripts.open(session.id);
    writer.append({ type: 'assistant', text: 'hello' });
    writer.close();
    const transcriptPath = resolve(
      h.storage.paths.transcripts,
      h.storage.store.sessions.get(session.id)?.transcriptPath ?? '',
    );
    expect(existsSync(transcriptPath)).toBe(true);

    // With history recorded, foundation's ON DELETE RESTRICT refuses the row —
    // and the refusal says what to do instead (§1.4, §2.3).
    await expect(h.service.remove(project.id)).rejects.toMatchObject({
      code: 'project_has_history',
    });
    // The transcript survived the refused removal, untouched.
    expect(existsSync(transcriptPath)).toBe(true);

    // Opting in prunes the files even though the row itself cannot go.
    await expect(h.service.remove(project.id, { pruneTranscripts: true })).rejects.toMatchObject({
      code: 'project_has_history',
    });
    expect(existsSync(transcriptPath)).toBe(false);
    expect(h.storage.store.sessions.get(session.id)?.transcriptPath).toBeNull();
  });

  it('refuses while a worktree is still on disk, and cleans up when confirmed', async () => {
    if (!hasGit()) return;
    const h = open({ git: true });
    const folder = resolve(workDir.path, 'repo');
    makeGitRepo(folder);
    const project = await h.service.create({ localPath: folder });

    await h.service.acquireWorkspace(project.id, 'assignment-first', { write: true });
    const worktree = await h.service.acquireWorkspace(project.id, 'assignment-second', {
      write: true,
    });
    if (isWorkspaceRefusal(worktree)) throw new Error('no worktree was created');
    // Something unmerged in it, so the automatic rule would retain it.
    writeFileSync(resolve(worktree.path, 'left-behind.txt'), 'agent output', 'utf8');
    await h.service.releaseWorkspace(worktree.id);
    expect(existsSync(worktree.path)).toBe(true);

    await expect(h.service.remove(project.id)).rejects.toMatchObject({
      code: 'worktrees_outstanding',
    });
    expect(h.repository.get(project.id)).toBeDefined();

    const result = await h.service.remove(project.id, { cleanupWorktrees: true });
    expect(result.worktreesRemoved).toBe(1);
    expect(existsSync(worktree.path)).toBe(false);
    // And still never the project folder.
    expect(existsSync(project.localPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M9 acceptance 3
// ---------------------------------------------------------------------------

describe('missing and relocate (M9 acceptance 3)', () => {
  it('reports health missing, then relocates while keeping id, timeline and work items', async () => {
    const h = open();
    const project = await makeProject(h, 'Moved');
    const item = h.service.createWorkItem(project.id, { kind: 'feature', title: 'survives' });
    h.storage.store.assignments.create({
      id: 'assignment-before',
      projectId: project.id,
      pattern: 'solo',
    });
    h.storage.store.sessions.create({
      assignmentId: 'assignment-before',
      agentId: 'ada',
      projectId: project.id,
      status: 'done',
      summary: 'did some work',
    });

    expect(await codes(h, project.id)).toEqual([]);

    // A real rename, because the condition is "the folder is not where the row
    // says it is" and a mocked `existsSync` would test the mock.
    const moved = resolve(workDir.path, 'Moved-elsewhere');
    renameSync(project.localPath, moved);

    const missing = (await h.service.health(project.id)).conditions.find(
      (condition) => condition.code === 'missing',
    );
    expect(missing?.level).toBe('error');
    expect(missing?.message).toContain(project.localPath);

    const relocated = await h.service.relocate(project.id, moved);

    expect(relocated.id).toBe(project.id);
    expect(relocated.localPath).toBe(moved);
    expect(relocated.localPathKey).toBe(moved.toLowerCase());
    expect(await codes(h, project.id)).toEqual([]);

    expect(h.service.activity(project.id).entries[0]?.sessions[0]?.summary).toBe('did some work');
    expect(h.service.listWorkItems(project.id).map((entry) => entry.id)).toEqual([item.id]);
    expect(h.events.find((event) => event.type === 'project.updated')?.payload).toMatchObject({
      relocatedFrom: project.localPath,
    });
  });

  it('refuses to relocate a project that is still where it says it is', async () => {
    const h = open();
    const project = await makeProject(h, 'Present');
    const elsewhere = resolve(workDir.path, 'Elsewhere');
    mkdirSync(elsewhere, { recursive: true });

    await expect(h.service.relocate(project.id, elsewhere)).rejects.toMatchObject({
      code: 'project_not_missing',
    });
  });

  it('refuses to relocate onto a folder another project already claims', async () => {
    const h = open();
    const first = await makeProject(h, 'First');
    const second = await makeProject(h, 'Second');
    renameSync(first.localPath, resolve(workDir.path, 'First-gone'));

    await expect(h.service.relocate(first.id, second.localPath)).rejects.toMatchObject({
      code: 'project_exists',
    });
  });

  it('re-reads the git facts of the new location', async () => {
    if (!hasGit()) return;
    const h = open({ git: true });
    const project = await makeProject(h, 'WasPlain');
    expect(project.vcs).toBe('none');

    renameSync(project.localPath, resolve(workDir.path, 'WasPlain-gone'));
    const repo = resolve(workDir.path, 'NowARepo');
    makeGitRepo(repo, { remote: 'https://example.invalid/owner/repo.git' });

    const relocated = await h.service.relocate(project.id, repo);
    expect(relocated.vcs).toBe('git');
    expect(relocated.repoUrl).toBe('https://example.invalid/owner/repo.git');
    expect(relocated.defaultBranch).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// The derived health payload (§2.3)
// ---------------------------------------------------------------------------

describe('health is derived on read (§2.3)', () => {
  it('reports dirty for a repository with uncommitted changes, and nothing when clean', async () => {
    if (!hasGit()) return;
    const h = open({ git: true });
    const folder = resolve(workDir.path, 'dirty-repo');
    makeGitRepo(folder);
    const project = await h.service.create({ localPath: folder });

    expect(await codes(h, project.id)).toEqual([]);

    writeFileSync(resolve(folder, 'scratch.txt'), 'uncommitted', 'utf8');
    const dirty = (await h.service.health(project.id)).conditions.find(
      (condition) => condition.code === 'dirty',
    );
    expect(dirty?.level).toBe('warn');
  });

  it('never reports dirty for a non-git project', async () => {
    const h = open({ git: true });
    const project = await makeProject(h, 'PlainFolder');
    writeFileSync(resolve(project.localPath, 'anything.txt'), 'x', 'utf8');
    expect(await codes(h, project.id)).toEqual([]);
  });

  it('does not probe git at all once the folder is missing', async () => {
    // A `dirty` probe on a path that does not exist reports "clean", which is
    // true and useless — so `missing` is reported alone.
    const h = open({ git: true });
    const folder = resolve(workDir.path, 'vanishing-repo');
    if (hasGit()) makeGitRepo(folder);
    else mkdirSync(folder, { recursive: true });
    const project = await h.service.create({ localPath: folder });

    renameSync(folder, resolve(workDir.path, 'vanished'));
    expect(await codes(h, project.id)).toEqual(['missing']);
  });

  it('is never stored: the same project answers differently as the disk changes', async () => {
    const h = open();
    const project = await makeProject(h, 'Derived');
    expect(await codes(h, project.id)).toEqual([]);

    renameSync(project.localPath, resolve(workDir.path, 'Derived-moved'));
    expect(await codes(h, project.id)).toEqual(['missing']);

    renameSync(resolve(workDir.path, 'Derived-moved'), project.localPath);
    expect(await codes(h, project.id)).toEqual([]);
  });
});
