/**
 * The wizard's and the editor's round trips (ui IMPLEMENTATION §8), and the
 * work-item link of §7 — all against a booted core.
 *
 * Four of these criteria are explicitly claims about **what is on disk after the
 * form posted**, which jsdom cannot see:
 *
 * - "The saved definition is byte-equal to what the form posted (no client-side
 *   merge, no server reconciliation) — asserted by reading back `GET
 *   /agents/:id`."
 * - "`persona.md` round-trips byte-for-byte through the textarea, including
 *   trailing whitespace and Windows line endings."
 * - "Accepting a suggested skill creates `skills/<name>/SKILL.md` and adds the
 *   name to `skills.names`; declining it writes nothing."
 * - "Duplicate … saving creates a second, independent folder."
 *
 * Plus §7's "the created assignment carries `workItemIds` and the item flips to
 * `in_progress`", which is a claim about projects' own projection.
 *
 * The body posted in each case is built by the **frontend's** `toCreateBody`, so
 * what is under test is the real projection and not a hand-written fixture.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scriptedQuery, successScript } from '../../src/modules/runner/__tests__/fakeQuery.js';
import { toCreateBody, type EditorModel } from '../src/agents/editorModel';
import type { AgentView, CreateSoloResult, WorkItem, WorkItemListView } from '../src/api/types';

import {
  bootCore,
  makeTempDir,
  seedAgent,
  seedProject,
  untilTerminal,
  type BootedCore,
  type TempDir,
} from './core';

let core: BootedCore | undefined;
let workspace: TempDir;

beforeEach(() => {
  workspace = makeTempDir('agentmanager-ui-e2e-agents-');
});

afterEach(async () => {
  await core?.shutdown();
  core = undefined;
  workspace.cleanup();
});

/** A filled form, as the wizard's review step would hold it. */
function form(overrides: Partial<EditorModel> = {}): EditorModel {
  return {
    name: 'Priya Round Trip',
    specialty: 'bug-patching',
    tagline: 'Reproduces first, then fixes.',
    tags: 'php, invoices',
    avatarEmoji: '🐛',
    personaText: '# Priya\r\n\r\nWrite a failing test first.   \r\n\r\n',
    personaMode: 'append',
    modelPrimary: 'sonnet',
    modelFallback: '',
    modelEffort: '',
    permissionMode: 'acceptEdits',
    allow: 'Read\nEdit',
    deny: 'Bash(git push*)',
    ask: '',
    roles: ['implementer'],
    overseer: false,
    roleAddenda: {},
    acceptedSkills: [],
    ...overrides,
  };
}

/** `<dataRoot>/library/agents/<id>` — where roster writes an agent folder. */
function agentDir(booted: BootedCore, id: string): string {
  return join(booted.service.paths.library, 'agents', id);
}

describe('the saved definition is what the form posted (§8)', () => {
  it('reads back byte-equal, with no merge on either side', async () => {
    core = await bootCore();
    const body = toCreateBody(form(), { origin: 'drafted' });

    const created = await core.client.request<AgentView>('/roster/agents', {
      method: 'POST',
      body,
    });
    if (created.kind !== 'ok') throw new Error(created.message);
    const id = created.value.definition.id;

    const read = await core.client.request<AgentView>(`/roster/agents/${id}`);
    if (read.kind !== 'ok') throw new Error(read.message);
    const definition = read.value.definition;

    // Every field the form sent, back exactly as it was sent. The server adds
    // `id`, `meta` and its own schema defaults; it changes nothing that was
    // given, which is the whole of "no server reconciliation".
    expect(definition.name).toBe(body['name']);
    expect(definition.specialty).toBe(body['specialty']);
    expect(definition.tagline).toBe(body['tagline']);
    expect(definition.tags).toEqual(['php', 'invoices']);
    expect(definition.avatar).toEqual({ kind: 'emoji', value: '🐛' });
    expect(definition.model).toEqual({ primary: 'sonnet' });
    expect(definition.permissions).toEqual({
      mode: 'acceptEdits',
      allow: ['Read', 'Edit'],
      deny: ['Bash(git push*)'],
    });
    expect(definition.capabilities).toEqual({ overseer: false, roles: ['implementer'] });
    expect(definition.meta.origin).toBe('drafted');
  });

  it('round-trips persona.md byte-for-byte, CRLF and trailing spaces included', async () => {
    core = await bootCore();
    const persona = '# Priya\r\n\r\nTrailing spaces matter:   \r\n\ttabbed\r\n\r\n\r\n';

    const created = await core.client.request<AgentView>('/roster/agents', {
      method: 'POST',
      body: toCreateBody(form({ personaText: persona })),
    });
    if (created.kind !== 'ok') throw new Error(created.message);
    const id = created.value.definition.id;

    // Through the API…
    const read = await core.client.request<AgentView>(`/roster/agents/${id}`);
    if (read.kind !== 'ok') throw new Error(read.message);
    expect(read.value.persona).toBe(persona);

    // …and on disk, because that is the file the agent's session will read.
    const onDisk = readFileSync(join(agentDir(core, id), 'persona.md'), 'utf8');
    expect(onDisk).toBe(persona);
  });
});

describe('suggested skills are inert until accepted (§8, roster §12.4)', () => {
  it('creates skills/<name>/SKILL.md and lists the name when accepted', async () => {
    core = await bootCore();
    const suggested = [
      { name: 'triage-a-stack-trace', description: 'Read a PHP trace and name the file.' },
    ];

    const created = await core.client.request<AgentView>('/roster/agents', {
      method: 'POST',
      body: toCreateBody(form({ acceptedSkills: ['triage-a-stack-trace'] }), {
        suggestedSkills: suggested,
      }),
    });
    if (created.kind !== 'ok') throw new Error(created.message);
    const id = created.value.definition.id;

    const stub = join(agentDir(core, id), 'skills', 'triage-a-stack-trace', 'SKILL.md');
    expect(existsSync(stub)).toBe(true);
    // The description, and nothing invented.
    expect(readFileSync(stub, 'utf8')).toContain('Read a PHP trace and name the file.');

    const read = await core.client.request<AgentView>(`/roster/agents/${id}`);
    if (read.kind !== 'ok') throw new Error(read.message);
    expect(read.value.definition.skills).toEqual({
      mode: 'declared',
      names: ['triage-a-stack-trace'],
    });
  });

  it('writes nothing at all when the suggestion is declined', async () => {
    core = await bootCore();
    const suggested = [{ name: 'triage-a-stack-trace', description: 'Read a PHP trace.' }];

    const created = await core.client.request<AgentView>('/roster/agents', {
      method: 'POST',
      body: toCreateBody(form(), { suggestedSkills: suggested }),
    });
    if (created.kind !== 'ok') throw new Error(created.message);
    const id = created.value.definition.id;

    expect(existsSync(join(agentDir(core, id), 'skills'))).toBe(false);
    const read = await core.client.request<AgentView>(`/roster/agents/${id}`);
    if (read.kind !== 'ok') throw new Error(read.message);
    expect(read.value.definition.skills).toBeUndefined();
  });
});

describe('duplicate makes a second, independent folder (§7.2)', () => {
  it('copies the persona and the skills, and editing the clone leaves the original alone', async () => {
    core = await bootCore();
    const created = await core.client.request<AgentView>('/roster/agents', {
      method: 'POST',
      body: toCreateBody(form({ acceptedSkills: ['triage-a-stack-trace'] }), {
        suggestedSkills: [{ name: 'triage-a-stack-trace', description: 'Read a trace.' }],
      }),
    });
    if (created.kind !== 'ok') throw new Error(created.message);
    const sourceId = created.value.definition.id;

    const cloned = await core.client.request<AgentView>(`/roster/agents/${sourceId}/duplicate`, {
      method: 'POST',
      body: {},
    });
    if (cloned.kind !== 'ok') throw new Error(cloned.message);
    const cloneId = cloned.value.definition.id;

    expect(cloneId).not.toBe(sourceId);
    expect(cloned.value.definition.meta.duplicatedFrom).toBe(sourceId);
    // A whole folder, not a row: persona and skills came with it.
    expect(existsSync(join(agentDir(core, cloneId), 'persona.md'))).toBe(true);
    expect(
      existsSync(join(agentDir(core, cloneId), 'skills', 'triage-a-stack-trace', 'SKILL.md')),
    ).toBe(true);

    // The editor saves the clone through PATCH, exactly as the detail page does.
    const patched = await core.client.request<AgentView>(`/roster/agents/${cloneId}`, {
      method: 'PATCH',
      body: { tagline: 'The clone’s own words.' },
    });
    if (patched.kind !== 'ok') throw new Error(patched.message);

    const original = await core.client.request<AgentView>(`/roster/agents/${sourceId}`);
    if (original.kind !== 'ok') throw new Error(original.message);
    expect(original.value.definition.tagline).toBe('Reproduces first, then fixes.');
  });
});

describe('a launch with work items links them and flips them (§7)', () => {
  it('carries workItemIds and the item becomes in_progress', async () => {
    const script = scriptedQuery({ messages: successScript('Patched the 500.') });
    core = await bootCore({ runner: { query: script.query } });

    const projectId = await seedProject(core, workspace.path, 'littlepocketmuseum');
    const agentId = await seedAgent(core, 'Priya Items');

    const item = await core.client.request<WorkItem>(`/projects/${projectId}/work-items`, {
      method: 'POST',
      // "title only is enough" (§8.2).
      body: { title: 'Fix the 500 on /invoices' },
    });
    if (item.kind !== 'ok') throw new Error(item.message);
    expect(item.value.status).toBe('open');

    // Exactly the body the launch flow posts when an item was dropped on.
    const launched = await core.client.request<CreateSoloResult>('/assignments/solo', {
      method: 'POST',
      body: {
        projectId,
        agentId,
        prompt: 'Fix the 500 on /invoices',
        write: true,
        workItemIds: [item.value.id],
      },
    });
    if (launched.kind !== 'ok') throw new Error(launched.message);

    const listed = await core.client.request<WorkItemListView>(`/projects/${projectId}/work-items`);
    if (listed.kind !== 'ok') throw new Error(listed.message);
    const flipped = listed.value.workItems.find((one) => one.id === item.value.id);
    // The UI never sets this status: projects derives it from the link (§1.5).
    expect(flipped?.status).toBe('in_progress');

    await untilTerminal(core, launched.value.sessionId);
  });
});
