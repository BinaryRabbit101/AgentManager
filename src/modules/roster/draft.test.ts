/**
 * Draft-from-description (roster IMPLEMENTATION **M8**).
 *
 * Every criterion is a named test, driven against the injectable
 * {@link DraftQueryFn} rather than a live subscription — the pipeline is a
 * property of the harness (the prompt, the fenced-JSON extraction, the one
 * repair round-trip, the degraded partial, the catalogue guarantee), and none of
 * those is a property of the model. The one criterion that genuinely needs the
 * engine, M8's P50 latency measurement, lives token-gated in
 * `draft.live.test.ts` beside every other live check.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir, callRoute, silentLogger, makeHarness } from './__tests__/helpers.js';
import {
  CATALOGUE_RULES,
  DRAFT_MAX_TURNS,
  PERMISSION_RULE_CATALOGUE,
  draftFromDescription,
  draftOptions,
  draftSystemPrompt,
  draftUserPrompt,
  extractFencedJson,
  realDraftQuery,
  type DraftMessage,
  type DraftQueryFn,
  type DraftRequest,
} from './draft.js';
import { parseAgentDefinition } from './parse.js';
import { createRosterRoutes } from './routes.js';
import { createRosterService } from './service.js';
import { SPECIALTIES } from './schema.js';

// ---------------------------------------------------------------------------
// A scripted model
// ---------------------------------------------------------------------------

interface ScriptedDraftQuery {
  readonly query: DraftQueryFn;
  readonly calls: { prompt: string; options: ReturnType<typeof draftOptions> }[];
}

/** Answers each call with the next scripted text, as an `assistant` message. */
function scriptedQuery(...answers: readonly string[]): ScriptedDraftQuery {
  const calls: { prompt: string; options: ReturnType<typeof draftOptions> }[] = [];
  const query: DraftQueryFn = (args) => {
    const index = calls.length;
    calls.push({ prompt: args.prompt, options: args.options });
    const text = answers[index] ?? answers[answers.length - 1] ?? '';
    async function* replay(): AsyncGenerator<DraftMessage, void> {
      await Promise.resolve();
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
      };
      yield { type: 'result', result: text };
    }
    return replay();
  };
  return { query, calls };
}

const GOOD_DRAFT = {
  name: 'Priya',
  avatar: '🐛',
  tagline: 'Reproduces first, then fixes',
  specialty: 'bug-patching',
  tags: ['php', 'production'],
  persona:
    '# Priya\n\nYou reproduce a fault before you touch it. You write the failing test first.',
  personaMode: 'append',
  model: { primary: 'sonnet', fallback: 'haiku', effort: 'high' },
  permissions: {
    mode: 'acceptEdits',
    allow: ['Read', 'Grep', 'Edit', 'Bash(npm run test:*)'],
    deny: ['Bash(git push*)'],
    ask: [],
  },
  roles: ['implementer', 'skeptic'],
  suggestedSkills: [{ name: 'triage-a-stack-trace', description: 'Read a trace back to a line.' }],
  suggestedIntegrations: [
    { name: 'sentry', why: 'It is where the 500s are.', secretRef: 'mcp.sentry.token' },
  ],
  rationale: {
    specialty: 'The description centres on diagnosing production errors.',
    permissions: 'Test-first patching means Edit and the test runner; git push is denied.',
    model: 'Balanced tier.',
  },
} as const;

function fenced(value: unknown): string {
  return `Here you go.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

const REQUEST: DraftRequest = {
  description: 'Someone who watches our PHP sites for 500s and patches them, test first.',
};

// ---------------------------------------------------------------------------
// The golden path
// ---------------------------------------------------------------------------

describe('the golden path (DESIGN §12.3)', () => {
  it('produces a draft that passes the M1 agent schema after the wizard adds id and meta', async () => {
    const scripted = scriptedQuery(fenced(GOOD_DRAFT));
    const response = await draftFromDescription(REQUEST, { query: scripted.query });

    expect(response.degraded).toBe(false);
    expect(response.attempts).toBe(1);

    // Exactly the wizard's minimal completion: an id and a meta block. Nothing
    // else is added, which is what "an agent.json-shaped object, minus id/meta"
    // has to mean for the wizard's save to be an ordinary create.
    const completed = parseAgentDefinition(
      {
        ...response.draft,
        id: 'priya-bugfix',
        meta: {
          createdAt: '2026-08-17T10:00:00.000Z',
          updatedAt: '2026-08-17T10:00:00.000Z',
          origin: 'drafted',
          duplicatedFrom: null,
        },
      },
      'draft.test.ts',
    );

    expect(completed.name).toBe('Priya');
    expect(completed.specialty).toBe('bug-patching');
    expect(completed.persona.mode).toBe('append');
    expect(completed.permissions?.allow).toContain('Bash(npm run test:*)');
    expect(completed.capabilities?.overseer).toBe(false);
  });

  it('returns the persona body, the per-field-group rationale and placeholder-only suggestions', async () => {
    const scripted = scriptedQuery(fenced(GOOD_DRAFT));
    const response = await draftFromDescription(REQUEST, { query: scripted.query });

    expect(response.persona).toContain('You reproduce a fault');
    expect(Object.keys(response.rationale).sort()).toEqual(['model', 'permissions', 'specialty']);
    expect(response.suggestedSkills).toEqual([
      { name: 'triage-a-stack-trace', description: 'Read a trace back to a line.' },
    ]);
    // §12.2: server names and a reason, with a `secretRef` placeholder and never
    // a credential.
    expect(response.suggestedIntegrations[0]?.secretRef).toBe('mcp.sentry.token');
    expect(JSON.stringify(response)).not.toMatch(/ya29\.|sk-ant-|password/i);
  });

  it('warns when the draft proposes replace mode, because that discards the coding preset', async () => {
    const scripted = scriptedQuery(fenced({ ...GOOD_DRAFT, personaMode: 'replace' }));
    const response = await draftFromDescription(REQUEST, { query: scripted.query });

    expect(response.warnings.join(' ')).toContain('replace');
    expect(response.draft.persona?.mode).toBe('replace');
  });
});

// ---------------------------------------------------------------------------
// The repair round-trip and the degraded response
// ---------------------------------------------------------------------------

describe('one repair, then degrade (DESIGN §12.2)', () => {
  it('a malformed first answer triggers exactly one repair call, feeding the errors back', async () => {
    const scripted = scriptedQuery('I think you want a bug fixer, really.', fenced(GOOD_DRAFT));
    const response = await draftFromDescription(REQUEST, { query: scripted.query });

    expect(scripted.calls).toHaveLength(2);
    expect(response.attempts).toBe(2);
    expect(response.degraded).toBe(false);
    expect(response.draft.name).toBe('Priya');

    // The errors are handed back verbatim, with the previous answer.
    expect(scripted.calls[1]?.prompt).toContain('validation errors');
    expect(scripted.calls[1]?.prompt).toContain('I think you want a bug fixer');
  });

  it('a second malformed answer degrades with the fields that did validate, and never throws', async () => {
    // Both answers are unusable as a whole — no `persona`, no `rationale` — but
    // half the field groups are individually fine, and those are what a wizard
    // opens with.
    const partial = fenced({
      name: 'Nils',
      specialty: 'research',
      tags: ['reading'],
      permissions: { allow: ['Read', 'WebSearch'] },
      suggestedSkills: [{ name: 'read-the-rfc', description: 'Find the normative sentence.' }],
    });
    const scripted = scriptedQuery(partial, partial);
    const response = await draftFromDescription(REQUEST, { query: scripted.query });

    expect(scripted.calls).toHaveLength(2);
    expect(response.degraded).toBe(true);
    expect(response.draft.name).toBe('Nils');
    expect(response.draft.specialty).toBe('research');
    expect(response.draft.permissions?.allow).toEqual(['Read', 'WebSearch']);
    expect(response.suggestedSkills).toHaveLength(1);
    // "plus the raw text", so the owner can see what was actually said.
    expect(response.raw).toContain('Nils');
    expect(response.warnings.join(' ')).toContain('starting point');
  });

  it('answers HTTP 200 for a degraded draft rather than an error (M8 acceptance)', async () => {
    const temp = makeTempDir('agentmanager-roster-draft-http-');
    const harness = makeHarness({ dataRoot: temp.path });
    try {
      const scripted = scriptedQuery('not json', 'still not json');
      const service = createRosterService({
        store: harness.store,
        uiState: harness.uiState,
        agents: harness.storage.store.agents,
        sessions: harness.storage.store.sessions,
        bus: harness.bus,
        draftQuery: scripted.query,
      });
      const routes = createRosterRoutes({ service, logger: silentLogger() });

      const answer = await callRoute(routes, 'POST', '/api/roster/draft', {
        body: { description: REQUEST.description },
      });

      expect(answer.status).toBe(200);
      expect((answer.body as { degraded: boolean }).degraded).toBe(true);
    } finally {
      harness.close();
      temp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The catalogue guarantee
// ---------------------------------------------------------------------------

describe('the fixed rule catalogue (DESIGN §12.2)', () => {
  it('drops an invented tool name so the draft can only contain catalogue rules', async () => {
    const scripted = scriptedQuery(
      fenced({
        ...GOOD_DRAFT,
        permissions: {
          mode: 'default',
          allow: ['Read', 'Telepathy', 'mcp__agentmanager__create_assignment'],
          deny: ['Bash(git push*)', 'Agent'],
          ask: ['Sudo'],
        },
      }),
    );
    const response = await draftFromDescription(REQUEST, { query: scripted.query });

    const rules = [
      ...(response.draft.permissions?.allow ?? []),
      ...(response.draft.permissions?.deny ?? []),
      ...(response.draft.permissions?.ask ?? []),
    ];
    expect(rules).not.toHaveLength(0);
    for (const rule of rules) expect(CATALOGUE_RULES).toContain(rule);

    expect(rules).not.toContain('Telepathy');
    // The two namespaces a draft may never reach into: the subagent tool (D4)
    // and the orchestration surface, which is compiled from capabilities (§11).
    expect(rules).not.toContain('Agent');
    expect(rules.some((rule) => rule.startsWith('mcp__agentmanager__'))).toBe(false);
    expect(response.warnings.join(' ')).toContain('Telepathy');
  });

  it('states the catalogue and the specialty enum in the prompt it sends', () => {
    const prompt = draftSystemPrompt();
    for (const specialty of SPECIALTIES) expect(prompt).toContain(specialty);
    for (const entry of PERMISSION_RULE_CATALOGUE) expect(prompt).toContain(entry.rule);
    // Named as forbidden rather than merely omitted.
    expect(prompt).toContain('AskUserQuestion');
    expect(prompt).toContain('mcp__agentmanager__');
    expect(CATALOGUE_RULES).not.toContain('AskUserQuestion');
    expect(CATALOGUE_RULES).not.toContain('Agent');
  });
});

// ---------------------------------------------------------------------------
// The inert call (DESIGN §12.2 as amended, SDK-NOTES D5)
// ---------------------------------------------------------------------------

describe('the inert query configuration (SDK-NOTES D5)', () => {
  it('uses no tools, no MCP servers, no setting sources and no skills', async () => {
    const scripted = scriptedQuery(fenced(GOOD_DRAFT));
    await draftFromDescription(REQUEST, { query: scripted.query });
    const options = scripted.calls[0]?.options;

    // The amendment itself: `tools: []` is the restriction lever, and
    // `allowedTools: []` alone would leave every built-in tool defined.
    expect(options?.tools).toEqual([]);
    expect(options?.allowedTools).toEqual([]);
    expect(options?.mcpServers).toEqual({});
    expect(options?.settingSources).toEqual([]);
    expect(options?.skills).toEqual([]);
    expect(options?.plugins).toEqual([]);
    expect(options?.permissionMode).toBe('dontAsk');
    expect(options?.maxTurns).toBe(DRAFT_MAX_TURNS);
    // A full replacement string: this is not a coding task (§12.2).
    expect(typeof options?.systemPrompt).toBe('string');
  });

  it('is the shape the pinned SDK declares, and the seam the real query satisfies', () => {
    // That this assignment type-checks is the standing check on the seam.
    const live: DraftQueryFn = realDraftQuery;
    expect(typeof live).toBe('function');
    expect(draftOptions().model).toBe('sonnet');
  });
});

// ---------------------------------------------------------------------------
// Statelessness (DESIGN §12: "Stateless: no server-side draft records")
// ---------------------------------------------------------------------------

describe('no draft state (DESIGN §12)', () => {
  it('two identical requests share nothing — the second sees none of the first', async () => {
    const first = scriptedQuery(fenced(GOOD_DRAFT));
    const second = scriptedQuery(fenced({ ...GOOD_DRAFT, name: 'Rafi', specialty: 'research' }));

    const one = await draftFromDescription(REQUEST, { query: first.query });
    const two = await draftFromDescription(REQUEST, { query: second.query });

    expect(one.draft.name).toBe('Priya');
    expect(two.draft.name).toBe('Rafi');
    // The second call re-asked the model rather than answering from anything
    // the first left behind.
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.prompt).toBe(first.calls[0]?.prompt);
  });

  it('writes no draft table, file or folder anywhere in the data root', async () => {
    const temp = makeTempDir('agentmanager-roster-draft-state-');
    const harness = makeHarness({ dataRoot: temp.path });
    try {
      const scripted = scriptedQuery(fenced(GOOD_DRAFT));
      const service = createRosterService({
        store: harness.store,
        uiState: harness.uiState,
        agents: harness.storage.store.agents,
        sessions: harness.storage.store.sessions,
        bus: harness.bus,
        draftQuery: scripted.query,
      });

      const tree = (root: string): string[] => {
        let entries;
        try {
          entries = readdirSync(root, { withFileTypes: true });
        } catch {
          return [];
        }
        return entries.flatMap((entry) =>
          entry.isDirectory()
            ? [entry.name, ...tree(join(root, entry.name)).map((child) => `${entry.name}/${child}`)]
            : [entry.name],
        );
      };

      const before = tree(harness.libraryRoot);
      await service.draft({ description: REQUEST.description });
      await service.draft({ description: REQUEST.description });

      // Nothing was written: not an agent folder, not a scratch file.
      expect(tree(harness.libraryRoot)).toEqual(before);
      expect(tree(harness.dataRoot).filter((entry) => entry.includes('draft'))).toEqual([]);
      const tables = harness.storage.db
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      expect(tables.filter((name) => name.toLowerCase().includes('draft'))).toEqual([]);
    } finally {
      harness.close();
      temp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Extraction, which is the part a model is least reliable about
// ---------------------------------------------------------------------------

describe('fenced-JSON extraction', () => {
  it('reads a fenced object, a bare object, and refuses prose', () => {
    expect(extractFencedJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractFencedJson('```\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractFencedJson('Sure: {"a":3} — hope that helps')).toEqual({ a: 3 });
    expect(extractFencedJson('no json here at all')).toBeUndefined();
  });

  it('survives a string containing braces', () => {
    expect(extractFencedJson('```json\n{"note":"use {this} form"}\n```')).toEqual({
      note: 'use {this} form',
    });
  });

  it('carries the hints into the user prompt without inventing any', () => {
    const prompt = draftUserPrompt({
      description: 'watches PHP sites',
      hints: { name: 'Priya', modelTier: 'balanced', overseer: true, projectId: 'lpm' },
    });
    expect(prompt).toContain('watches PHP sites');
    expect(prompt).toContain('preferred name: Priya');
    expect(prompt).toContain('sonnet');
    expect(prompt).toContain('overseer');
    expect(draftUserPrompt({ description: 'plain' })).not.toContain('Hints:');
  });
});
