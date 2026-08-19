/**
 * The `projects` module through the real composition root (projects
 * IMPLEMENTATION M1: "Register the module with the core"; M2's two routes).
 *
 * Everything here goes through `boot()` in `src/main.ts` and a real listener on
 * an ephemeral port. That is the point: registering the module is what makes
 * foundation apply `migrations/projects/`, mount the routes and publish the
 * service, and none of those three is observable from a unit test that
 * constructs the module by hand.
 *
 * Acceptance covered:
 * - "The element migration applies **after foundation's core set**, is
 *   idempotent on re-run, and registers in `schema_migrations` under module
 *   `projects`" — proven here through the boot path rather than through
 *   `openStorage` directly, because the migration *order* comes from the module
 *   graph (foundation §1.3);
 * - M2's two routes, including that a refusal arrives as a typed JSON error
 *   rather than a stack;
 * - M6's startup orphan reconciliation, which is a *boot task* — it only runs
 *   because the module registered it, and only in the right phase because
 *   foundation orders it before the listener binds (foundation §4.2).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, type BootOptions, type BootedService } from '../../main.js';

import { PROJECTS_MODULE_ID, PROJECTS_SERVICE } from './module.js';
import type { ProjectsService } from './service.js';
import { isWorkspaceRefusal } from './types.js';
import {
  fileUrl,
  hasGit,
  makeBareRepo,
  makeDir,
  makeGitRepo,
  makeTempDir,
  repoRoot,
  type TempDir,
} from './__tests__/helpers.js';

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

interface Answer<T> {
  readonly status: number;
  readonly body: T;
}

async function post<T>(path: string, body: unknown): Promise<Answer<T>> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function get<T>(path: string): Promise<Answer<T>> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-projects-boot-');
  workspaceDir = makeTempDir('agentmanager-projects-boot-work-');
  service = undefined;
});

afterEach(async () => {
  await service?.shutdown();
  service = undefined;
  dataRootDir.cleanup();
  workspaceDir.cleanup();
});

describe('module registration', () => {
  it('joins the module graph and publishes its service', async () => {
    const booted = await bootCore();

    expect(booted.runtime.order).toContain(PROJECTS_MODULE_ID);
    // Storage first: this element's migration set depends on `projects` existing.
    expect(booted.runtime.order.indexOf('storage')).toBeLessThan(
      booted.runtime.order.indexOf(PROJECTS_MODULE_ID),
    );
    expect(booted.runtime.registry.require<ProjectsService>(PROJECTS_SERVICE)).toBeDefined();
  });

  it('registers its routes on foundation’s one route table', async () => {
    const booted = await bootCore();
    const mine = booted.runtime.routes.routes.filter(
      (route) => route.moduleId === PROJECTS_MODULE_ID,
    );

    expect(mine.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/projects/:id',
      // ui M2's quick-add is this one's only consumer, and cannot register a
      // folder from a browser without it (ui §8.1).
      'GET /api/fs/browse',
      'GET /api/projects',
      'GET /api/projects/:id',
      'GET /api/projects/:id/activity',
      'GET /api/projects/:id/health',
      'GET /api/projects/:id/work-items',
      'GET /api/projects/:id/workspaces',
      'PATCH /api/projects/:id',
      'PATCH /api/work-items/:id',
      'POST /api/projects',
      'POST /api/projects/:id/archive',
      'POST /api/projects/:id/relocate',
      'POST /api/projects/:id/restore',
      'POST /api/projects/:id/work-items',
      'POST /api/projects/:id/workspaces/:leaseId/cleanup',
      'POST /api/projects/clone',
      'POST /api/projects/inspect',
    ]);
    // Quick-add has to work from the tailnet browser too (D3).
    expect(mine.every((route) => route.remote === 'allow')).toBe(true);
  });

  it('reports healthy, with the project count', async () => {
    const booted = await bootCore();
    const health = await booted.health();
    const mine = health.modules.find((module) => module.id === PROJECTS_MODULE_ID);

    expect(mine?.status).toBe('ok');
    expect(mine?.detail).toMatchObject({ projects: 0 });
  });
});

describe('the element migration, through boot', () => {
  it('applies after foundation’s set and records itself under module "projects"', async () => {
    const booted = await bootCore();

    expect(booted.storage.setVersions['projects']).toBe(2);
    expect(booted.storage.applied.map((entry) => entry.setId)).toEqual([
      // Foundation's numbered set first, then each element's in module
      // topological order (§1.3) — `roster` sits before `projects`, which sits
      // before `runner`, which sits before `orchestrator`. One entry per
      // *migration*: `projects` twice (0001 plus 0002_lease_scope), `runner`
      // four times (0001, 0002_usage, M11's 0003_usage_windows and WO8's
      // 0004_background_band) and `orchestrator` eight (0001, 0002_breakers,
      // 0003_turn_exit_reason, WO4's 0004_pre_grants and 0005_turn_denied_tools,
      // WO5's 0006_template_id, and WO8's 0007_triggers and
      // 0008_assignment_origin).
      'foundation',
      'roster',
      'projects',
      'projects',
      'runner',
      'runner',
      'runner',
      'runner',
      'orchestrator',
      'orchestrator',
      'orchestrator',
      'orchestrator',
      'orchestrator',
      'orchestrator',
      'orchestrator',
      'orchestrator',
    ]);

    const rows = booted.storage.db
      .prepare<[], { module: string; version: number }>(
        'SELECT module, version FROM schema_migrations ORDER BY module, version',
      )
      .all();
    expect(rows).toEqual([
      { module: 'orchestrator', version: 1 },
      { module: 'orchestrator', version: 2 },
      { module: 'orchestrator', version: 3 },
      { module: 'orchestrator', version: 4 },
      { module: 'orchestrator', version: 5 },
      { module: 'orchestrator', version: 6 },
      { module: 'orchestrator', version: 7 },
      { module: 'orchestrator', version: 8 },
      { module: 'projects', version: 1 },
      { module: 'projects', version: 2 },
      { module: 'roster', version: 1 },
      { module: 'runner', version: 1 },
      { module: 'runner', version: 2 },
      { module: 'runner', version: 3 },
      { module: 'runner', version: 4 },
    ]);
  });

  it('applies nothing on a second boot against the same data root', async () => {
    const first = await bootCore();
    expect(first.storage.applied.length).toBeGreaterThan(0);
    await first.shutdown();
    service = undefined;

    const second = await bootCore();
    expect(second.storage.applied).toEqual([]);
    expect(second.storage.setVersions['projects']).toBe(2);
    expect(
      second.storage.db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM schema_migrations WHERE module = 'projects'",
        )
        .get()?.n,
    ).toBe(2);
  });
});

describe('POST /api/projects/inspect', () => {
  it('returns a pre-filled form for a plain folder', async () => {
    await bootCore();
    const folder = makeDir(workspaceDir.path, 'Quick Add');

    const answer = await post<{ name: string; slug: string; vcs: string; repoUrl: null }>(
      '/api/projects/inspect',
      { localPath: folder },
    );

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      name: 'Quick Add',
      slug: 'quick-add',
      vcs: 'none',
      repoUrl: null,
      localPath: folder,
    });
  });

  it('answers a missing localPath with a typed 400, not a stack', async () => {
    await bootCore();
    const answer = await post<{ error: string; message: string; field: string }>(
      '/api/projects/inspect',
      {},
    );

    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('invalid_request');
    expect(answer.body.field).toBe('localPath');
    expect(JSON.stringify(answer.body)).not.toContain('    at ');
  });

  it.each([
    ['a path that does not exist', 'missing-folder', 'path_not_found', false],
    ['a path that is a file', 'a-file.txt', 'path_not_directory', true],
  ])('answers %s with %s', async (_label, leaf, code, asFile) => {
    await bootCore();
    const target = resolve(workspaceDir.path, leaf);
    if (asFile) writeFileSync(target, 'not a folder', 'utf8');

    const answer = await post<{ error: string; message: string }>('/api/projects/inspect', {
      localPath: target,
    });

    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe(code);
    expect(answer.body.message).toContain(target);
    expect(JSON.stringify(answer.body)).not.toContain('    at ');
  });
});

describe('POST /api/projects', () => {
  it('registers a folder and answers 201 with a Location header', async () => {
    await bootCore();
    const folder = makeDir(workspaceDir.path, 'Registered');

    const response = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localPath: folder, notes: 'from the form' }),
    });
    const project = (await response.json()) as { id: string; slug: string; notes: string };

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe(`/api/projects/${project.id}`);
    expect(project.slug).toBe('registered');
    expect(project.notes).toBe('from the form');
  });

  it('answers a second registration of the same folder with 409, naming the first', async () => {
    await bootCore();
    const folder = makeDir(workspaceDir.path, 'Twice');
    const first = await post<{ id: string; name: string }>('/api/projects', { localPath: folder });
    expect(first.status).toBe(201);

    const second = await post<{ error: string; existingProjectId: string; message: string }>(
      '/api/projects',
      // A different spelling of the same directory: NTFS is case-insensitive (§7.4).
      { localPath: folder.toUpperCase() },
    );

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('project_exists');
    expect(second.body.existingProjectId).toBe(first.body.id);
    expect(second.body.message).toContain(first.body.name);
  });

  it('answers a nested registration with 409, naming the conflicting project', async () => {
    await bootCore();
    const parent = makeDir(workspaceDir.path, 'Outer');
    const created = await post<{ id: string }>('/api/projects', {
      localPath: parent,
      name: 'The Outer One',
    });
    mkdirSync(resolve(parent, 'inner'), { recursive: true });

    const nested = await post<{ error: string; conflictingProjectId: string; message: string }>(
      '/api/projects',
      { localPath: resolve(parent, 'inner') },
    );

    expect(nested.status).toBe(409);
    expect(nested.body.error).toBe('nested_project');
    expect(nested.body.conflictingProjectId).toBe(created.body.id);
    expect(nested.body.message).toContain('The Outer One');
  });

  it('rejects a workspacePolicy outside its union', async () => {
    await bootCore();
    const answer = await post<{ error: string; field: string }>('/api/projects', {
      localPath: makeDir(workspaceDir.path, 'bad-policy'),
      workspacePolicy: 'whatever',
    });

    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('invalid_request');
    expect(answer.body.field).toBe('workspacePolicy');
  });

  it('survives a restart: the project is still there', async () => {
    const first = await bootCore();
    const folder = makeDir(workspaceDir.path, 'Durable');
    const created = await post<{ id: string }>('/api/projects', { localPath: folder });
    await first.shutdown();
    service = undefined;

    const second = await bootCore();
    const projects = second.runtime.registry.require<ProjectsService>(PROJECTS_SERVICE);
    expect(projects?.repository.get(created.body.id)?.localPath).toBe(folder);
  });
});

describe('the workspace boot task (M6, DESIGN §4.4)', () => {
  it('orphans a lease left active by a previous run and surfaces it in health', async () => {
    const first = await bootCore();
    const folder = makeDir(workspaceDir.path, 'Interrupted');
    const created = await post<{ id: string }>('/api/projects', { localPath: folder });
    const projects = first.runtime.registry.require<ProjectsService>(PROJECTS_SERVICE);
    if (projects === undefined) throw new Error('the projects service is not published');

    const lease = await projects.acquireWorkspace(created.body.id, 'assignment-1', { write: true });
    if (isWorkspaceRefusal(lease)) throw new Error('the primary tree was refused');
    expect(lease.state).toBe('active');

    // "Killing the service mid-assignment": shutdown leaves the lease `active`,
    // because nothing released it.
    await first.shutdown();
    service = undefined;

    const second = await bootCore();
    const restarted = second.runtime.registry.require<ProjectsService>(PROJECTS_SERVICE);
    if (restarted === undefined) throw new Error('the projects service is not published');

    // The boot task ran before the listener bound, so by the time anything can
    // ask, last run's lease is already orphaned rather than still holding the
    // primary tree.
    const workspaces = await restarted.listWorkspaces(created.body.id);
    expect(workspaces.map((entry) => entry.state)).toEqual(['orphaned']);
    expect(
      (await restarted.health(created.body.id)).conditions.map((condition) => condition.code),
    ).toContain('orphaned-worktrees');

    // And the tree is free again: the same assignment re-acquires, without a
    // second active lease for the pair.
    const again = await restarted.acquireWorkspace(created.body.id, 'assignment-1', {
      write: true,
    });
    if (isWorkspaceRefusal(again)) throw new Error('re-acquisition was refused');
    expect(again.state).toBe('active');
    expect(
      (await restarted.listWorkspaces(created.body.id)).filter((entry) => entry.state === 'active'),
    ).toHaveLength(1);
  });
});

describe('the clone route, over the listener (M3, §2.2)', () => {
  it.runIf(hasGit())(
    'registers a cloned repository and flips it to active',
    async () => {
      const projectsRoot = resolve(workspaceDir.path, 'projects');
      await bootCore({
        argv: ['--set', `projects.root=${JSON.stringify(projectsRoot)}`],
      });

      const source = resolve(workspaceDir.path, 'origin-source');
      makeGitRepo(source);
      const origin = fileUrl(makeBareRepo(source, resolve(workspaceDir.path, 'origin.git')));

      // §2.2 step 1: the form is filled from the URL alone, and the target is
      // proposed under `projects.root`.
      const inspected = await post<{ name: string; slug: string; targetPath: string }>(
        '/api/projects/inspect',
        { repoUrl: origin },
      );
      expect(inspected.status).toBe(200);
      expect(inspected.body.name).toBe('origin');
      expect(inspected.body.targetPath).toBe(resolve(projectsRoot, 'origin'));

      const response = await fetch(`${base}/api/projects/clone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoUrl: origin }),
      });
      const project = (await response.json()) as { id: string; status: string };
      // 202: the row exists, the checkout does not yet (§2.2 step 2).
      expect(response.status).toBe(202);
      expect(response.headers.get('location')).toBe(`/api/projects/${project.id}`);
      expect(project.status).toBe('provisioning');

      // The job outlives the request, so the test waits for it the way the UI
      // does — by asking again.
      const deadline = Date.now() + 30_000;
      let current = project.status;
      while (current === 'provisioning' && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 50));
        current = (await get<{ status: string }>(`/api/projects/${project.id}`)).body.status;
      }

      expect(current).toBe('active');
      const final = await get<{ localPath: string; defaultBranch: string }>(
        `/api/projects/${project.id}`,
      );
      expect(final.body.defaultBranch).toBe('main');
      expect(existsSync(resolve(final.body.localPath, 'README.md'))).toBe(true);
    },
    40_000,
  );

  it('answers a body with no repoUrl and no localPath with a typed 400', async () => {
    await bootCore();
    const answer = await post<{ error: string; field: string }>('/api/projects/clone', {});
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('invalid_request');
    expect(answer.body.field).toBe('repoUrl');
  });
});

describe('the work-item routes (M8, §5)', () => {
  it('creates, lists in rank order, and patches', async () => {
    await bootCore();
    const project = await post<{ id: string }>('/api/projects', {
      localPath: makeDir(workspaceDir.path, 'Backlog'),
    });

    const created = await fetch(`${base}/api/projects/${project.body.id}/work-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'bug', title: 'the crash', body: 'stack attached' }),
    });
    const item = (await created.json()) as { id: string; status: string; rank: number };
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe(`/api/work-items/${item.id}`);
    expect(item.status).toBe('open');

    const listed = await get<{ workItems: { id: string; title: string }[] }>(
      `/api/projects/${project.body.id}/work-items?status=open`,
    );
    expect(listed.body.workItems.map((entry) => entry.title)).toEqual(['the crash']);

    const patched = await fetch(`${base}/api/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    const done = (await patched.json()) as { status: string; closedAt: string | null };
    expect(done.status).toBe('done');
    expect(done.closedAt).not.toBeNull();

    // And it has left the open board.
    const remaining = await get<{ workItems: unknown[] }>(
      `/api/projects/${project.body.id}/work-items?status=open`,
    );
    expect(remaining.body.workItems).toEqual([]);
  });

  it('refuses a title-less item and an unknown patch field, with the field named', async () => {
    await bootCore();
    const project = await post<{ id: string }>('/api/projects', {
      localPath: makeDir(workspaceDir.path, 'Refusals'),
    });

    const noTitle = await post<{ error: string; field: string }>(
      `/api/projects/${project.body.id}/work-items`,
      { kind: 'bug' },
    );
    expect(noTitle.status).toBe(400);
    expect(noTitle.body.field).toBe('title');

    const item = await post<{ id: string }>(`/api/projects/${project.body.id}/work-items`, {
      kind: 'bug',
      title: 'ok',
    });
    const response = await fetch(`${base}/api/work-items/${item.body.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assignee: 'ada' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { field: string }).field).toBe('assignee');
  });
});

describe('the lifecycle routes (M9, §2.3)', () => {
  it('archives, restores and removes, never touching the folder', async () => {
    await bootCore();
    const folder = makeDir(workspaceDir.path, 'Lifecycle');
    const project = await post<{ id: string }>('/api/projects', { localPath: folder });

    expect((await post(`/api/projects/${project.body.id}/archive`, {})).status).toBe(200);
    expect((await get<{ projects: unknown[] }>('/api/projects')).body.projects).toHaveLength(0);
    expect(
      (await get<{ projects: unknown[] }>('/api/projects?includeArchived=true')).body.projects,
    ).toHaveLength(1);

    expect((await post(`/api/projects/${project.body.id}/restore`, {})).status).toBe(200);
    expect((await get<{ projects: unknown[] }>('/api/projects')).body.projects).toHaveLength(1);

    const removed = await fetch(`${base}/api/projects/${project.body.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await get<{ error: string }>(`/api/projects/${project.body.id}`)).status).toBe(404);
    // §7.10, over HTTP as well as in the service.
    expect(existsSync(folder)).toBe(true);
  });

  it('serves the activity timeline, paged', async () => {
    await bootCore();
    const project = await post<{ id: string }>('/api/projects', {
      localPath: makeDir(workspaceDir.path, 'Timeline'),
    });

    const answer = await get<{ entries: unknown[]; total: number; limit: number; offset: number }>(
      `/api/projects/${project.body.id}/activity?limit=10&offset=0`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ entries: [], total: 0, limit: 10, offset: 0 });
  });
});

describe('the bus subscriptions the module wires (M5, M8)', () => {
  it('stamps lastActivityAt and starts work items when a session starts', async () => {
    const booted = await bootCore();
    const project = await post<{ id: string; lastActivityAt: string | null }>('/api/projects', {
      localPath: makeDir(workspaceDir.path, 'Live'),
    });
    expect(project.body.lastActivityAt).toBeNull();

    const projects = booted.runtime.registry.require<ProjectsService>(PROJECTS_SERVICE);
    if (projects === undefined) throw new Error('the projects service is not published');

    const item = projects.createWorkItem(project.body.id, { kind: 'bug', title: 'in flight' });
    booted.storage.store.assignments.create({
      id: 'assignment-live',
      projectId: project.body.id,
      pattern: 'solo',
    });
    projects.linkWorkItems('assignment-live', [item.id]);

    // Runner emits this with the ids already populated (runner §10); the module
    // subscribes rather than being pushed to, because a feature module never
    // imports another (foundation §6.1).
    booted.runtime.bus.emit({
      type: 'session.started',
      ids: {
        projectId: project.body.id,
        assignmentId: 'assignment-live',
        sessionId: 'session-1',
        agentId: 'ada',
      },
      payload: {},
    });

    expect(projects.repository.get(project.body.id)?.lastActivityAt).not.toBeNull();
    expect(projects.workItems.get(item.id)?.status).toBe('in_progress');

    // And the other half: closing the assignment returns it to `open`.
    booted.storage.store.assignments.close('assignment-live');
    booted.runtime.bus.emit({
      type: 'assignment.closed',
      ids: { projectId: project.body.id, assignmentId: 'assignment-live' },
      payload: {},
    });
    expect(projects.workItems.get(item.id)?.status).toBe('open');
  });
});

describe('GET /api/fs/browse, over the listener (§2.1; ui §8.1)', () => {
  /**
   * The browse roots are set on the command line so the assertions do not
   * depend on the developer's own `%USERPROFILE%` — the default roots are real
   * behaviour and are covered by `browse.test.ts`; what is proven here is that
   * the route is mounted, remote-allowed, and refuses through the HTTP layer
   * rather than only in the function.
   */
  async function bootWithRoots(...roots: string[]): Promise<void> {
    await bootCore({ argv: ['--set', `projects.browseRoots=${JSON.stringify(roots)}`] });
  }

  it('lists the configured roots when asked for no path', async () => {
    const root = makeDir(workspaceDir.path, 'Code');
    await bootWithRoots(root);

    const answer = await get<{ path: string; parent: string | null; roots: string[] }>(
      '/api/fs/browse',
    );
    expect(answer.status).toBe(200);
    expect(answer.body.path).toBe('');
    expect(answer.body.parent).toBeNull();
    expect(answer.body.roots).toHaveLength(1);
  });

  it('descends into a folder and returns directories only', async () => {
    const root = makeDir(workspaceDir.path, 'Code');
    makeDir(root, 'my-app');
    writeFileSync(resolve(root, 'notes.txt'), 'not a folder', 'utf8');
    await bootWithRoots(root);

    const answer = await get<{ entries: { name: string; path: string }[] }>(
      `/api/fs/browse?path=${encodeURIComponent(root)}`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.entries.map((entry) => entry.name)).toEqual(['my-app']);
  });

  it('refuses a path outside the roots with a typed 403 naming the path', async () => {
    const root = makeDir(workspaceDir.path, 'Code');
    const elsewhere = makeDir(workspaceDir.path, 'Elsewhere');
    await bootWithRoots(root);

    const answer = await get<{ error: string; message: string; path: string }>(
      `/api/fs/browse?path=${encodeURIComponent(elsewhere)}`,
    );
    // Containment is the whole of this route's access control (remote §3.3).
    expect(answer.status).toBe(403);
    expect(answer.body.error).toBe('browse_root_violation');
    expect(answer.body.message).toContain('Elsewhere');
    expect(answer.body.message).toContain('projects.browseRoots');
  });

  it('refuses a UNC path outright, with its own reason', async () => {
    await bootWithRoots(makeDir(workspaceDir.path, 'Code'));
    const answer = await get<{ error: string }>(
      `/api/fs/browse?path=${encodeURIComponent(String.raw`\\fileserver\share`)}`,
    );
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('network_path_refused');
  });

  it('is a quick-add path the tailnet browser can use, and the round trip feeds inspect', async () => {
    // ui §8.1: "the browser path works identically over the tailnet … so project
    // registration is never stranded on the desktop". The endpoint's own output
    // is what the dialog posts to `inspect`, unmodified.
    const root = makeDir(workspaceDir.path, 'Code');
    makeDir(root, 'my-app');
    await bootWithRoots(root);

    const listing = await get<{ entries: { name: string; path: string }[] }>(
      `/api/fs/browse?path=${encodeURIComponent(root)}`,
    );
    const target = listing.body.entries[0]?.path;
    expect(target).toBeDefined();

    const inspected = await post<{ localPath: string; name: string; slug: string }>(
      '/api/projects/inspect',
      { localPath: target },
    );
    expect(inspected.status).toBe(200);
    expect(inspected.body.name).toBe('my-app');
  });
});
