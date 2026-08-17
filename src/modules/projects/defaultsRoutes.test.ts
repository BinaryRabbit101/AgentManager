/**
 * `GET`, `PATCH` and the health payload over real HTTP (projects IMPLEMENTATION
 * M4; DESIGN §5).
 *
 * The two acceptance criteria that are specifically about the API surface —
 * rather than about the service behind it — live here:
 *
 * - "`defaults.permissionElevation` is present in the `GET /api/projects/:id`
 *   payload", *with its reason*, so the UI can warn before a launch;
 * - the write-time refusals arrive as **400s naming the field**, through
 *   foundation's one error shape and never as a stack.
 *
 * Everything runs through `boot()` in `src/main.ts` against a real listener on
 * an ephemeral port, for the same reason M1's module test does: the routes only
 * exist because the module registered them, and that is not observable from a
 * unit test that constructs the routes by hand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, type BootOptions, type BootedService } from '../../main.js';

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

async function send<T>(method: string, path: string, body?: unknown): Promise<Answer<T>> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

interface ProjectBody {
  readonly id: string;
  readonly name: string;
  readonly notes: string;
  readonly workspacePolicy: string;
  readonly defaults: {
    readonly agentIds: string[];
    readonly permissionElevation?: { readonly allow: string[]; readonly reason: string };
    readonly env?: {
      readonly name: string;
      readonly value?: string;
      readonly secretRef?: string;
    }[];
  };
  readonly health: { readonly code: string; readonly message: string }[];
}

/** Registers one project and returns its id. */
async function registerProject(name = 'Billing'): Promise<string> {
  const folder = makeDir(workspaceDir.path, name);
  const created = await send<ProjectBody>('POST', '/api/projects', { localPath: folder });
  expect(created.status).toBe(201);
  return created.body.id;
}

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-projects-routes-');
  workspaceDir = makeTempDir('agentmanager-projects-routes-work-');
  service = undefined;
});

afterEach(async () => {
  await service?.shutdown();
  service = undefined;
  dataRootDir.cleanup();
  workspaceDir.cleanup();
});

describe('GET /api/projects and /api/projects/:id', () => {
  it('returns the full record, defaults included, with derived health', async () => {
    await bootCore();
    const id = await registerProject();

    const patched = await send<ProjectBody>('PATCH', `/api/projects/${id}`, {
      notes: '# Billing\n\nPHP 8.2.',
      workspacePolicy: 'shared',
      defaults: {
        agentIds: ['nobody-here'],
        env: [{ name: 'APP_ENV', value: 'test' }],
        permissionElevation: {
          allow: ['Bash(npm publish*)'],
          reason: 'the release agent publishes the package',
        },
      },
    });
    expect(patched.status).toBe(200);

    const answer = await send<ProjectBody>('GET', `/api/projects/${id}`);
    expect(answer.status).toBe(200);
    expect(answer.body.notes).toContain('PHP 8.2.');
    expect(answer.body.workspacePolicy).toBe('shared');
    // The whole point of §5's sentence about this payload: allow list *and*
    // reason, so the UI can warn before the launch rather than after.
    expect(answer.body.defaults.permissionElevation).toEqual({
      allow: ['Bash(npm publish*)'],
      reason: 'the release agent publishes the package',
    });
    expect(answer.body.defaults.env).toEqual([{ name: 'APP_ENV', value: 'test' }]);
    // `nobody-here` is not in this install's roster — and, unlike a starter
    // agent's id, never will be (roster M10) — so the lazy drop applies
    // and health says so rather than the project becoming unreadable.
    expect(answer.body.defaults.agentIds).toEqual([]);
    expect(answer.body.health.map((condition) => condition.code)).toContain('stale-agents');

    const list = await send<{ projects: ProjectBody[] }>('GET', '/api/projects');
    expect(list.status).toBe(200);
    expect(list.body.projects).toHaveLength(1);
    expect(list.body.projects[0]?.id).toBe(id);
  });

  it('answers an unknown id with a typed 404', async () => {
    await bootCore();
    const answer = await send<{ error: string; message: string }>(
      'GET',
      '/api/projects/01JZZZZZZZZZZZZZZZZZZZZZZZ',
    );
    expect(answer.status).toBe(404);
    expect(answer.body.error).toBe('project_not_found');
    expect(JSON.stringify(answer.body)).not.toContain('    at ');
  });

  it('serves the derived health payload on its own route', async () => {
    await bootCore();
    const id = await registerProject();
    const answer = await send<{ projectId: string; conditions: unknown[] }>(
      'GET',
      `/api/projects/${id}/health`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.projectId).toBe(id);
    expect(answer.body.conditions).toEqual([]);
  });
});

describe('PATCH /api/projects/:id — the write-time refusals', () => {
  it('rejects ANTHROPIC_API_KEY with a 400 citing D2 and naming the field', async () => {
    await bootCore();
    const id = await registerProject();

    const answer = await send<{ error: string; message: string; field: string; envName: string }>(
      'PATCH',
      `/api/projects/${id}`,
      { defaults: { env: [{ name: 'ANTHROPIC_API_KEY', value: 'sk-nope' }] } },
    );

    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('forbidden_env_name');
    expect(answer.body.field).toBe('defaults.env');
    expect(answer.body.envName).toBe('ANTHROPIC_API_KEY');
    expect(answer.body.message).toContain('D2');
    expect(JSON.stringify(answer.body)).not.toContain('    at ');
  });

  it('rejects CLAUDE_CODE_OAUTH_TOKEN the same way', async () => {
    await bootCore();
    const id = await registerProject();
    const answer = await send<{ error: string }>('PATCH', `/api/projects/${id}`, {
      defaults: { env: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'oat-nope' }] },
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('forbidden_env_name');
  });

  it('rejects an elevation with no reason, naming the reason field', async () => {
    await bootCore();
    const id = await registerProject();

    const answer = await send<{ error: string; field: string; message: string }>(
      'PATCH',
      `/api/projects/${id}`,
      { defaults: { permissionElevation: { allow: ['Bash(npm publish*)'] } } },
    );

    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('missing_elevation_reason');
    expect(answer.body.field).toBe('defaults.permissionElevation.reason');

    // And nothing was written: the project still has no elevation.
    const after = await send<ProjectBody>('GET', `/api/projects/${id}`);
    expect(after.body.defaults.permissionElevation).toBeUndefined();
  });

  it('rejects a field that is not patchable here', async () => {
    await bootCore();
    const id = await registerProject();
    const answer = await send<{ error: string; field: string }>('PATCH', `/api/projects/${id}`, {
      localPath: 'C:\\elsewhere',
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('invalid_request');
    expect(answer.body.field).toBe('localPath');
  });
});

describe('GET /api/projects/:id/workspaces', () => {
  it('is empty for a fresh project and 404s for an unknown one', async () => {
    await bootCore();
    const id = await registerProject();

    const answer = await send<{ workspaces: unknown[] }>('GET', `/api/projects/${id}/workspaces`);
    expect(answer.status).toBe(200);
    expect(answer.body.workspaces).toEqual([]);

    const missing = await send<{ error: string }>(
      'GET',
      '/api/projects/01JZZZZZZZZZZZZZZZZZZZZZZZ/workspaces',
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('project_not_found');
  });
});
