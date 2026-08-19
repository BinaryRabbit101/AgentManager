/**
 * The task-template strip in **Start work** (DESIGN §6; roster §2.4; WO5).
 *
 * WO5's web acceptance, criterion by criterion:
 *
 * - "picking a template prefills goal/pattern/artifact";
 * - "a missing-connector warning renders with the editor link";
 * - "blank card keeps today's flow exactly".
 *
 * Plus the two things the WO's design section makes load-bearing and its
 * acceptance list leaves implicit: `{{source}}` renders **one** extra input and
 * only when the template mentions it, and `preGrantTools` arrives as ticked
 * chips that ride the create call.
 *
 * The whole app is mounted, as the sibling suites do, so the strip reads its
 * templates through the real query layer and the submit goes through the real
 * `ApiClient` — a test that stubbed either would be asserting its own fixture.
 *
 * The one unit assertion here is deliberate: `renderTemplateText` in
 * `model.ts` is a **restatement** of roster's own substitution rule, so it is
 * pinned against roster's function by importing it — the same arrangement
 * `integrationsModel.test.ts` uses against `integrationsSchema`.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderTemplateText as rosterRender } from '../../../src/modules/roster/templates.js';
import { anAgent, aProject, json, mount, type Responder } from '../../test/harness';
import { App } from '../App';
import type { AgentView, Project, TaskTemplateView } from '../api/types';
import { PATTERNS } from '../assignments/fixtures';
import { useAppStore, type StartWorkIntent } from '../state/store';

import { renderTemplateText, templateSlug, usesSource } from './model';

const PRIYA = anAgent({ id: 'priya', name: 'Priya' });
const MARCUS = anAgent({
  id: 'marcus',
  name: 'Marcus',
  integrations: { gmail: { transport: 'stdio', command: 'npx' } },
});
const LPM = aProject({ id: 'lpm', name: 'littlepocketmuseum' });

const TODO: TaskTemplateView = {
  template: {
    schemaVersion: 1,
    id: 'todo-ticket-replies',
    name: 'Reply to todo tickets',
    description: 'Draft a reply per open ticket.',
    pattern: 'solo',
    goalTemplate: 'Work the open items in {{source}}: draft a reply for each.',
    artifactPathTemplate: 'docs/assignments/{{slug}}/replies.md',
    write: true,
    preGrantTools: ['Write'],
  },
  variables: ['slug', 'source'],
  integrationGaps: [],
};

/** A `pair` template that needs a connector nobody but Marcus carries. */
const EMAIL: TaskTemplateView = {
  template: {
    schemaVersion: 1,
    id: 'email-reply-drafts',
    name: 'Draft email replies',
    description: 'Read the unanswered mail and draft replies.',
    pattern: 'pair',
    goalTemplate: 'Draft replies to the unanswered mail.',
    artifactPathTemplate: 'docs/assignments/{{slug}}/email-drafts.md',
    requiredIntegrations: ['gmail'],
  },
  variables: ['slug'],
  integrationGaps: [{ agentId: 'priya', agentName: 'Priya', missing: ['gmail'] }],
};

interface Options {
  readonly agents?: readonly AgentView[];
  readonly projects?: readonly Project[];
  /** `undefined` serves a 404 — a core that predates the route (WO5). */
  readonly templates?: readonly TaskTemplateView[] | undefined;
}

function serving(options: Options = {}): { respond: Responder; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const agents = options.agents ?? [PRIYA, MARCUS];
  const projects = options.projects ?? [LPM];

  const respond: Responder = (url, init) => {
    const path = url.split('?')[0] ?? url;
    if (path === '/api/roster/agents') return json({ agents, diagnostics: [] });
    if (path === '/api/roster/templates') {
      return options.templates === undefined
        ? json({ error: 'not_found', message: 'no templates route' }, 404)
        : json({ templates: options.templates, diagnostics: [] });
    }
    if (path === '/api/projects') return json({ projects });
    if (path === '/api/patterns') return json(PATTERNS);
    if (path === '/api/assignments' && init.method !== 'POST') return json({ assignments: [] });
    if (path === '/api/assignments' && init.method === 'POST') {
      bodies.push(typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined);
      return json({ assignmentId: 'as1', status: 'open', phase: 'planned', warnings: [] }, 201);
    }
    if (path === '/api/assignments/solo') {
      bodies.push(typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined);
      return json({ assignmentId: 'as1', sessionId: 'se1', warnings: [] }, 201);
    }
    if (path.endsWith('/validate')) {
      // One gate-liable tool, so the template's `preGrantTools` has a chip to
      // arrive ticked on — a pre-grant never creates a chip, it only ticks one.
      return json({
        agentId: 'priya',
        projectId: 'lpm',
        effective: { mode: 'default', allow: [], deny: [], ask: [], elevation: null },
        gateLiable: [{ tool: 'Write', reason: 'not_auto_allowed', remembered: false }],
        diagnostics: [],
      });
    }
    if (path.startsWith('/api/projects/')) {
      const id = path.slice('/api/projects/'.length);
      const project = projects.find((one) => one.id === id);
      return project === undefined
        ? json({ error: 'not_found', message: 'no such project' }, 404)
        : json({ ...project, defaults: { agentIds: [] } });
    }
    if (path.startsWith('/api/sessions/')) {
      return json({ error: 'not_found', message: 'no session yet' }, 404);
    }
    if (path.endsWith('/avatar')) return new Response(new Blob(['png']), { status: 200 });
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
  return { respond, bodies };
}

function openFlow(intent: StartWorkIntent): void {
  useAppStore.getState().openStartWork(intent);
}

beforeEach(() => {
  useAppStore.getState().closeStartWork();
});

async function flow(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: 'Start work' });
}

/**
 * The task box.
 *
 * Named by the trailing "do?" rather than by the whole label: §6 puts the
 * agent's name in it ("What should **Priya** do?") and reads "they" for the
 * instant before the roster query answers, and the template strip's own source
 * input starts with the same three words.
 */
function taskOf(dialog: HTMLElement): HTMLTextAreaElement {
  return within(dialog).getByRole('textbox', { name: /do\?$/u });
}

// ---------------------------------------------------------------------------

describe('the substitution rule is roster’s (WO5)', () => {
  it('agrees with roster’s own renderer, placeholder for placeholder', () => {
    const cases: readonly [string, { slug?: string; source?: string }][] = [
      ['Work {{source}} into {{slug}}', { source: 'the queue', slug: 'answer-1' }],
      ['Nothing to substitute', {}],
      ['A {{soruce}} typo survives', { source: 'x' }],
      ['{{ source }} tolerates spaces', { source: 'x' }],
      ['{{source}} with nothing supplied', {}],
    ];
    for (const [text, values] of cases) {
      expect(renderTemplateText(text, values)).toBe(rosterRender(text, values));
    }
  });

  it('builds the same slug the untemplated default builds its directory from', () => {
    // ui §6's default is `docs/assignments/<slug>-<shortId>/DRAFT.md`, so a
    // template that writes `docs/assignments/{{slug}}/…` lands beside it rather
    // than in a parallel tree.
    expect(templateSlug('Improve the Site Telemetry page', 'ab12cd')).toBe(
      'improve-the-site-telemetry-page-ab12cd',
    );
    expect(templateSlug('', '')).toBe('assignment');
  });

  it('renders the extra input only for a template that mentions {{source}}', () => {
    expect(usesSource(TODO)).toBe(true);
    expect(usesSource(EMAIL)).toBe(false);
    expect(usesSource(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('the blank card (WO5: today’s flow, exactly)', () => {
  it('is first, chosen, and leaves every field empty', async () => {
    mount(<App />, { respond: serving({ templates: [TODO, EMAIL] }).respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', workItemIds: [], origin: 'drag' });
    const dialog = await flow();

    const cards = await within(dialog).findAllByRole('radio', { name: /Blank|Reply|Draft/u });
    // Blank first, and the one that is chosen.
    expect(cards[0]).toBeChecked();
    expect(
      within(dialog).getByText('Describe the task yourself, as always.'),
    ).toBeInTheDocument();
    expect(taskOf(dialog).value).toBe('');
    // No source input until a template asks for one.
    expect(dialog.querySelector('[data-control="template-source"]')).toBeNull();
  });

  it('is the whole strip when the core serves no templates route', async () => {
    mount(<App />, { respond: serving({ templates: undefined }).respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', workItemIds: [], origin: 'drag' });
    const dialog = await flow();

    await within(dialog).findByRole('textbox', { name: /do\?$/u });
    // The strip does not render at all — the dialog is yesterday's dialog.
    expect(within(dialog).queryByText('Start from')).toBeNull();
    expect(taskOf(dialog).value).toBe('');
  });

  it('takes back what a template filled in when it is chosen again', async () => {
    const user = userEvent.setup();
    mount(<App />, { respond: serving({ templates: [TODO] }).respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', workItemIds: [], origin: 'drag' });
    const dialog = await flow();

    await user.click(await within(dialog).findByRole('radio', { name: /Reply to todo tickets/u }));
    await waitFor(() => expect(taskOf(dialog).value).toContain('Work the open items in'));

    await user.click(within(dialog).getByRole('radio', { name: /Blank/u }));
    await waitFor(() => expect(taskOf(dialog).value).toBe(''));
  });
});

// ---------------------------------------------------------------------------

describe('picking a template prefills the flow (WO5)', () => {
  it('fills the goal, tracks the source input, and stops at the first keystroke', async () => {
    const user = userEvent.setup();
    mount(<App />, { respond: serving({ templates: [TODO] }).respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', workItemIds: [], origin: 'drag' });
    const dialog = await flow();

    await user.click(await within(dialog).findByRole('radio', { name: /Reply to todo tickets/u }));

    // The goal arrives, with the unfilled `{{source}}` collapsed to nothing
    // rather than left as braces.
    await waitFor(() => expect(taskOf(dialog).value).toBe('Work the open items in : draft a reply for each.'));

    const source = within(dialog).getByLabelText('What should they work from?');
    await user.type(source, 'docs/todo.md');
    await waitFor(() =>
      expect(taskOf(dialog).value).toBe(
        'Work the open items in docs/todo.md: draft a reply for each.',
      ),
    );

    // The first keystroke in the task box ends the derivation for good.
    await user.clear(taskOf(dialog));
    await user.type(taskOf(dialog), 'my own words');
    await user.type(source, ' and more');
    expect(taskOf(dialog).value).toBe('my own words');
  });

  it('sets the write toggle from the template', async () => {
    const user = userEvent.setup();
    mount(<App />, { respond: serving({ templates: [TODO] }).respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', workItemIds: [], origin: 'drag' });
    const dialog = await flow();

    const write = within(dialog).getByRole('checkbox', { name: /Let them write to the project/u });
    expect(write).not.toBeChecked();
    await user.click(await within(dialog).findByRole('radio', { name: /Reply to todo tickets/u }));
    await waitFor(() => expect(write).toBeChecked());
  });

  it('opens a pair template on the pair radio, with the template’s artifact path', async () => {
    const user = userEvent.setup();
    mount(<App />, { respond: serving({ templates: [EMAIL] }).respond });
    // Two agents, so `pair` is on offer at all.
    openFlow({ agentIds: ['priya', 'marcus'], projectId: 'lpm', workItemIds: [], origin: 'drag' });
    const dialog = await flow();

    await user.click(await within(dialog).findByRole('radio', { name: /Draft email replies/u }));

    await waitFor(() =>
      expect(
        within(dialog).getByRole('radio', { name: /adversarial pair/u }),
      ).toBeChecked(),
    );

    // The template's own path replaces the generic `…/DRAFT.md` default.
    const artifact = within(dialog).getByLabelText<HTMLInputElement>('Artifact path');
    expect(artifact.value).toMatch(/^docs\/assignments\/.+\/email-drafts\.md$/u);
    expect(artifact.value).not.toContain('DRAFT.md');
  });

  it('ticks the template’s pre-grant chips and sends them with the create call', async () => {
    const user = userEvent.setup();
    const { respond, bodies } = serving({ templates: [TODO] });
    mount(<App />, { respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', workItemIds: [], origin: 'drag' });
    const dialog = await flow();

    await user.click(await within(dialog).findByRole('radio', { name: /Reply to todo tickets/u }));

    const chip = await within(dialog).findByRole('checkbox', { name: 'Pre-allow Write for Priya' });
    await waitFor(() => expect(chip).toBeChecked());
    // Why it arrived ticked, said out loud.
    expect(within(dialog).getByText('from the template')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /Start work/u }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      agentId: 'priya',
      // Provenance, recorded (orchestrator §2.3).
      templateId: 'todo-ticket-replies',
      write: true,
      preGrants: [{ agentId: 'priya', tool: 'Write' }],
    });
  });
});

// ---------------------------------------------------------------------------

describe('the missing-connector warning (WO5: it warns, it never gates)', () => {
  it('names the agent and links into the MCP integrations editor', async () => {
    const user = userEvent.setup();
    mount(<App />, { respond: serving({ templates: [EMAIL] }).respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', workItemIds: [], origin: 'drag' });
    const dialog = await flow();

    await user.click(await within(dialog).findByRole('radio', { name: /Draft email replies/u }));

    const warning = await waitFor(() => {
      const found = dialog.querySelector('[data-connector-gap="priya"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(warning.textContent).toContain('Priya has no gmail connector');
    // The link goes to the agent's own page, where the integrations panel lives
    // (ui §7.3.1) — a warning that does not say where to fix it gets ignored.
    expect(within(warning).getByRole('link', { name: 'Add one' })).toHaveAttribute(
      'href',
      '/agents/priya',
    );
    // And it is advice, not a blocker.
    expect(within(dialog).getByRole('button', { name: /Start work|Review/u })).toBeEnabled();
  });

  it('says nothing about an agent that carries the connector', async () => {
    const user = userEvent.setup();
    mount(<App />, { respond: serving({ templates: [EMAIL] }).respond });
    openFlow({ agentIds: ['marcus'], projectId: 'lpm', workItemIds: [], origin: 'drag' });
    const dialog = await flow();

    await user.click(await within(dialog).findByRole('radio', { name: /Draft email replies/u }));
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: /Blank/u })).not.toBeChecked());
    expect(dialog.querySelector('[data-connector-gap]')).toBeNull();
  });
});
