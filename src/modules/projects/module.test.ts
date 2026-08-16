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
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, type BootOptions, type BootedService } from '../../main.js';

import { PROJECTS_MODULE_ID, PROJECTS_SERVICE } from './module.js';
import type { ProjectsService } from './service.js';
import { isWorkspaceRefusal } from './types.js';
import { makeDir, makeTempDir, repoRoot, type TempDir } from './__tests__/helpers.js';

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
      'GET /api/projects',
      'GET /api/projects/:id',
      'GET /api/projects/:id/health',
      'GET /api/projects/:id/workspaces',
      'PATCH /api/projects/:id',
      'POST /api/projects',
      'POST /api/projects/:id/workspaces/:leaseId/cleanup',
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

    expect(booted.storage.setVersions['projects']).toBe(1);
    expect(booted.storage.applied.map((entry) => entry.setId)).toEqual([
      // Foundation's numbered set first, then each element's in module
      // topological order (§1.3) — `roster` sits before `projects`, which sits
      // before `runner`.
      'foundation',
      'roster',
      'projects',
      'runner',
    ]);

    const rows = booted.storage.db
      .prepare<[], { module: string; version: number }>(
        'SELECT module, version FROM schema_migrations ORDER BY module',
      )
      .all();
    expect(rows).toEqual([
      { module: 'projects', version: 1 },
      { module: 'roster', version: 1 },
      { module: 'runner', version: 1 },
    ]);
  });

  it('applies nothing on a second boot against the same data root', async () => {
    const first = await bootCore();
    expect(first.storage.applied.length).toBeGreaterThan(0);
    await first.shutdown();
    service = undefined;

    const second = await bootCore();
    expect(second.storage.applied).toEqual([]);
    expect(second.storage.setVersions['projects']).toBe(1);
    expect(
      second.storage.db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM schema_migrations WHERE module = 'projects'",
        )
        .get()?.n,
    ).toBe(1);
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
      restarted.health(created.body.id).conditions.map((condition) => condition.code),
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
