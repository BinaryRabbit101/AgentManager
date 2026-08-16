/**
 * The `runner` module through the real composition root (runner IMPLEMENTATION
 * M1's first and fifth criteria, and M2's HTTP half).
 *
 * Everything here goes through `boot()` in `src/main.ts` and a real listener on
 * an ephemeral port, because three of the things under test are only true
 * through that path: the migration *order* comes from the module graph
 * (foundation §1.3), the route table is mounted by the `http` module at
 * `start()` (§6.4), and the service is only reachable if `ctx.provide` ran.
 *
 * Acceptance covered:
 *
 * - "The element migration applies **after foundation's core set**, is
 *   idempotent, and registers under module `runner` in `schema_migrations`";
 * - "The module starts and stops cleanly with no sessions present, and reports
 *   healthy";
 * - M2's "asserted **on the HTTP route**" halves: whole lines and the next
 *   offset, the pruned result rather than a 500, `from`+`tail` together as a 400
 *   naming both, and `?tail=` matching `getTranscriptTail` byte for byte.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, type BootOptions, type BootedService } from '../../main.js';

import { RUNNER_MODULE_ID, RUNNER_SERVICE } from './module.js';
import type { RunnerService } from './service.js';
import type { TranscriptLine } from './transcript.js';
import { makeTempDir, repoRoot, type TempDir } from './__tests__/helpers.js';

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

interface TranscriptAnswer {
  readonly sessionId: string;
  readonly lines: readonly TranscriptLine[];
  readonly from: number;
  readonly next: number;
  readonly size: number;
  readonly pruned: boolean;
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

/** A session with a transcript, created through foundation's own repositories. */
function seedSession(booted: BootedService, lines = 5): string {
  const store = booted.storage.store;
  const project = store.projects.create({ slug: 'fixture', name: 'Fixture' });
  const assignment = store.assignments.create({ projectId: project.id, pattern: 'solo' });
  const session = store.sessions.create({
    assignmentId: assignment.id,
    agentId: 'agent-1',
    projectId: project.id,
    status: 'running',
  });

  const writer = store.transcripts.open(session.id);
  for (let i = 0; i < lines; i += 1) {
    writer.append({ seq: i + 1, type: 'assistant', text: `line-${String(i)}` });
  }
  writer.close();
  return session.id;
}

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-runner-boot-');
  service = undefined;
});

afterEach(async () => {
  await service?.shutdown();
  service = undefined;
  dataRootDir.cleanup();
});

describe('module registration', () => {
  it('joins the module graph after its dependencies and publishes its service', async () => {
    const booted = await bootCore();

    expect(booted.runtime.order).toContain(RUNNER_MODULE_ID);
    const order = booted.runtime.order;
    for (const dependency of ['storage', 'secrets', 'roster', 'projects']) {
      expect(order.indexOf(dependency)).toBeLessThan(order.indexOf(RUNNER_MODULE_ID));
    }

    expect(booted.runtime.registry.require<RunnerService>(RUNNER_SERVICE)).toBeDefined();
  });

  it('applies migrations/runner/ after foundation and records it under "runner"', async () => {
    const booted = await bootCore();

    expect(booted.storage.setVersions[RUNNER_MODULE_ID]).toBe(1);
    const ledger = booted.storage.db
      .prepare<[], { module: string; version: number }>(
        'SELECT module, version FROM schema_migrations',
      )
      .all();
    expect(ledger).toContainEqual({ module: RUNNER_MODULE_ID, version: 1 });

    // The added columns exist, which is only possible if foundation's
    // `0001_init.sql` created `sessions` first.
    const columns = booted.storage.db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('sessions')")
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'role',
        'lease_id',
        'resumed_from',
        'queued_at',
        'priority',
        'weight',
        'blocked_reason',
        'turns',
      ]),
    );
    const usageColumns = booted.storage.db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('usage_events')")
      .all()
      .map((row) => row.name);
    expect(usageColumns).toEqual(expect.arrayContaining(['source', 'message_id', 'run_id']));
  });

  it('is idempotent across a restart', async () => {
    const first = await bootCore();
    expect(first.storage.applied.some((entry) => entry.setId === RUNNER_MODULE_ID)).toBe(true);
    await first.shutdown();
    service = undefined;

    const second = await bootCore();
    expect(second.storage.applied.some((entry) => entry.setId === RUNNER_MODULE_ID)).toBe(false);
    expect(second.storage.setVersions[RUNNER_MODULE_ID]).toBe(1);
    const rows = second.storage.db
      .prepare<[string], { n: number }>(
        'SELECT COUNT(*) AS n FROM schema_migrations WHERE module = ?',
      )
      .get(RUNNER_MODULE_ID);
    expect(rows?.n).toBe(1);
  });

  it('reports healthy with no sessions present, and stops cleanly', async () => {
    const booted = await bootCore();

    const health = await booted.health();
    const runner = health.modules.find((entry) => entry.id === RUNNER_MODULE_ID);
    expect(runner).toMatchObject({ id: RUNNER_MODULE_ID, status: 'ok', critical: false });
    expect(runner?.detail).toMatchObject({
      sessions: { queued: 0, running: 0, paused: 0, done: 0 },
      capacity: 1,
    });
    expect(health.status).toBe('ok');

    await booted.shutdown();
    service = undefined;
    // A second shutdown is the "stops cleanly" half: nothing was left holding a
    // handle, so tearing down twice is a no-op rather than a throw.
    await expect(booted.shutdown()).resolves.toBeUndefined();
  });
});

describe('GET /api/sessions/:id/transcript', () => {
  it('returns whole JSONL lines and the next offset', async () => {
    const booted = await bootCore();
    const sessionId = seedSession(booted, 5);

    const first = await get<TranscriptAnswer>(`/api/sessions/${sessionId}/transcript?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.pruned).toBe(false);
    expect(first.body.lines.map((line) => line['text'])).toEqual(['line-0', 'line-1']);

    const second = await get<TranscriptAnswer>(
      `/api/sessions/${sessionId}/transcript?from=${String(first.body.next)}`,
    );
    expect(second.body.lines).toHaveLength(3);
    expect(second.body.next).toBe(second.body.size);
  });

  it('advances a mid-line from to the next whole line', async () => {
    const booted = await bootCore();
    const sessionId = seedSession(booted, 4);

    const whole = await get<TranscriptAnswer>(`/api/sessions/${sessionId}/transcript?limit=1`);
    const midLine = await get<TranscriptAnswer>(
      `/api/sessions/${sessionId}/transcript?from=${String(whole.body.next + 5)}&limit=1`,
    );
    expect(midLine.status).toBe(200);
    expect(midLine.body.lines).toHaveLength(1);
    expect(midLine.body.lines[0]?.['text']).toBe('line-2');
  });

  it('answers 200 with pruned rather than 500 for a NULLed transcript_path', async () => {
    const booted = await bootCore();
    const sessionId = seedSession(booted, 3);
    booted.storage.store.sessions.clearTranscript(sessionId);

    for (const query of ['', '?from=120', '?tail=4096']) {
      const answer = await get<TranscriptAnswer>(`/api/sessions/${sessionId}/transcript${query}`);
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ pruned: true, lines: [] });
    }
  });

  it('serves tail= identically to the in-process getTranscriptTail', async () => {
    const booted = await bootCore();
    const sessionId = seedSession(booted, 30);

    const overHttp = await get<TranscriptAnswer>(`/api/sessions/${sessionId}/transcript?tail=300`);
    const inProcess = await booted.runtime.registry
      .require<RunnerService>(RUNNER_SERVICE)
      ?.getTranscriptTail(sessionId, { maxBytes: 300 });

    expect(overHttp.body.lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(overHttp.body.lines)).toBe(JSON.stringify(inProcess?.lines));
    expect(overHttp.body.from).toBe(inProcess?.from);
    expect(overHttp.body.next).toBe(inProcess?.next);
  });

  it('refuses from and tail together with a 400 naming both', async () => {
    const booted = await bootCore();
    const sessionId = seedSession(booted, 2);

    const answer = await get<{ error: string; message: string; fields: string[] }>(
      `/api/sessions/${sessionId}/transcript?from=0&tail=100`,
    );
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('invalid_request');
    expect(answer.body.message).toContain('"from"');
    expect(answer.body.message).toContain('"tail"');
    expect(answer.body.fields).toEqual(['from', 'tail']);
  });

  it('refuses a negative offset and answers 404 for an unknown session', async () => {
    const booted = await bootCore();
    seedSession(booted, 1);

    const bad = await get<{ error: string }>('/api/sessions/x/transcript?from=-1');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_request');

    const missing = await get<{ error: string; message: string }>(
      '/api/sessions/no-such-session/transcript',
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('session_not_found');
    expect(missing.body.message).not.toContain('at ');
  });
});
