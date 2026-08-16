/**
 * Writing per-project settings (projects IMPLEMENTATION M4).
 *
 * The acceptance criteria this file owns:
 *
 * - "`permissionElevation` with an empty or missing `reason` is rejected at
 *   write time with a 400 naming the field";
 * - "`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` as a project env name is
 *   rejected at write time with a message citing D2";
 * - "Env entries come back in projects' declared order" — the storage half; the
 *   roster-merge half is in `rosterHandoff.test.ts`;
 * - "`defaults.permissionElevation` is present in the `GET /api/projects/:id`
 *   payload" — the record half; the HTTP half is in `defaultsRoutes.test.ts`.
 *
 * Everything here goes through the service (and therefore the real repository
 * and a real SQLite file), because a validator that is only ever called by a
 * unit test is not the thing a `PATCH` will hit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ForbiddenEnvNameError,
  InvalidRequestError,
  MissingElevationReasonError,
  ProjectNotFoundError,
} from './errors.js';
import type { ProjectsError } from './errors.js';
import {
  fakeGit,
  makeDir,
  makeHarness,
  makeTempDir,
  type TempDir,
  type TestHarness,
} from './__tests__/helpers.js';
import type { Project } from './types.js';

let dataRootDir: TempDir;
let workspaceDir: TempDir;
let harness: TestHarness | undefined;

async function bootWithProject(
  options: { readonly allowPermissionElevation?: boolean } = {},
): Promise<{ harness: TestHarness; project: Project }> {
  harness = makeHarness({
    dataRoot: dataRootDir.path,
    git: fakeGit({}),
    ...(options.allowPermissionElevation === undefined
      ? {}
      : { allowPermissionElevation: options.allowPermissionElevation }),
  });
  const folder = makeDir(workspaceDir.path, 'billing');
  const project = await harness.service.create({ localPath: folder });
  return { harness, project };
}

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-projects-settings-');
  workspaceDir = makeTempDir('agentmanager-projects-settings-work-');
  harness = undefined;
});

afterEach(() => {
  harness?.storage.close();
  dataRootDir.cleanup();
  workspaceDir.cleanup();
});

describe('environment entries (§1.4, D2)', () => {
  it('refuses ANTHROPIC_API_KEY with a message citing D2', async () => {
    const { harness: h, project } = await bootWithProject();

    let thrown: unknown;
    try {
      h.service.update(project.id, {
        defaults: { env: [{ name: 'ANTHROPIC_API_KEY', value: 'sk-nope' }] },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenEnvNameError);
    const error = thrown as ForbiddenEnvNameError;
    expect(error.status).toBe(400);
    expect(error.code).toBe('forbidden_env_name');
    expect(error.message).toContain('D2');
    expect(error.details['field']).toBe('defaults.env');
  });

  it('refuses CLAUDE_CODE_OAUTH_TOKEN, and under any casing', async () => {
    const { harness: h, project } = await bootWithProject();

    expect(() =>
      h.service.update(project.id, {
        defaults: { env: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', secretRef: 'claude.oauthToken' }] },
      }),
    ).toThrow(ForbiddenEnvNameError);

    expect(() =>
      h.service.update(project.id, {
        defaults: { env: [{ name: 'Anthropic_Api_Key', value: 'sk-nope' }] },
      }),
    ).toThrow(ForbiddenEnvNameError);
  });

  it('stores entries in the declared order and leaves a secretRef a ref', async () => {
    const { harness: h, project } = await bootWithProject();

    const updated = h.service.update(project.id, {
      defaults: {
        env: [
          { name: 'APP_ENV', value: 'test' },
          { name: 'DB_PASSWORD', secretRef: `project.${project.id}.dbPassword` },
          { name: 'FEATURE_FLAGS', value: 'billing' },
        ],
      },
    });

    expect(updated.defaults.env?.map((entry) => entry.name)).toEqual([
      'APP_ENV',
      'DB_PASSWORD',
      'FEATURE_FLAGS',
    ]);
    // Re-read from SQLite, not from the object the write returned.
    const reread = h.repository.get(project.id);
    expect(reread?.defaults.env?.[1]).toEqual({
      name: 'DB_PASSWORD',
      secretRef: `project.${project.id}.dbPassword`,
    });
    expect(JSON.stringify(reread?.defaults.env)).not.toContain('hunter2');
  });

  it('refuses an entry that carries neither a value nor a secretRef', async () => {
    const { harness: h, project } = await bootWithProject();
    expect(() => h.service.update(project.id, { defaults: { env: [{ name: 'X' }] } })).toThrow(
      InvalidRequestError,
    );
  });
});

describe('permissionElevation (§1.2)', () => {
  it('refuses a missing reason with a 400 naming the field', async () => {
    const { harness: h, project } = await bootWithProject();

    let thrown: unknown;
    try {
      h.service.update(project.id, {
        defaults: { permissionElevation: { allow: ['Bash(git push*)'] } },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MissingElevationReasonError);
    const error = thrown as ProjectsError;
    expect(error.status).toBe(400);
    expect(error.details['field']).toBe('defaults.permissionElevation.reason');
  });

  it('refuses a blank reason too', async () => {
    const { harness: h, project } = await bootWithProject();
    expect(() =>
      h.service.update(project.id, {
        defaults: { permissionElevation: { allow: ['Bash(git push*)'], reason: '   ' } },
      }),
    ).toThrow(MissingElevationReasonError);
  });

  it('stores an elevation with its reason and returns it on the record', async () => {
    const { harness: h, project } = await bootWithProject();

    const updated = h.service.update(project.id, {
      defaults: {
        permissionElevation: {
          allow: ['Bash(git push*)'],
          reason: 'release branch is pushed by the release agent',
        },
      },
    });

    expect(updated.defaults.permissionElevation).toEqual({
      allow: ['Bash(git push*)'],
      reason: 'release branch is pushed by the release agent',
    });
    expect(h.repository.get(project.id)?.defaults.permissionElevation?.reason).toContain('release');
  });

  it('reports elevation-refused in health when policy.allowPermissionElevation is false', async () => {
    const { harness: h, project } = await bootWithProject({ allowPermissionElevation: false });
    h.service.update(project.id, {
      defaults: { permissionElevation: { allow: ['Bash(git push*)'], reason: 'because' } },
    });

    const codes = h.service.health(project.id).conditions.map((condition) => condition.code);
    expect(codes).toContain('elevation-refused');
  });

  it('raises no elevation condition when the policy allows it', async () => {
    const { harness: h, project } = await bootWithProject({ allowPermissionElevation: true });
    h.service.update(project.id, {
      defaults: { permissionElevation: { allow: ['Bash(git push*)'], reason: 'because' } },
    });

    expect(h.service.health(project.id).conditions).toEqual([]);
  });
});

describe('permission override (§1.3 — stored, never composed)', () => {
  it('stores allow / deny / ask / mode verbatim', async () => {
    const { harness: h, project } = await bootWithProject();

    const updated = h.service.update(project.id, {
      defaults: {
        permissions: {
          allow: ['Edit'],
          deny: ['Bash(git push*)'],
          ask: ['WebFetch'],
          mode: 'default',
        },
      },
    });

    expect(updated.defaults.permissions).toEqual({
      allow: ['Edit'],
      deny: ['Bash(git push*)'],
      ask: ['WebFetch'],
      mode: 'default',
    });
  });

  it('accepts a mode this element does not know, because roster ranks modes', async () => {
    const { harness: h, project } = await bootWithProject();
    const updated = h.service.update(project.id, {
      defaults: { permissions: { mode: 'somethingNewInTheSdk' } },
    });
    expect(updated.defaults.permissions?.mode).toBe('somethingNewInTheSdk');
  });

  it('refuses a key outside roster’s four', async () => {
    const { harness: h, project } = await bootWithProject();
    expect(() =>
      h.service.update(project.id, { defaults: { permissions: { allowAll: true } } }),
    ).toThrow(InvalidRequestError);
  });
});

describe('the patch itself', () => {
  it('leaves untouched defaults alone and clears a key sent as null', async () => {
    const { harness: h, project } = await bootWithProject();

    h.service.update(project.id, {
      defaults: {
        agentIds: ['priya-bugfix'],
        env: [{ name: 'APP_ENV', value: 'test' }],
        setupCommand: 'npm ci',
      },
    });
    const afterNotes = h.service.update(project.id, { notes: '# Brief' });
    expect(afterNotes.defaults.env).toHaveLength(1);
    expect(afterNotes.defaults.setupCommand).toBe('npm ci');
    expect(afterNotes.defaults.agentIds).toEqual(['priya-bugfix']);

    const cleared = h.service.update(project.id, { defaults: { setupCommand: null } });
    expect(cleared.defaults.setupCommand).toBeUndefined();
    expect(cleared.defaults.env).toHaveLength(1);
  });

  it('writes nothing when one field of the patch is invalid', async () => {
    const { harness: h, project } = await bootWithProject();

    expect(() =>
      h.service.update(project.id, {
        notes: '# should not survive',
        defaults: { env: [{ name: 'ANTHROPIC_API_KEY', value: 'sk-nope' }] },
      }),
    ).toThrow(ForbiddenEnvNameError);

    expect(h.repository.get(project.id)?.notes).toBe('');
  });

  it('refuses an instructionsPath that escapes the project folder', async () => {
    const { harness: h, project } = await bootWithProject();
    expect(() =>
      h.service.update(project.id, { defaults: { instructionsPath: '../secrets.md' } }),
    ).toThrow(InvalidRequestError);
    expect(() =>
      h.service.update(project.id, {
        defaults: { instructionsPath: 'C:\\Users\\owner\\.ssh\\id_rsa' },
      }),
    ).toThrow(InvalidRequestError);
  });

  it('refuses a field that is not patchable, and an unknown project', async () => {
    const { harness: h, project } = await bootWithProject();
    expect(() => h.service.update(project.id, { localPath: 'C:\\elsewhere' })).toThrow(
      InvalidRequestError,
    );
    expect(() => h.service.update('01JZZZZZZZZZZZZZZZZZZZZZZZ', { notes: 'x' })).toThrow(
      ProjectNotFoundError,
    );
  });

  it('emits a persisted project.updated event naming the fields, never the values', async () => {
    const { harness: h, project } = await bootWithProject();
    h.service.update(project.id, {
      defaults: { env: [{ name: 'DB_PASSWORD', secretRef: 'project.x.dbPassword' }] },
    });

    const updated = h.events.filter((event) => event.type === 'project.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]?.persist).toBe(true);
    expect(updated[0]?.payload).toMatchObject({ fields: ['defaults'] });
    expect(JSON.stringify(updated[0]?.payload)).not.toContain('dbPassword');
  });
});

describe('default agents (§1.2 — lazy drop)', () => {
  it('drops ids the roster no longer knows and reports them in health', async () => {
    const known = new Set(['priya-bugfix', 'marcus-review']);
    harness = makeHarness({
      dataRoot: dataRootDir.path,
      git: fakeGit({}),
      knownAgent: (agentId) => known.has(agentId),
    });
    const folder = makeDir(workspaceDir.path, 'billing');
    const project = await harness.service.create({ localPath: folder });

    harness.service.update(project.id, {
      defaults: { agentIds: ['priya-bugfix', 'gone-agent', 'marcus-review'] },
    });

    // The project stays readable; the dangling id is simply not in the list.
    const reread = harness.service.get(project.id);
    expect(reread.defaults.agentIds).toEqual(['priya-bugfix', 'marcus-review']);

    const stale = harness.service
      .health(project.id)
      .conditions.find((condition) => condition.code === 'stale-agents');
    expect(stale?.detail?.['agentIds']).toEqual(['gone-agent']);
    expect(stale?.message).toContain('gone-agent');

    // And the ordering of the survivors is the one that was written.
    expect(harness.repository.defaultAgents(project.id)).toEqual(['priya-bugfix', 'marcus-review']);
  });

  it('keeps the whole list when every id is still known', async () => {
    const { harness: h, project } = await bootWithProject();
    h.service.update(project.id, { defaults: { agentIds: ['a', 'b', 'c'] } });
    expect(h.service.get(project.id).defaults.agentIds).toEqual(['a', 'b', 'c']);
    expect(h.repository.danglingDefaultAgents(project.id)).toEqual([]);
  });
});
