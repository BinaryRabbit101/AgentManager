/**
 * The `roster` module through the real composition root (roster IMPLEMENTATION
 * M2 and M3).
 *
 * Everything here goes through `boot()` in `src/main.ts` and a real listener on
 * an ephemeral port. That is the point: registering the module is what makes
 * foundation apply `migrations/roster/`, mount the routes, publish the service
 * and hand roster the library root it is configured with — none of which is
 * observable from a unit test that constructs the module by hand.
 *
 * Acceptance covered here:
 * - the first-run library bootstrap, against the directory foundation's own
 *   data-root bootstrap leaves behind (M2);
 * - "Create → read → patch → duplicate → delete exercised end-to-end" over HTTP,
 *   with the status codes and the typed error bodies (M3);
 * - "a reordered list survives a restart and re-reads identically from
 *   `GET /agents`" (M3);
 * - the avatar upload, its two refusals, and the survival of the previous image;
 * - "API responses never contain a resolved secret value (asserted by a test
 *   that plants one)" — the secret is planted in foundation's real secret store;
 * - the watcher, wired through `library.watch`, reflecting an external edit.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, type BootOptions, type BootedService } from '../../main.js';

import { ROSTER_MODULE_ID, ROSTER_SERVICE } from './module.js';
import type { AgentView, RosterListView, RosterService } from './service.js';
import { TINY_PNG, makeSpacedTempDir, repoRoot, wait, type TempDir } from './__tests__/helpers.js';
import { loadFixture } from './__tests__/fixtures.js';
import { serialiseAgentDefinition } from './parse.js';

let dataRootDir: TempDir;
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
  readonly headers: Headers;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<Answer<T>> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  return {
    status: response.status,
    body: (await response.json()) as T,
    headers: response.headers,
  };
}

async function putBytes<T>(path: string, bytes: Buffer, contentType: string): Promise<Answer<T>> {
  const response = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(bytes),
  });
  return {
    status: response.status,
    body: (await response.json()) as T,
    headers: response.headers,
  };
}

const get = <T>(path: string): Promise<Answer<T>> => call<T>('GET', path);

beforeEach(() => {
  // A data root whose path contains a space, so every boot exercises M2's
  // Windows path requirement rather than a separate test doing it once.
  dataRootDir = makeSpacedTempDir('agentmanager roster boot ');
  service = undefined;
});

afterEach(async () => {
  await service?.shutdown();
  service = undefined;
  dataRootDir.cleanup();
});

describe('module registration', () => {
  it('joins the module graph and publishes its service', async () => {
    const booted = await bootCore();

    expect(booted.runtime.order).toContain(ROSTER_MODULE_ID);
    expect(booted.runtime.order.indexOf('storage')).toBeLessThan(
      booted.runtime.order.indexOf(ROSTER_MODULE_ID),
    );
    expect(booted.runtime.registry.require<RosterService>(ROSTER_SERVICE)).toBeDefined();
  });

  it('registers exactly the M3 route surface, all reachable remotely', async () => {
    const booted = await bootCore();
    const mine = booted.runtime.routes.routes.filter(
      (route) => route.moduleId === ROSTER_MODULE_ID,
    );

    expect(mine.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/roster/agents/:id',
      'DELETE /api/roster/agents/:id/avatar',
      'GET /api/roster/agents',
      'GET /api/roster/agents/:id',
      'GET /api/roster/agents/:id/avatar',
      'PATCH /api/roster/agents/:id',
      'PATCH /api/roster/agents/:id/ui-state',
      'POST /api/roster/agents',
      'POST /api/roster/agents/:id/duplicate',
      'PUT /api/roster/agents/:id/avatar',
      'PUT /api/roster/board-order',
    ]);
    // The endpoints of later milestones are absent rather than stubbed.
    expect(mine.some((route) => route.path.includes('draft'))).toBe(false);
    expect(mine.some((route) => route.path.includes('import'))).toBe(false);
    expect(mine.every((route) => route.remote === 'allow')).toBe(true);
  });

  it('applies its element migration under module "roster", once', async () => {
    const first = await bootCore();
    expect(first.storage.setVersions['roster']).toBe(1);
    expect(first.storage.applied.map((entry) => entry.setId)).toContain('roster');
    await first.shutdown();
    service = undefined;

    const second = await bootCore();
    expect(second.storage.applied).toEqual([]);
    expect(
      second.storage.db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM schema_migrations WHERE module = 'roster'",
        )
        .get()?.n,
    ).toBe(1);
  });

  it('reports healthy, with the agent count and the library root', async () => {
    const booted = await bootCore();
    const health = await booted.health();
    const mine = health.modules.find((module) => module.id === ROSTER_MODULE_ID);

    expect(mine?.status).toBe('ok');
    expect(mine?.detail).toMatchObject({ agents: 0, archived: 0, watching: true });
  });
});

describe('library bootstrap through boot (M2)', () => {
  it('turns the directory foundation created into a roster library', async () => {
    const booted = await bootCore();
    const library = booted.paths.library;

    expect(existsSync(join(library, 'roster.json'))).toBe(true);
    expect(existsSync(join(library, '.gitignore'))).toBe(true);
    expect(statSync(join(library, 'agents')).isDirectory()).toBe(true);
    expect(library).toContain(' ');
  });

  it('changes nothing on the second boot', async () => {
    const first = await bootCore();
    const library = first.paths.library;
    const before = readFileSync(join(library, 'roster.json'), 'utf8');
    const stamp = statSync(join(library, 'roster.json')).mtimeMs;
    await first.shutdown();
    service = undefined;

    await bootCore();
    expect(readFileSync(join(library, 'roster.json'), 'utf8')).toBe(before);
    expect(statSync(join(library, 'roster.json')).mtimeMs).toBe(stamp);
  });

  it('honours a relocated library.root', async () => {
    const elsewhere = join(dataRootDir.path, 'a different place');
    mkdirSync(elsewhere, { recursive: true });
    const booted = await bootCore({ argv: ['--set', `library.root=${elsewhere}`] });

    expect(booted.paths.library).toBe(elsewhere);
    expect(existsSync(join(elsewhere, 'agents'))).toBe(true);
  });
});

describe('the CRUD flow over HTTP (M3)', () => {
  it('creates, reads, patches, duplicates and deletes', async () => {
    await bootCore();

    const created = await call<AgentView>('POST', '/api/roster/agents', {
      name: 'Priya Bugfix',
      specialty: 'bug-patching',
      tagline: 'Reproduces first, then fixes.',
      personaText: '# Priya\n\nReproduce first.\n',
    });
    expect(created.status).toBe(201);
    expect(created.body.definition.id).toBe('priya-bugfix');
    expect(created.headers.get('location')).toBe('/api/roster/agents/priya-bugfix');

    const read = await get<AgentView>('/api/roster/agents/priya-bugfix');
    expect(read.status).toBe(200);
    expect(read.body.persona).toContain('Reproduce first.');

    const patched = await call<AgentView>('PATCH', '/api/roster/agents/priya-bugfix', {
      tags: ['backend', 'php'],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.definition.tags).toEqual(['backend', 'php']);

    const clone = await call<AgentView>('POST', '/api/roster/agents/priya-bugfix/duplicate', {
      name: 'Priya Reviews',
    });
    expect(clone.status).toBe(201);
    expect(clone.body.definition.id).toBe('priya-reviews');
    expect(clone.body.definition.meta.duplicatedFrom).toBe('priya-bugfix');
    expect(clone.body.persona).toContain('Reproduce first.');

    const listed = await get<RosterListView>('/api/roster/agents');
    expect(listed.body.agents.map((agent) => agent.definition.id)).toEqual([
      'priya-bugfix',
      'priya-reviews',
    ]);

    const deleted = await call<{ archivedAt: string; purged: boolean }>(
      'DELETE',
      '/api/roster/agents/priya-bugfix',
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.purged).toBe(false);

    const after = await get<RosterListView>('/api/roster/agents');
    expect(after.body.agents.map((agent) => agent.definition.id)).toEqual(['priya-reviews']);
    // Still readable by id, for display (§9.3).
    const archived = await get<AgentView>('/api/roster/agents/priya-bugfix');
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).not.toBeNull();
  });

  it('answers a PATCH that would change the id with a typed 400, not a stack', async () => {
    await bootCore();
    await call('POST', '/api/roster/agents', { name: 'Priya', specialty: 'general' });

    const answer = await call<{ error: string; message: string; fields: string[] }>(
      'PATCH',
      '/api/roster/agents/priya',
      { id: 'priya-renamed' },
    );

    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('immutable_field');
    expect(answer.body.fields).toEqual(['id']);
    expect(JSON.stringify(answer.body)).not.toContain('    at ');
  });

  it('answers an invalid definition with the offending field paths', async () => {
    await bootCore();
    const answer = await call<{ error: string; issues: { path: string }[] }>(
      'POST',
      '/api/roster/agents',
      { name: 'Bad', specialty: 'general', permissions: { mode: 'bypassPermissions' } },
    );

    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('invalid_definition');
    expect(answer.body.issues.map((issue) => issue.path)).toContain('permissions.mode');
  });

  it('answers an unknown agent with 404', async () => {
    await bootCore();
    const answer = await call<{ error: string }>('GET', '/api/roster/agents/nobody');
    expect(answer.status).toBe(404);
    expect(answer.body.error).toBe('agent_not_found');
  });
});

describe('the board order (§9.5)', () => {
  it('survives a restart and re-reads identically', async () => {
    const first = await bootCore();
    for (const name of ['Ada', 'Grace', 'Linus']) {
      await call('POST', '/api/roster/agents', { name, specialty: 'general' });
    }
    const reordered = await call<RosterListView>('PUT', '/api/roster/board-order', {
      order: ['linus', 'ada', 'grace'],
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.agents.map((agent) => agent.definition.id)).toEqual([
      'linus',
      'ada',
      'grace',
    ]);
    await first.shutdown();
    service = undefined;

    await bootCore();
    const listed = await get<RosterListView>('/api/roster/agents');
    expect(listed.body.agents.map((agent) => agent.definition.id)).toEqual([
      'linus',
      'ada',
      'grace',
    ]);
  });

  it('replays the same body as a no-op and refuses an unknown id, order intact', async () => {
    await bootCore();
    for (const name of ['Ada', 'Grace']) {
      await call('POST', '/api/roster/agents', { name, specialty: 'general' });
    }
    await call('PUT', '/api/roster/board-order', { order: ['grace', 'ada'] });
    const replay = await call<RosterListView>('PUT', '/api/roster/board-order', {
      order: ['grace', 'ada'],
    });
    expect(replay.body.agents.map((agent) => agent.definition.id)).toEqual(['grace', 'ada']);

    const refused = await call<{ error: string; unknownIds: string[] }>(
      'PUT',
      '/api/roster/board-order',
      { order: ['ada', 'nobody'] },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('unknown_agent_id');
    expect(refused.body.unknownIds).toEqual(['nobody']);

    const listed = await get<RosterListView>('/api/roster/agents');
    expect(listed.body.agents.map((agent) => agent.definition.id)).toEqual(['grace', 'ada']);
  });

  it('pins through PATCH /ui-state without touching agent.json', async () => {
    const booted = await bootCore();
    await call('POST', '/api/roster/agents', { name: 'Ada', specialty: 'general' });
    const path = join(booted.paths.library, 'agents', 'ada', 'agent.json');
    const before = readFileSync(path, 'utf8');

    const answer = await call<AgentView>('PATCH', '/api/roster/agents/ada/ui-state', {
      pinned: true,
    });
    expect(answer.status).toBe(200);
    expect(answer.body.uiState.pinned).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

describe('avatars over HTTP (§9.5)', () => {
  it('uploads, serves, refuses and preserves', async () => {
    const booted = await bootCore();
    await call('POST', '/api/roster/agents', {
      name: 'Ada',
      specialty: 'general',
      avatar: { kind: 'emoji', value: '🐛' },
    });

    // Before any upload: a generated placeholder, never a 404 (§3.2).
    const placeholder = await fetch(`${base}/api/roster/agents/ada/avatar`);
    expect(placeholder.status).toBe(200);
    expect(placeholder.headers.get('content-type')).toContain('image/svg+xml');

    const uploaded = await putBytes<AgentView>(
      '/api/roster/agents/ada/avatar',
      TINY_PNG,
      'image/png',
    );
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.definition.avatar).toEqual({ kind: 'file', value: 'avatar.png' });
    expect(existsSync(join(booted.paths.library, 'agents', 'ada', 'avatar.png'))).toBe(true);

    const served = await fetch(`${base}/api/roster/agents/ada/avatar`);
    expect(served.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await served.arrayBuffer()).equals(TINY_PNG)).toBe(true);

    const notAnImage = await putBytes<{ error: string }>(
      '/api/roster/agents/ada/avatar',
      Buffer.from('#!/bin/sh\n'),
      'image/png',
    );
    expect(notAnImage.status).toBe(415);
    expect(notAnImage.body.error).toBe('avatar_not_an_image');

    const oversize = await putBytes<{ error: string }>(
      '/api/roster/agents/ada/avatar',
      Buffer.concat([TINY_PNG, Buffer.alloc(600 * 1024)]),
      'image/png',
    );
    expect(oversize.status).toBe(413);
    expect(oversize.body.error).toBe('avatar_too_large');

    // Both refusals left the previous image exactly where it was.
    const again = await fetch(`${base}/api/roster/agents/ada/avatar`);
    expect(Buffer.from(await again.arrayBuffer()).equals(TINY_PNG)).toBe(true);
  });
});

describe('secrets (§10)', () => {
  it('never returns a resolved secret value, only the ref', async () => {
    // Planted in foundation's real secret store, under the exact ref the fixture
    // names, and proven resolvable below. Nothing in M2/M3 resolves it — the
    // point is that a response cannot carry the value even when the value is
    // there to be had.
    const booted = await bootCore({
      env: { AGENTMANAGER_SECRET_mcp__gmail__token: 'ya29.PLANTED-SECRET-VALUE' },
    });
    expect((await booted.secrets.get('mcp.gmail.token'))?.reveal()).toBe(
      'ya29.PLANTED-SECRET-VALUE',
    );

    const definition = loadFixture('email-responder');
    const dir = join(booted.paths.library, 'agents', definition.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.json'), serialiseAgentDefinition(definition), 'utf8');
    writeFileSync(join(dir, 'persona.md'), 'Answer the mail.', 'utf8');
    booted.runtime.registry.require<RosterService>(ROSTER_SERVICE)?.reload();

    const one = await get<AgentView>(`/api/roster/agents/${definition.id}`);
    const all = await get<RosterListView>('/api/roster/agents');

    expect(JSON.stringify(one.body)).toContain('mcp.gmail.token');
    expect(JSON.stringify(one.body)).not.toContain('PLANTED-SECRET-VALUE');
    expect(JSON.stringify(all.body)).not.toContain('PLANTED-SECRET-VALUE');
  });
});

describe('the watcher, wired through library.watch', () => {
  it('reflects an external persona edit without a restart', async () => {
    const booted = await bootCore();
    await call('POST', '/api/roster/agents', {
      name: 'Ada',
      specialty: 'general',
      personaText: 'before',
    });
    const persona = join(booted.paths.library, 'agents', 'ada', 'persona.md');

    writeFileSync(persona, 'edited by hand', 'utf8');

    const deadline = Date.now() + 3000;
    let view = await get<AgentView>('/api/roster/agents/ada');
    while (view.body.persona !== 'edited by hand' && Date.now() < deadline) {
      await wait(50);
      view = await get<AgentView>('/api/roster/agents/ada');
    }
    expect(view.body.persona).toBe('edited by hand');

    // The change is on the audit trail, not only in memory (§6.5, §9.1).
    const events = booted.storage.store.events.list({ types: ['roster.changed'] });
    expect(events.length).toBeGreaterThan(0);
  });

  it('does not watch when library.watch is off', async () => {
    const booted = await bootCore({ argv: ['--set', 'library.watch=false'] });
    const health = await booted.health();
    expect(health.modules.find((module) => module.id === ROSTER_MODULE_ID)?.detail).toMatchObject({
      watching: false,
    });
  });
});
