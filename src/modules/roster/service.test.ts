/**
 * `RosterService` — CRUD, duplicate, archive and the board (roster DESIGN §9,
 * IMPLEMENTATION M3).
 *
 * Acceptance covered here:
 * - "Create → read → patch → duplicate → delete exercised end-to-end against a
 *   temp data dir";
 * - "`POST /agents` with a name and no id mints a slug; a colliding name yields
 *   `-2`, not an error";
 * - "`PATCH` attempting to change `id` is a 400";
 * - "Duplicate produces a folder containing persona, roles, skills, and avatar;
 *   `meta.duplicatedFrom` is set; `secretRef`s are carried; the source is
 *   untouched";
 * - "`DELETE` moves the folder under `.archive/` and the id disappears from
 *   `GET /agents`; the archived definition is still readable by id";
 * - the purge guard of §9.3;
 * - "`roster.changed` fires for API mutations **and** for an external file
 *   edit";
 * - "`PUT /agents/:id/avatar` … an oversize or non-image upload is refused and
 *   the previous avatar survives";
 * - "API responses never contain a resolved secret value".
 *
 * The HTTP status codes these refusals carry are asserted through the real
 * router in `module.test.ts`; here the typed errors are asserted directly, which
 * is the same claim without a socket.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppEvent } from '../types.js';

import { loadFixture } from './__tests__/fixtures.js';
import {
  TINY_PNG,
  makeHarness,
  makeTempDir,
  writeFixtureAgent,
  type Harness,
  type TempDir,
} from './__tests__/helpers.js';
import { bootstrapLibrary } from './bootstrap.js';
import { readAvatarUpload } from './avatar.js';
import { RosterValidationError } from './errors.js';
import type { RosterService } from './service.js';
import {
  AgentIdTakenError,
  AgentNotFoundError,
  ImmutableFieldError,
  PurgeBlockedError,
  UnknownBoardOrderIdError,
} from './serviceErrors.js';

let temp: TempDir;
let harness: Harness;
let service: RosterService;

function rosterEvents(): AppEvent[] {
  return harness.events.filter((event) => event.type === 'roster.changed');
}

function agentPath(id: string, ...rest: string[]): string {
  return join(harness.libraryRoot, 'agents', id, ...rest);
}

/** The offending field paths of a rejected write — what a 400 body carries. */
function issuesOf(operation: () => unknown): string[] {
  try {
    operation();
  } catch (error) {
    if (error instanceof RosterValidationError) return error.issues.map((issue) => issue.path);
    throw error;
  }
  throw new Error('expected the write to be rejected');
}

beforeEach(() => {
  temp = makeTempDir('agentmanager-roster-service-');
  harness = makeHarness({ dataRoot: temp.path });
  bootstrapLibrary({ root: harness.libraryRoot, initGit: false });
  service = harness.service;
  service.load();
  harness.events.length = 0;
});

afterEach(() => {
  harness.close();
  temp.cleanup();
});

describe('create (§9.1)', () => {
  it('mints a slug from the name, writes the folder, and returns the definition', () => {
    const view = service.create({
      name: 'Priya Bugfix',
      specialty: 'bug-patching',
      tagline: 'Reproduces first, then fixes.',
      personaText: '# Priya\n\nReproduce first.\n',
    });

    expect(view.definition.id).toBe('priya-bugfix');
    expect(view.definition.meta.origin).toBe('manual');
    expect(view.persona).toBe('# Priya\n\nReproduce first.\n');
    expect(readFileSync(agentPath('priya-bugfix', 'agent.json'), 'utf8')).toContain('priya-bugfix');
    expect(readFileSync(agentPath('priya-bugfix', 'persona.md'), 'utf8')).toContain('Reproduce');
    expect(existsSync(agentPath('priya-bugfix', '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(service.list().agents.map((agent) => agent.definition.id)).toEqual(['priya-bugfix']);
  });

  it('suffixes a colliding name with -2 rather than failing', () => {
    const first = service.create({ name: 'Priya', specialty: 'bug-patching' });
    const second = service.create({ name: 'Priya', specialty: 'bug-patching' });
    const third = service.create({ name: 'Priya', specialty: 'bug-patching' });

    expect([first, second, third].map((view) => view.definition.id)).toEqual([
      'priya',
      'priya-2',
      'priya-3',
    ]);
  });

  it('will not reuse the id of an archived agent (§9.3)', () => {
    service.create({ name: 'Priya', specialty: 'bug-patching' });
    service.remove('priya');

    expect(service.create({ name: 'Priya', specialty: 'bug-patching' }).definition.id).toBe(
      'priya-2',
    );
  });

  it('refuses an explicit id that is already taken', () => {
    service.create({ name: 'Priya', specialty: 'bug-patching' });
    expect(() =>
      service.create({ id: 'priya', name: 'Someone Else', specialty: 'general' }),
    ).toThrowError(AgentIdTakenError);
  });

  it('refuses an explicit id that is reserved, naming the reason', () => {
    expect(() => service.create({ id: 'nul', name: 'Nul', specialty: 'general' })).toThrowError(
      /reserved/,
    );
  });

  it('rejects an invalid definition with the offending path, not a stack', () => {
    expect(issuesOf(() => service.create({ name: 'Bad', specialty: 'not-a-specialty' }))).toContain(
      'specialty',
    );
  });

  it('rejects an unknown top-level key rather than dropping it (§3)', () => {
    expect(
      issuesOf(() =>
        service.create({ name: 'Bad', specialty: 'general', favouriteColour: 'blue' }),
      ),
    ).toContain('favouriteColour');
  });
});

describe('read, patch (§9.1)', () => {
  beforeEach(() => {
    service.create({
      name: 'Priya',
      specialty: 'bug-patching',
      tagline: 'Reproduces first.',
      personaText: 'first persona',
    });
  });

  it('serves the definition and the resolved persona from memory', () => {
    const view = service.get('priya');
    expect(view.definition.name).toBe('Priya');
    expect(view.persona).toBe('first persona');
    expect(view.uiState.boardOrder).toBe(0);
    expect(view.avatarUrl).toBe('/api/roster/agents/priya/avatar');
  });

  it('updates named fields, leaves the rest, and rewrites persona.md when asked', () => {
    const patched = service.patch('priya', {
      tagline: 'Writes the failing test first.',
      personaText: 'second persona',
    });

    expect(patched.definition.tagline).toBe('Writes the failing test first.');
    expect(patched.definition.name).toBe('Priya');
    expect(patched.persona).toBe('second persona');
    expect(readFileSync(agentPath('priya', 'persona.md'), 'utf8')).toBe('second persona');
  });

  it('clears an optional field when it is patched to null', () => {
    expect(service.patch('priya', { tagline: null }).definition.tagline).toBeUndefined();
  });

  it('refuses to change the id', () => {
    expect(() => service.patch('priya', { id: 'priya-renamed' })).toThrowError(ImmutableFieldError);
    expect(service.get('priya').definition.id).toBe('priya');
  });

  it('refuses to change meta.createdAt', () => {
    expect(() =>
      service.patch('priya', { meta: { createdAt: '2020-01-01T00:00:00.000Z' } }),
    ).toThrowError(ImmutableFieldError);
  });

  it('moves meta.updatedAt forward and leaves meta.createdAt alone', () => {
    const before = service.get('priya').definition.meta;
    harness.close();
    // A second harness with a later clock, against the same library — which is
    // also a restart, so the definition is reread from disk rather than from a
    // registry that never lost it.
    harness = makeHarness({ dataRoot: temp.path, now: () => new Date('2026-08-17T09:00:00.000Z') });
    service = harness.service;
    service.load();

    const after = service.patch('priya', { tagline: 'later' }).definition.meta;
    expect(after.updatedAt > before.updatedAt).toBe(true);
    expect(after.createdAt).toBe(before.createdAt);
  });

  it('answers an unknown id with a not-found refusal', () => {
    expect(() => service.get('nobody')).toThrowError(AgentNotFoundError);
  });
});

describe('duplicate (§9.2)', () => {
  beforeEach(() => {
    writeFixtureAgent(harness.libraryRoot, 'email-responder', {
      persona: 'Answer the mail.',
      files: {
        'roles/skeptic.md': 'be sceptical',
        'skills/triage-a-stack-trace/SKILL.md': '# triage',
        'avatar.png': TINY_PNG.toString('latin1'),
      },
    });
    service.load();
    harness.events.length = 0;
  });

  it('copies persona, roles, skills and avatar into the new folder', () => {
    const clone = service.duplicate('marcus-inbox', {});

    expect(clone.definition.id).toBe('marcus-inbox-2');
    expect(readFileSync(agentPath('marcus-inbox-2', 'persona.md'), 'utf8')).toBe(
      'Answer the mail.',
    );
    expect(readFileSync(agentPath('marcus-inbox-2', 'roles', 'skeptic.md'), 'utf8')).toBe(
      'be sceptical',
    );
    expect(
      readFileSync(
        agentPath('marcus-inbox-2', 'skills', 'triage-a-stack-trace', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('triage');
    expect(existsSync(agentPath('marcus-inbox-2', 'avatar.png'))).toBe(true);
  });

  it('sets meta.duplicatedFrom, a fresh origin and fresh timestamps', () => {
    const clone = service.duplicate('marcus-inbox', {});
    expect(clone.definition.meta.origin).toBe('duplicated');
    expect(clone.definition.meta.duplicatedFrom).toBe('marcus-inbox');
    expect(clone.definition.meta.createdAt).not.toBe(
      service.get('marcus-inbox').definition.meta.createdAt,
    );
  });

  it('carries every secretRef, and no value (§9.2, §10)', () => {
    const clone = service.duplicate('marcus-inbox', {});
    const gmail = clone.definition.integrations?.['gmail'];
    expect(gmail?.transport).toBe('stdio');
    expect(gmail?.transport === 'stdio' && gmail.env?.['GMAIL_TOKEN']).toEqual({
      secretRef: 'mcp.gmail.token',
    });
    // The literal, non-credential value comes across unchanged.
    expect(gmail?.transport === 'stdio' && gmail.env?.['GMAIL_PROFILE']).toBe('work');
  });

  it('leaves the source untouched', () => {
    const before = readFileSync(agentPath('marcus-inbox', 'agent.json'), 'utf8');
    service.duplicate('marcus-inbox', { name: 'Marcus Two' });

    expect(readFileSync(agentPath('marcus-inbox', 'agent.json'), 'utf8')).toBe(before);
    expect(service.get('marcus-inbox').definition.meta.duplicatedFrom).toBeNull();
  });

  it('mints the id from a supplied name, and names the clone in its plugin manifest', () => {
    const clone = service.duplicate('marcus-inbox', { name: 'Marcus Two' });
    expect(clone.definition.id).toBe('marcus-two');
    expect(clone.definition.name).toBe('Marcus Two');
    expect(
      JSON.parse(readFileSync(agentPath('marcus-two', '.claude-plugin', 'plugin.json'), 'utf8')),
    ).toMatchObject({ name: 'marcus-two' });
  });
});

describe('delete: archive, and purge (§9.3)', () => {
  beforeEach(() => {
    service.create({ name: 'Priya', specialty: 'bug-patching', personaText: 'body' });
  });

  it('moves the folder under .archive/ and drops the id from the listing', () => {
    const result = service.remove('priya');

    expect(result.purged).toBe(false);
    expect(result.archivedAt).not.toBeNull();
    expect(existsSync(agentPath('priya'))).toBe(false);
    expect(service.list().agents).toEqual([]);
  });

  it('keeps the archived definition readable by id, for display', () => {
    service.remove('priya');
    const view = service.get('priya');

    expect(view.definition.name).toBe('Priya');
    expect(view.persona).toBe('body');
    expect(view.archivedAt).not.toBeNull();
  });

  it('refuses a purge while a session references the agent, changing nothing', () => {
    // The real guard, against the real repository: `countByAgent` is what §9.3
    // means by "asks foundation/session store whether any session references
    // the id", so the row is created through the same tables the runner will.
    const project = harness.storage.store.projects.create({ slug: 'scratch', name: 'Scratch' });
    const assignment = harness.storage.store.assignments.create({
      projectId: project.id,
      pattern: 'solo',
    });
    harness.storage.store.sessions.create({
      assignmentId: assignment.id,
      agentId: 'priya',
      projectId: project.id,
      status: 'done',
    });
    expect(harness.storage.store.sessions.countByAgent('priya')).toBe(1);

    expect(() => service.remove('priya', { purge: true })).toThrowError(PurgeBlockedError);
    expect(service.get('priya').archivedAt).toBeNull();
    expect(existsSync(agentPath('priya'))).toBe(true);
  });

  it('purges when no session references the agent', () => {
    service.remove('priya');
    const result = service.remove('priya', { purge: true });

    expect(result.purged).toBe(true);
    expect(() => service.get('priya')).toThrowError(AgentNotFoundError);
    expect(harness.store.archiveEntries()).toEqual([]);
    expect(harness.uiState.get('priya')).toBeUndefined();
  });

  it('is idempotent: deleting an already-archived agent changes nothing', () => {
    const first = service.remove('priya');
    const second = service.remove('priya');
    expect(second.archivedAt).toBe(first.archivedAt);
  });
});

describe('foundation’s agents index (§2.2)', () => {
  it('is pushed on every mutation, archived agents included', () => {
    service.create({ name: 'Priya', specialty: 'bug-patching' });
    expect(harness.storage.store.agents.list()).toHaveLength(1);
    expect(harness.storage.store.agents.get('priya')).toMatchObject({
      name: 'Priya',
      specialty: 'bug-patching',
      isOverseer: false,
      archivedAt: null,
    });

    service.remove('priya');
    // Gone from the live list, still joinable — which is the whole point of the
    // `archived_at` column (foundation §1.4).
    expect(harness.storage.store.agents.list()).toEqual([]);
    expect(harness.storage.store.agents.get('priya')?.archivedAt).not.toBeNull();
  });

  it('records the overseer flag and the model the runner will use', () => {
    writeFixtureAgent(harness.libraryRoot, 'overseer');
    service.load();

    const row = harness.storage.store.agents.get('iris-overseer');
    expect(row?.isOverseer).toBe(true);
    expect(row?.model).toBe(loadFixture('overseer').model?.primary ?? null);
    expect(row?.contentHash).toBeTruthy();
  });
});

describe('roster.changed (§9.1)', () => {
  it('fires for every API mutation, and is persisted', () => {
    service.create({ name: 'Priya', specialty: 'bug-patching' });
    service.patch('priya', { tagline: 'now with a tagline' });
    service.duplicate('priya', {});
    service.remove('priya');

    expect(rosterEvents().map((event) => (event.payload as { reason: string }).reason)).toEqual([
      'created',
      'updated',
      'duplicated',
      'archived',
    ]);
    expect(rosterEvents().every((event) => event.persist)).toBe(true);
    expect(rosterEvents()[0]?.ids.agentId).toBe('priya');
  });

  it('fires for an external file edit', () => {
    service.create({ name: 'Priya', specialty: 'bug-patching', personaText: 'first' });
    harness.events.length = 0;

    writeFileSync(agentPath('priya', 'persona.md'), 'edited in an editor', 'utf8');
    const change = service.reloadFolders(['priya']);

    expect(change.changed).toBe(true);
    expect(service.get('priya').persona).toBe('edited in an editor');
    expect(rosterEvents()).toHaveLength(1);
    expect((rosterEvents()[0]?.payload as { reason: string }).reason).toBe('external');
  });

  it('does not fire when a reload finds nothing new', () => {
    service.create({ name: 'Priya', specialty: 'bug-patching' });
    harness.events.length = 0;

    expect(service.reload().changed).toBe(false);
    expect(service.reloadFolders(['priya']).changed).toBe(false);
    expect(rosterEvents()).toEqual([]);
  });

  it('does not persist a board-order or pin change', () => {
    service.create({ name: 'Priya', specialty: 'bug-patching' });
    harness.events.length = 0;

    service.setBoardOrder(['priya']);
    service.patchUiState('priya', { pinned: true });

    expect(rosterEvents()).toHaveLength(2);
    expect(rosterEvents().some((event) => event.persist)).toBe(false);
  });
});

describe('the board (§9.5)', () => {
  beforeEach(() => {
    for (const name of ['Ada', 'Grace', 'Linus']) {
      service.create({ name, specialty: 'general' });
    }
  });

  it('reorders the whole list and reads back identically', () => {
    service.setBoardOrder(['linus', 'ada', 'grace']);
    expect(service.list().agents.map((agent) => agent.definition.id)).toEqual([
      'linus',
      'ada',
      'grace',
    ]);
  });

  it('refuses an unknown id and leaves the previous order intact', () => {
    service.setBoardOrder(['linus', 'ada', 'grace']);
    expect(() => service.setBoardOrder(['grace', 'nobody'])).toThrowError(UnknownBoardOrderIdError);
    expect(service.list().agents.map((agent) => agent.definition.id)).toEqual([
      'linus',
      'ada',
      'grace',
    ]);
  });

  it('refuses a duplicate id', () => {
    expect(() => service.setBoardOrder(['ada', 'ada'])).toThrowError(/more than once/);
  });

  it('refuses anything that is not an array of ids', () => {
    expect(() => service.setBoardOrder({ ada: 1 })).toThrowError(/whole board/);
  });

  it('pins without touching the definition', () => {
    const before = readFileSync(agentPath('ada', 'agent.json'), 'utf8');
    expect(service.patchUiState('ada', { pinned: true }).uiState.pinned).toBe(true);
    expect(readFileSync(agentPath('ada', 'agent.json'), 'utf8')).toBe(before);
  });
});

describe('avatars (§9.5)', () => {
  beforeEach(() => {
    service.create({
      name: 'Priya',
      specialty: 'bug-patching',
      avatar: { kind: 'emoji', value: '🐛' },
    });
  });

  it('writes avatar.png and flips the definition to the file kind', () => {
    const view = service.putAvatar(
      'priya',
      readAvatarUpload({ body: TINY_PNG, contentType: 'image/png' }),
    );

    expect(view.definition.avatar).toEqual({ kind: 'file', value: 'avatar.png' });
    expect(readFileSync(agentPath('priya', 'avatar.png')).equals(TINY_PNG)).toBe(true);
    expect(service.avatarImage('priya').bytes.equals(TINY_PNG)).toBe(true);
    expect(service.avatarImage('priya').contentType).toBe('image/png');
  });

  it('leaves the previous avatar in place when the next upload is refused', () => {
    service.putAvatar('priya', readAvatarUpload({ body: TINY_PNG, contentType: 'image/png' }));

    expect(() =>
      readAvatarUpload({ body: Buffer.from('not an image'), contentType: 'image/png' }),
    ).toThrow();
    expect(readFileSync(agentPath('priya', 'avatar.png')).equals(TINY_PNG)).toBe(true);
    expect(service.get('priya').definition.avatar).toEqual({ kind: 'file', value: 'avatar.png' });
  });

  it('generates a placeholder when there is no file', () => {
    const image = service.avatarImage('priya');
    expect(image.contentType).toBe('image/svg+xml');
    expect(image.bytes.toString('utf8')).toContain('🐛');
  });

  it('reverts to initials on delete, and removes the file', () => {
    service.putAvatar('priya', readAvatarUpload({ body: TINY_PNG, contentType: 'image/png' }));
    const view = service.deleteAvatar('priya');

    expect(view.definition.avatar?.kind).toBe('initials');
    expect(existsSync(agentPath('priya', 'avatar.png'))).toBe(false);
  });

  it('serves a placeholder for an archived agent too', () => {
    service.remove('priya');
    expect(service.avatarImage('priya').contentType).toBe('image/svg+xml');
  });
});

describe('secrets never leave as values (§10)', () => {
  it('returns the ref and nothing resolvable', () => {
    writeFixtureAgent(harness.libraryRoot, 'email-responder');
    service.load();

    const body = JSON.stringify(service.get('marcus-inbox'));
    expect(body).toContain('mcp.gmail.token');
    // The shape is the ref object itself; there is no sibling holding a value.
    expect(body).not.toMatch(/"resolved"\s*:/);
    expect(body).not.toMatch(/"value"\s*:\s*"ya29/);
  });

  it('returns no filesystem path anywhere in a view (§3.2)', () => {
    service.create({ name: 'Priya', specialty: 'bug-patching' });
    const body = JSON.stringify(service.list());

    expect(body).not.toContain(harness.libraryRoot);
    expect(body).not.toContain(harness.libraryRoot.replace(/\\/g, '\\\\'));
  });
});
