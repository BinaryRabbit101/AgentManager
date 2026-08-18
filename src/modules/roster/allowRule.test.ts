/**
 * `POST /api/roster/agents/:id/permissions/allow` — the durable half of the
 * question card's **Always allow** (runner DESIGN §5.1, owner decision
 * 2026-08-18; roster DESIGN §6).
 *
 * The route exists so that "remember this" is *an explicit roster edit* rather
 * than the SDK's `updatedPermissions`, which would widen a live session's
 * permissions at runtime and take §6.2's "the only composer" away from this
 * element. Everything below is a property of that sentence:
 *
 * - it writes through `patch`, so the rule lands in `agent.json` and comes back
 *   out of `GET /agents/:id` — the editor and the card cannot disagree;
 * - it emits the same `roster.changed` a save from the editor does, because the
 *   UI's caches are invalidated by that event and nothing else;
 * - it is idempotent, because a user taps twice and two clients answer one card;
 * - it refuses a rule the SDK would not honour, because a permission believed to
 *   be in force and silently inert is the failure this element exists to
 *   prevent (§6.1's fixes 1 and 2).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppEvent } from '../types.js';

import {
  callRoute,
  makeHarness,
  makeTempDir,
  silentLogger,
  writeFixtureAgent,
  type Harness,
  type TempDir,
} from './__tests__/helpers.js';
import { bootstrapLibrary } from './bootstrap.js';
import { createRosterRoutes } from './routes.js';
import type { AgentDefinition } from './schema.js';
import type { AllowRuleResult, RosterService } from './service.js';

const ROUTE = '/api/roster/agents/:id/permissions/allow';

let temp: TempDir;
let harness: Harness;
let service: RosterService;
let agent: AgentDefinition;

function routes(): ReturnType<typeof createRosterRoutes> {
  return createRosterRoutes({ service, logger: silentLogger() });
}

function rosterEvents(): AppEvent[] {
  return harness.events.filter((event) => event.type === 'roster.changed');
}

/** The rules as they are on disk — not as the in-memory view reports them. */
function storedAllow(id: string): readonly string[] {
  const raw = readFileSync(join(harness.libraryRoot, 'agents', id, 'agent.json'), 'utf8');
  const parsed = JSON.parse(raw) as { permissions?: { allow?: string[] } };
  return parsed.permissions?.allow ?? [];
}

beforeEach(() => {
  temp = makeTempDir('agentmanager-roster-allow-');
  harness = makeHarness({ dataRoot: temp.path });
  bootstrapLibrary({ root: harness.libraryRoot, initGit: false });
  service = harness.service;
  agent = writeFixtureAgent(harness.libraryRoot, 'coder');
  service.load();
  harness.events.length = 0;
});

afterEach(() => {
  harness.close();
  temp.cleanup();
});

describe('appending a rule (§6)', () => {
  it('appends it, persists it, and returns the agent carrying it', async () => {
    const answer = await callRoute(routes(), 'POST', ROUTE, {
      params: { id: agent.id },
      body: { rule: 'Bash(npm run:*)' },
    });

    expect(answer.status).toBe(200);
    const result = answer.body as AllowRuleResult;
    expect(result.added).toBe(true);
    expect(result.rule).toBe('Bash(npm run:*)');
    // The definition the editor renders, and the file underneath it.
    expect(result.agent.definition.permissions?.allow).toContain('Bash(npm run:*)');
    expect(storedAllow(agent.id)).toContain('Bash(npm run:*)');
    // Nothing else moved: this appends, it does not rewrite the block.
    expect(result.agent.definition.permissions?.deny).toEqual(agent.permissions?.deny);
    expect(result.agent.definition.permissions?.ask).toEqual(agent.permissions?.ask);
    expect(result.agent.definition.permissions?.mode).toBe(agent.permissions?.mode);
  });

  it('appends rather than replacing — the rules already there survive', async () => {
    await callRoute(routes(), 'POST', ROUTE, {
      params: { id: agent.id },
      body: { rule: 'Bash(npm run:*)' },
    });
    await callRoute(routes(), 'POST', ROUTE, {
      params: { id: agent.id },
      body: { rule: 'Edit(/repo/docs/a.md)' },
    });

    expect(storedAllow(agent.id)).toEqual([
      ...(agent.permissions?.allow ?? []),
      'Bash(npm run:*)',
      'Edit(/repo/docs/a.md)',
    ]);
  });

  it('emits the roster.changed the UI’s caches are invalidated by', async () => {
    await callRoute(routes(), 'POST', ROUTE, {
      params: { id: agent.id },
      body: { rule: 'Bash(npm run:*)' },
    });

    const events = rosterEvents();
    expect(events).toHaveLength(1);
    // The same reason a save from the editor carries — the durable allow *is*
    // an edit, so it must not be a new event type the UI has never seen.
    expect(events[0]?.payload).toMatchObject({ reason: 'updated', agentIds: [agent.id] });
    expect(events[0]?.persist).toBe(true);
  });

  it('is idempotent: the same rule twice writes once and emits once', async () => {
    const first = (
      await callRoute(routes(), 'POST', ROUTE, {
        params: { id: agent.id },
        body: { rule: 'Bash(npm run:*)' },
      })
    ).body as AllowRuleResult;
    const second = await callRoute(routes(), 'POST', ROUTE, {
      params: { id: agent.id },
      body: { rule: 'Bash(npm run:*)' },
    });

    expect(first.added).toBe(true);
    // A success, not a 409: answering the same card twice is harmless, and a
    // failure here would tell the user the rule was not saved when it was.
    expect(second.status).toBe(200);
    expect((second.body as AllowRuleResult).added).toBe(false);
    expect(storedAllow(agent.id).filter((rule) => rule === 'Bash(npm run:*)')).toHaveLength(1);
    expect(rosterEvents()).toHaveLength(1);
  });

  it('is idempotent against a rule the fixture already allowed', async () => {
    const answer = await callRoute(routes(), 'POST', ROUTE, {
      params: { id: agent.id },
      body: { rule: 'Read' },
    });

    expect(answer.status).toBe(200);
    expect((answer.body as AllowRuleResult).added).toBe(false);
    expect(rosterEvents()).toHaveLength(0);
    expect(storedAllow(agent.id)).toEqual(agent.permissions?.allow);
  });
});

describe('refusing a rule (§6.1)', () => {
  async function refusal(body: unknown): Promise<{ status: number; text: string }> {
    const answer = await callRoute(routes(), 'POST', ROUTE, { params: { id: agent.id }, body });
    return { status: answer.status, text: JSON.stringify(answer.body) };
  }

  it('refuses a missing or non-string rule', async () => {
    expect((await refusal({})).status).toBe(400);
    expect((await refusal({ rule: 42 })).status).toBe(400);
    expect((await refusal(undefined)).status).toBe(400);
    expect(storedAllow(agent.id)).toEqual(agent.permissions?.allow);
  });

  it('refuses what the definition schema refuses — an unbalanced scope', async () => {
    const answer = await refusal({ rule: 'Bash(npm run:*' });
    expect(answer.status).toBe(400);
    expect(answer.text).toContain('Tool(pattern)');
  });

  it('refuses a rule with stray whitespace, and one over 200 characters', async () => {
    expect((await refusal({ rule: ' Read' })).status).toBe(400);
    expect((await refusal({ rule: `Edit(${'a'.repeat(220)})` })).status).toBe(400);
  });

  it('refuses an empty rule', async () => {
    expect((await refusal({ rule: '' })).status).toBe(400);
  });

  it('refuses a scoped file-edit alias, which the engine never consults (C1)', async () => {
    // `Write(./docs/**)` parses and is accepted by the schema — and is inert.
    // Storing it would put a boundary in the record that does not exist.
    const answer = await refusal({ rule: 'Write(./docs/**)' });
    expect(answer.status).toBe(400);
    expect(answer.text).toContain('Edit(./docs/**)');
    expect(storedAllow(agent.id)).toEqual(agent.permissions?.allow);
  });

  it('refuses a wildcard file scope, which collapses to a bare auto-approve (C1)', async () => {
    const answer = await refusal({ rule: 'Edit(*)' });
    expect(answer.status).toBe(400);
    expect(storedAllow(agent.id)).toEqual(agent.permissions?.allow);
  });

  it('refuses AskUserQuestion, which roster would lift straight back into ask (C2)', async () => {
    const answer = await refusal({ rule: 'AskUserQuestion' });
    expect(answer.status).toBe(400);
    expect(answer.text).toContain('question bridge');
  });

  it('is a 404 for an agent that does not exist', async () => {
    const answer = await callRoute(routes(), 'POST', ROUTE, {
      params: { id: 'nobody' },
      body: { rule: 'Read' },
    });
    expect(answer.status).toBe(404);
  });

  it('is a 409 for an archived agent — an archived definition is not editable (§9.3)', async () => {
    service.remove(agent.id);
    harness.events.length = 0;

    const answer = await callRoute(routes(), 'POST', ROUTE, {
      params: { id: agent.id },
      body: { rule: 'Bash(npm run:*)' },
    });
    expect(answer.status).toBe(409);
    expect(rosterEvents()).toHaveLength(0);
  });
});

describe('the rules runner derives are rules this route accepts', () => {
  /*
    The two ends of the feature, checked against each other.

    Runner writes the rule and this route stores it, and the grammar lives in
    neither of them — `sdkRules.ts` has it, and runner restates it because
    feature modules never import each other (foundation §6.1). That restatement
    is the seam that can drift, so the shapes runner's own table produces are
    listed here literally. A row that starts failing means the two halves have
    parted company, which is exactly the day this needs to be noticed.
  */
  const DERIVED = [
    'Bash(ls:*)',
    'Bash(git status:*)',
    'Bash(npm run:*)',
    'Bash(docker compose:*)',
    'Edit(/repo/src/a.ts)',
    'Edit(C:/workspace/notes.md)',
    'Read',
    'Glob',
    'WebFetch',
    'mcp__gmail__send_message',
  ];

  for (const rule of DERIVED) {
    it(`accepts ${rule}`, async () => {
      const answer = await callRoute(routes(), 'POST', ROUTE, {
        params: { id: agent.id },
        body: { rule },
      });
      expect(answer.status).toBe(200);
      expect((answer.body as AllowRuleResult).rule).toBe(rule);
      expect(storedAllow(agent.id)).toContain(rule);
    });
  }
});
