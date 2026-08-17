/**
 * The agent wizard (ui IMPLEMENTATION §8).
 *
 * Criteria here, each as a named test:
 *
 * - the flow from **New agent** to a saved card is describe → draft → Save, with
 *   no edits — the machine half of "under a minute" (the human half is on the
 *   manual list, `M8-under-a-minute`);
 * - a `degraded: true` response renders every partial field **editable** with the
 *   plain explanation, and the agent can still be saved;
 * - **Redraft never overwrites in-progress edits without an explicit swap**;
 * - a `replace` persona mode surfaces roster's warning verbatim.
 *
 * The two round-trip criteria — byte-equality on save and the skill stub on disk
 * — need a real core and are `web/e2e/agent.test.ts`.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../App';
import { anAgent, json, mount, type Responder } from '../../test/harness';
import type { DraftResponse } from '../api/types';
import { useAppStore } from '../state/store';

afterEach(() => useAppStore.getState().reset());

const DRAFT: DraftResponse = {
  draft: {
    name: 'Priya',
    specialty: 'bug-patching',
    tagline: 'Reproduces first, then fixes.',
    persona: { mode: 'append', file: 'persona.md' },
    model: { primary: 'sonnet' },
    permissions: { mode: 'acceptEdits', allow: ['Read', 'Edit'] },
    capabilities: { overseer: false, roles: ['implementer'] },
  },
  persona: '# Priya\n\nWrite a failing test first.\n',
  rationale: {
    permissions: 'Edit is auto-approved because the work is patching, and push is denied.',
    persona: 'Append, so Claude Code’s own coding guidance is kept.',
  },
  suggestedSkills: [{ name: 'triage-a-stack-trace', description: 'Read a PHP trace.' }],
  suggestedIntegrations: [
    { name: 'sentry', why: 'It watches the 500s.', secretRef: 'integration.sentry.token' },
  ],
  warnings: [],
  degraded: false,
};

interface Fixture {
  readonly drafts?: readonly DraftResponse[];
  readonly createRefusal?: { status: number; body: unknown };
}

function serving(fixture: Fixture = {}) {
  const posted: { path: string; body: unknown }[] = [];
  let draftTurn = 0;
  const drafts = fixture.drafts ?? [DRAFT];

  const respond: Responder = (url, init) => {
    const path = url.split('?')[0] ?? url;
    if (init.method === 'POST') {
      posted.push({
        path,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
    }
    if (path === '/api/roster/draft') {
      const answer = drafts[Math.min(draftTurn, drafts.length - 1)] ?? DRAFT;
      draftTurn += 1;
      return json(answer);
    }
    if (path === '/api/roster/agents' && init.method === 'POST') {
      if (fixture.createRefusal !== undefined) {
        return json(fixture.createRefusal.body, fixture.createRefusal.status);
      }
      return json(anAgent({ id: 'priya', name: 'Priya' }), 201);
    }
    if (path === '/api/roster/agents') return json({ agents: [], diagnostics: [] });
    if (path === '/api/roster/agents/priya') return json(anAgent({ id: 'priya', name: 'Priya' }));
    if (path === '/api/sessions') return json({ sessions: [], next: null });
    if (path === '/api/projects') return json({ projects: [] });
    if (path === '/api/orchestrator/status') {
      return json({
        agents: [],
        assignments: { open: 0, halted: 0, awaitingUser: 0 },
        questions: { open: 0, oldestOpenedAt: null },
      });
    }
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
  return { respond, posted };
}

function openWizard(fixture: Fixture = {}) {
  const api = serving(fixture);
  const mounted = mount(<App />, { respond: api.respond, route: '/agents/new' });
  return { ...mounted, posted: api.posted };
}

const DESCRIPTION = 'Someone who patches our PHP 500s but writes a failing test first';

describe('describe → draft → save (§7.1)', () => {
  it('reaches a saved agent from one sentence with no edits', async () => {
    const view = openWizard();
    const user = userEvent.setup();

    const description = await screen.findByLabelText('Describe them in a sentence');
    expect(description).toHaveFocus();
    await user.type(description, DESCRIPTION);
    await user.click(screen.getByRole('button', { name: 'Draft this agent' }));

    // Step 3 comes back prefilled; nothing else is typed.
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Priya'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(view.posted.map((call) => call.path)).toEqual([
        '/api/roster/draft',
        '/api/roster/agents',
      ]),
    );
    expect(view.posted[1]?.body).toMatchObject({
      name: 'Priya',
      specialty: 'bug-patching',
      meta: { origin: 'drafted' },
      personaText: '# Priya\n\nWrite a failing test first.\n',
    });
  });

  it('shows roster’s per-field-group rationale beside the groups', async () => {
    openWizard();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Describe them in a sentence'), DESCRIPTION);
    await user.click(screen.getByRole('button', { name: 'Draft this agent' }));

    expect(
      await screen.findByText(
        'Edit is auto-approved because the work is patching, and push is denied.',
      ),
    ).toHaveAttribute('data-rationale', 'true');
  });

  it('lists suggested integrations read-only, with the ref and never a value', async () => {
    openWizard();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Describe them in a sentence'), DESCRIPTION);
    await user.click(screen.getByRole('button', { name: 'Draft this agent' }));

    const entry = await screen.findByText('sentry');
    const row = entry.closest('li');
    expect(row?.textContent).toContain('integration.sentry.token');
    expect(row?.textContent).toContain('you will need to supply this credential');
    expect(row?.querySelector('input')).toBeNull();
  });
});

describe('a degraded draft is still an agent (§7.1)', () => {
  it('explains plainly, keeps every partial field editable, and still saves', async () => {
    const view = openWizard({
      drafts: [
        {
          ...DRAFT,
          degraded: true,
          draft: { name: 'Sam', specialty: 'research' },
          persona: '',
          rationale: {},
        },
      ],
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Describe them in a sentence'), DESCRIPTION);
    await user.click(screen.getByRole('button', { name: 'Draft this agent' }));

    const banner = await screen.findByText(/Claude couldn’t finish this draft/u);
    expect(banner).toHaveAttribute('data-degraded', 'true');

    // Every field is a real, enabled control — including the ones the model left
    // empty, which is the whole point of the graceful-degradation contract.
    for (const label of ['Name', 'Tagline', 'persona.md', 'allow', 'Alias or id']) {
      expect(screen.getByLabelText(label)).toBeEnabled();
    }
    await user.type(screen.getByLabelText('Tagline'), 'Reads before writing.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(view.posted.at(-1)?.path).toBe('/api/roster/agents'));
    expect(view.posted.at(-1)?.body).toMatchObject({
      name: 'Sam',
      tagline: 'Reads before writing.',
    });
  });
});

describe('redraft never overwrites silently (§7.1, roster §12.4)', () => {
  const FRESH: DraftResponse = {
    ...DRAFT,
    draft: { ...DRAFT.draft, name: 'Priyanka', tagline: 'Bisects first.' },
    persona: '# Priyanka\n',
  };

  it('presents the fresh draft beside the current one and warns about the cost', async () => {
    openWizard({ drafts: [DRAFT, FRESH] });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Describe them in a sentence'), DESCRIPTION);
    await user.click(screen.getByRole('button', { name: 'Draft this agent' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Priya'));

    await user.clear(screen.getByLabelText('Tagline'));
    await user.type(screen.getByLabelText('Tagline'), 'My own words.');
    await user.click(screen.getByRole('button', { name: 'Redraft' }));

    const aside = await screen.findByRole('complementary', { name: 'A fresh draft' });
    // Beside, not instead of: the form still holds what the user typed.
    expect(screen.getByLabelText('Tagline')).toHaveValue('My own words.');
    expect(screen.getByLabelText('Name')).toHaveValue('Priya');
    expect(within(aside).getByText('Priyanka')).toBeInTheDocument();
    expect(screen.getByText(/Using the fresh draft replaces your edits/u)).toBeInTheDocument();
  });

  it('swaps only on an explicit click, and keeping the edits discards the draft', async () => {
    openWizard({ drafts: [DRAFT, FRESH] });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Describe them in a sentence'), DESCRIPTION);
    await user.click(screen.getByRole('button', { name: 'Draft this agent' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Priya'));
    await user.click(screen.getByRole('button', { name: 'Redraft' }));
    await screen.findByRole('complementary', { name: 'A fresh draft' });

    await user.click(screen.getByRole('button', { name: 'Keep my edits' }));
    expect(screen.queryByRole('complementary', { name: 'A fresh draft' })).toBeNull();
    expect(screen.getByLabelText('Name')).toHaveValue('Priya');

    await user.click(screen.getByRole('button', { name: 'Redraft' }));
    await screen.findByRole('complementary', { name: 'A fresh draft' });
    await user.click(screen.getByRole('button', { name: 'Use the fresh draft' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Priyanka'));
  });

  it('sends the current edits as context, never as something to merge', async () => {
    // roster §12.1: `currentDraft` "only shapes the next prompt" — it is never
    // merged server-side, and the UI does not merge it either.
    const view = openWizard({ drafts: [DRAFT, FRESH] });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Describe them in a sentence'), DESCRIPTION);
    await user.click(screen.getByRole('button', { name: 'Draft this agent' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Priya'));
    await user.click(screen.getByRole('button', { name: 'Redraft' }));

    await waitFor(() => expect(view.posted).toHaveLength(2));
    expect(view.posted[1]).toMatchObject({
      path: '/api/roster/draft',
      body: { description: DESCRIPTION, currentDraft: { name: 'Priya' } },
    });
  });
});

describe('warnings and the replace persona mode (§7.1)', () => {
  it('renders roster’s warnings verbatim', async () => {
    const warning =
      'Suggested `replace` persona mode — this agent will not receive Claude Code’s coding ' +
      'guidance (DESIGN §5).';
    openWizard({
      drafts: [
        {
          ...DRAFT,
          warnings: [warning],
          draft: { ...DRAFT.draft, persona: { mode: 'replace', file: 'persona.md' } },
        },
      ],
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Describe them in a sentence'), DESCRIPTION);
    await user.click(screen.getByRole('button', { name: 'Draft this agent' }));

    // Verbatim: not paraphrased, not shortened (§3.1).
    expect(
      await screen.findByText(warning, { selector: '[data-warning="draft"]' }),
    ).toBeInTheDocument();
  });

  it('says the same thing when the user picks replace themselves', async () => {
    openWizard();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Describe them in a sentence'), DESCRIPTION);
    await user.click(screen.getByRole('button', { name: 'Draft this agent' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Priya'));

    await user.selectOptions(screen.getByLabelText('Persona mode'), 'replace');

    const note = await screen.findByText(/will not receive Claude Code’s coding guidance/u);
    expect(note).toHaveAttribute('data-warning', 'persona-replace');
  });
});
