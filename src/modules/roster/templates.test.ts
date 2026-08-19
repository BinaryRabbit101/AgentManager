/**
 * Task templates (roster DESIGN §2.4; WO5).
 *
 * WO5's acceptance list for this element, criterion by criterion:
 *
 * - "templates in the library folder appear in the index and the list route" —
 *   written by hand into `templates/`, the way a `git pull` would deliver one,
 *   and read back through the real store, the real registry and the real route.
 * - "a malformed template is reported like a malformed agent (same diagnostics
 *   path), never crashes the load" — asserted *beside* a malformed agent in the
 *   same library, so the two answers can be compared rather than described.
 * - "the integrations check answers 'agent X lacks connector Y' as data for the
 *   UI".
 *
 * Plus the two rules the WO states and its acceptance list leaves implicit: the
 * variable vocabulary is closed, and the routes are read-only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrapLibrary } from './bootstrap.js';
import { createRosterRoutes } from './routes.js';
import {
  TEMPLATES_DIRNAME,
  TEMPLATE_JSON_FILENAME,
  TEMPLATE_VARIABLES,
  createTemplateStore,
  missingIntegrations,
  renderTemplateText,
  safeParseTaskTemplate,
  serialiseTaskTemplate,
  templateIdProblem,
  templateVariables,
  type TaskTemplate,
} from './templates.js';
import {
  callRoute,
  fakeGit,
  makeHarness,
  makeSpacedTempDir,
  silentLogger,
  writeFixtureAgent,
  type Harness,
  type TempDir,
} from './__tests__/helpers.js';

let temp: TempDir;
let harness: Harness;

const VALID: Record<string, unknown> = {
  schemaVersion: 1,
  id: 'todo-ticket-replies',
  name: 'Reply to todo tickets',
  description: 'Draft a reply per open ticket.',
  pattern: 'solo',
  goalTemplate: 'Work the open items in {{source}} and draft a reply for each.',
  artifactPathTemplate: 'docs/assignments/{{slug}}/replies.md',
  write: true,
  requiredIntegrations: ['todo-mcp'],
  suggestedRoles: ['implementer'],
  preGrantTools: ['Write'],
};

/** Writes a template folder the way a hand-editing owner or a `git pull` would. */
function writeTemplateFolder(libraryRoot: string, id: string, contents: string): string {
  const dir = join(libraryRoot, TEMPLATES_DIRNAME, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, TEMPLATE_JSON_FILENAME), contents, 'utf8');
  return dir;
}

beforeEach(() => {
  temp = makeSpacedTempDir('agentmanager roster templates ');
  harness = makeHarness({ dataRoot: join(temp.path, 'data') });
  bootstrapLibrary({ root: harness.libraryRoot, git: fakeGit().git, initGit: false });
});

afterEach(() => {
  harness.close();
  temp.cleanup();
});

// ---------------------------------------------------------------------------

describe('the schema (§2.4)', () => {
  it('accepts the shape WO5 specifies, and rejects an unknown key', () => {
    const parsed = safeParseTaskTemplate(VALID, 'test');
    expect(parsed.ok).toBe(true);

    const stray = safeParseTaskTemplate({ ...VALID, autoStart: true }, 'test');
    expect(stray.ok).toBe(false);
    // §3's rule, inherited: unknown keys are rejected rather than ignored, and
    // the message names the key that has to go.
    expect(stray.ok ? '' : stray.error.issues[0]?.path).toBe('autoStart');
  });

  it('offers solo and pair only — a team has no default budget', () => {
    expect(safeParseTaskTemplate({ ...VALID, pattern: 'pair' }, 't').ok).toBe(true);
    expect(safeParseTaskTemplate({ ...VALID, pattern: 'overseer' }, 't').ok).toBe(false);
    expect(safeParseTaskTemplate({ ...VALID, pattern: 'review' }, 't').ok).toBe(false);
  });

  it('holds template ids to the slug rules an agent id obeys', () => {
    expect(templateIdProblem('todo-ticket-replies')).toBeUndefined();
    expect(templateIdProblem('Todo')).toMatch(/slug/);
    expect(templateIdProblem('a')).toMatch(/at least/);
    // `nul` is a Windows device name and cannot be a folder at all.
    expect(templateIdProblem('nul')).toMatch(/reserved/);
  });

  it('round-trips through the canonical byte form', () => {
    const template = safeParseTaskTemplate(VALID, 't');
    expect(template.ok).toBe(true);
    if (!template.ok) return;
    const bytes = serialiseTaskTemplate(template.value);
    expect(bytes.endsWith('\n')).toBe(true);
    const again = safeParseTaskTemplate(JSON.parse(bytes), 't');
    expect(again.ok && again.value).toEqual(template.value);
  });
});

// ---------------------------------------------------------------------------

describe('the variables (§2.4: two, and no engine)', () => {
  const template = (over: Partial<TaskTemplate>): TaskTemplate => {
    const parsed = safeParseTaskTemplate({ ...VALID, ...over }, 't');
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  };

  it('is exactly slug and source', () => {
    expect([...TEMPLATE_VARIABLES]).toEqual(['slug', 'source']);
  });

  it('reports which of the two a template actually mentions', () => {
    expect(templateVariables(template({}))).toEqual(['slug', 'source']);
    expect(
      templateVariables(
        template({ goalTemplate: 'Tidy the docs.', artifactPathTemplate: 'docs/tidy.md' }),
      ),
    ).toEqual([]);
    expect(
      templateVariables(
        template({ goalTemplate: 'Answer {{source}}.', artifactPathTemplate: 'a.md' }),
      ),
    ).toEqual(['source']);
  });

  it('substitutes the two it knows and leaves a typo visible', () => {
    expect(
      renderTemplateText('in {{source}} at {{ slug }}', { source: 'the inbox', slug: 'x-1' }),
    ).toBe('in the inbox at x-1');
    // An unsupplied value is an empty string — the field is editable and a
    // half-finished sentence beats one with braces in it.
    expect(renderTemplateText('in {{source}}', {})).toBe('in ');
    // A name outside the vocabulary survives, so the author sees their typo.
    expect(renderTemplateText('in {{soruce}}', { source: 'x' })).toBe('in {{soruce}}');
  });
});

// ---------------------------------------------------------------------------

describe('the store and the registry (§2.3, applied to templates)', () => {
  it('loads a hand-written template folder into the index', () => {
    writeTemplateFolder(harness.libraryRoot, 'todo-ticket-replies', JSON.stringify(VALID));
    harness.service.load();

    const listed = harness.service.listTemplates();
    expect(listed.templates.map((one) => one.template.id)).toEqual(['todo-ticket-replies']);
    expect(listed.templates[0]?.template.name).toBe('Reply to todo tickets');
    expect(listed.diagnostics).toEqual([]);
    // The variables the dialog needs, computed server-side.
    expect(listed.templates[0]?.variables).toEqual(['slug', 'source']);
  });

  it('reports a malformed template exactly the way a malformed agent is reported', () => {
    // One of each, in the same library, so the two answers can be compared.
    writeFixtureAgent(harness.libraryRoot, 'coder');
    mkdirSync(join(harness.libraryRoot, 'agents', 'broken-agent'), { recursive: true });
    writeFileSync(
      join(harness.libraryRoot, 'agents', 'broken-agent', 'agent.json'),
      '{ not json',
      'utf8',
    );
    writeTemplateFolder(harness.libraryRoot, 'broken-template', '{ not json');

    harness.service.load();

    const agentDiagnostic = harness.service.list().diagnostics[0];
    const templateDiagnostic = harness.service.listTemplates().diagnostics[0];

    // Same level, same channel, same "here is the file" shape — a different code
    // only so the board can say which kind of file to open.
    expect(agentDiagnostic?.level).toBe('error');
    expect(templateDiagnostic?.level).toBe('error');
    expect(templateDiagnostic?.code).toBe('roster.invalid-template');
    expect(templateDiagnostic?.path).toContain(TEMPLATE_JSON_FILENAME);

    // And neither took anything else down with it.
    expect(harness.service.list().agents.map((one) => one.definition.id)).toEqual(['priya-bugfix']);
    expect(harness.service.listTemplates().templates).toEqual([]);
  });

  it('refuses a folder whose name disagrees with the id inside it', () => {
    writeTemplateFolder(harness.libraryRoot, 'elsewhere', JSON.stringify(VALID));
    harness.service.load();

    const diagnostic = harness.service.listTemplates().diagnostics[0];
    expect(diagnostic?.code).toBe('roster.template-id-mismatch');
    expect(harness.service.listTemplates().templates).toEqual([]);
  });

  it('picks up an added, edited and removed template on reload', () => {
    harness.service.load();
    expect(harness.service.listTemplates().templates).toEqual([]);

    writeTemplateFolder(harness.libraryRoot, 'todo-ticket-replies', JSON.stringify(VALID));
    expect(harness.service.reloadTemplateFolders(['todo-ticket-replies']).changed).toBe(true);
    expect(harness.service.getTemplate('todo-ticket-replies').template.name).toBe(
      'Reply to todo tickets',
    );

    // An identical rewrite is not a change — the same content-hash rule the
    // agent registry uses, so the watcher and the writer cannot feed each other.
    writeTemplateFolder(harness.libraryRoot, 'todo-ticket-replies', JSON.stringify(VALID));
    expect(harness.service.reloadTemplateFolders(['todo-ticket-replies']).changed).toBe(false);

    writeTemplateFolder(
      harness.libraryRoot,
      'todo-ticket-replies',
      JSON.stringify({ ...VALID, name: 'Answer the queue' }),
    );
    expect(harness.service.reloadTemplateFolders(['todo-ticket-replies']).changed).toBe(true);
    expect(harness.service.getTemplate('todo-ticket-replies').template.name).toBe(
      'Answer the queue',
    );
  });

  it('writes through the store and reads the same document back', () => {
    const store = createTemplateStore({ root: harness.libraryRoot });
    const parsed = safeParseTaskTemplate(VALID, 't');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const written = store.write(parsed.value);
    expect(written.template).toEqual(parsed.value);
    expect(store.hasFolder('todo-ticket-replies')).toBe(true);
    expect(store.folderNames()).toEqual(['todo-ticket-replies']);
  });
});

// ---------------------------------------------------------------------------

describe('the integrations check (WO5: as data)', () => {
  it('is the set difference, order preserved', () => {
    expect(missingIntegrations(['gmail', 'todo-mcp'], ['gmail'])).toEqual(['todo-mcp']);
    expect(missingIntegrations(['gmail'], ['gmail', 'jira'])).toEqual([]);
    expect(missingIntegrations(undefined, [])).toEqual([]);
  });

  it('answers "agent X lacks connector Y" for every live agent at once', () => {
    // `email-responder` is the one fixture that declares an integration.
    const responder = writeFixtureAgent(harness.libraryRoot, 'email-responder');
    writeFixtureAgent(harness.libraryRoot, 'coder');
    const connector = Object.keys(responder.integrations ?? {})[0];
    expect(connector).toBeDefined();

    writeTemplateFolder(
      harness.libraryRoot,
      'todo-ticket-replies',
      JSON.stringify({ ...VALID, requiredIntegrations: [connector] }),
    );
    harness.service.load();

    const gaps = harness.service.getTemplate('todo-ticket-replies').integrationGaps;
    // The agent that carries the connector is absent from the list; the one that
    // does not is present, by name, with what it is missing.
    expect(gaps.map((gap) => gap.agentId)).toEqual(['priya-bugfix']);
    expect(gaps[0]?.missing).toEqual([connector]);
    expect(gaps[0]?.agentName).toBe('Priya');
  });

  it('answers nothing at all for a template that requires nothing', () => {
    writeFixtureAgent(harness.libraryRoot, 'coder');
    writeTemplateFolder(
      harness.libraryRoot,
      'todo-ticket-replies',
      JSON.stringify({ ...VALID, requiredIntegrations: undefined }),
    );
    harness.service.load();
    expect(harness.service.getTemplate('todo-ticket-replies').integrationGaps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('the routes (§2.4, WO5 scope of v1)', () => {
  it('lists and reads, and 404s an id that is not a template', async () => {
    writeTemplateFolder(harness.libraryRoot, 'todo-ticket-replies', JSON.stringify(VALID));
    writeTemplateFolder(harness.libraryRoot, 'broken-template', '{ not json');
    harness.service.load();

    const routes = createRosterRoutes({ service: harness.service, logger: silentLogger() });

    const listed = await callRoute(routes, 'GET', '/api/roster/templates');
    expect(listed.status).toBe(200);
    const body = listed.body as { templates: { template: { id: string } }[]; diagnostics: [] };
    expect(body.templates.map((one) => one.template.id)).toEqual(['todo-ticket-replies']);
    expect(body.diagnostics).toHaveLength(1);

    const one = await callRoute(routes, 'GET', '/api/roster/templates/:id', {
      params: { id: 'todo-ticket-replies' },
    });
    expect(one.status).toBe(200);

    const missing = await callRoute(routes, 'GET', '/api/roster/templates/:id', {
      params: { id: 'nothing-here' },
    });
    expect(missing.status).toBe(404);
    expect((missing.body as { error: string }).error).toBe('template_not_found');

    // A folder that will not parse is a diagnostic, not a template: reading it
    // by id must not answer with something that looks applied.
    const broken = await callRoute(routes, 'GET', '/api/roster/templates/:id', {
      params: { id: 'broken-template' },
    });
    expect(broken.status).toBe(404);
  });

  it('has no write half — templates are authored as files (WO5)', () => {
    const routes = createRosterRoutes({ service: harness.service, logger: silentLogger() });
    const templateRoutes = routes.filter((route) => route.path.includes('/templates'));
    expect(templateRoutes.map((route) => route.method)).toEqual(['GET', 'GET']);
  });
});
