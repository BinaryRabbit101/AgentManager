/**
 * The agent detail page (ui IMPLEMENTATION §8).
 *
 * Criteria here:
 *
 * - **Duplicate** opens the editor on the *returned* definition, with the "cloned
 *   from" line and the shared-credentials note (the second, independent folder is
 *   asserted end to end in `web/e2e/agent.test.ts`);
 * - **Archive confirms with what is retained**;
 * - **purge is offered only when no session references the agent**;
 * - the effective-permissions preview against a chosen project comes from
 *   roster's `/validate` and nothing else (§4).
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../App';
import { anAgent, aProject, json, mount, type Responder } from '../../test/harness';
import type { AgentView, SessionRecord } from '../api/types';
import { useAppStore } from '../state/store';

afterEach(() => useAppStore.getState().reset());

function aSession(id: string): SessionRecord {
  return {
    id,
    assignmentId: 'as1',
    agentId: 'priya',
    projectId: 'lpm',
    status: 'done',
    sdkSessionId: null,
    model: null,
    permissionMode: null,
    origin: 'local',
    transcriptPath: 'C:\\t.jsonl',
    transcriptBytes: 10,
    summary: 'Fixed the 500',
    pinned: false,
    startedAt: null,
    endedAt: null,
    exitReason: null,
    role: null,
    resumedFrom: null,
    blockedReason: null,
    turns: 1,
  };
}

interface Fixture {
  readonly agent?: AgentView;
  readonly sessions?: readonly SessionRecord[];
  readonly duplicate?: AgentView;
  readonly validate?: { status: number; body: unknown };
}

function serving(fixture: Fixture = {}) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const agent = fixture.agent ?? anAgent({ id: 'priya', name: 'Priya' });

  const respond: Responder = (url, init) => {
    const [path, query] = url.split('?');
    const method = init.method ?? 'GET';
    if (method !== 'GET') {
      calls.push({
        path: query === undefined ? (path ?? '') : `${path ?? ''}?${query}`,
        method,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
    }
    if (path === '/api/roster/agents/priya' && method === 'GET') return json(agent);
    if (path === '/api/roster/agents/priya' && method === 'PATCH') return json(agent);
    if (path === '/api/roster/agents/priya' && method === 'DELETE') {
      return json({ agentId: 'priya', archivedAt: '2026-08-17T09:00:00.000Z', purged: false });
    }
    if (path === '/api/roster/agents/priya/duplicate') {
      return json(fixture.duplicate ?? anAgent({ id: 'priya-2', name: 'Priya copy' }), 201);
    }
    if (path === '/api/roster/agents/priya/validate') {
      const answer = fixture.validate ?? {
        status: 200,
        body: {
          effective: {
            mode: 'acceptEdits',
            allow: ['Read', 'Edit'],
            deny: ['Bash(git push*)'],
            ask: [],
            elevation: null,
          },
          diagnostics: [],
        },
      };
      return json(answer.body, answer.status);
    }
    if (path === '/api/roster/agents') return json({ agents: [agent], diagnostics: [] });
    if (path === '/api/roster/agents/priya-2') {
      return json(fixture.duplicate ?? anAgent({ id: 'priya-2', name: 'Priya copy' }));
    }
    if (path === '/api/sessions') return json({ sessions: fixture.sessions ?? [], next: null });
    if (path === '/api/projects') return json({ projects: [aProject({ id: 'lpm' })] });
    if (path === '/api/orchestrator/status') {
      return json({
        agents: [],
        assignments: { open: 0, halted: 0, awaitingUser: 0 },
        questions: { open: 0, oldestOpenedAt: null },
      });
    }
    return json({ error: 'not_found', message: `No fixture for ${path ?? ''}.` }, 404);
  };
  return { respond, calls };
}

function open(fixture: Fixture = {}) {
  const api = serving(fixture);
  const mounted = mount(<App />, { respond: api.respond, route: '/agents/priya' });
  return { ...mounted, calls: api.calls };
}

describe('duplicate-and-edit (§7.2)', () => {
  it('opens the editor on the returned definition, with the shared-credentials note', async () => {
    const clone = anAgent({ id: 'priya-2', name: 'Priya copy' });
    const withProvenance: AgentView = {
      ...clone,
      definition: {
        ...clone.definition,
        meta: { ...clone.definition.meta, duplicatedFrom: 'priya' },
      },
    };
    const view = open({ duplicate: withProvenance });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Duplicate' }));

    await waitFor(() =>
      expect(view.calls.map((call) => call.path)).toContain('/api/roster/agents/priya/duplicate'),
    );
    // The editor is now on the *clone*, not on a copy of this page's state.
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Priya copy'));
    const note = await screen.findByText(/Cloned from/u);
    expect(note).toHaveAttribute('data-cloned-from', 'priya');
    expect(note.textContent).toContain('same credentials');
  });
});

describe('archive and purge (§7.3)', () => {
  it('confirms with what is retained', async () => {
    open({ sessions: [aSession('se1')] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Archive' }));

    const dialog = await screen.findByRole('dialog', { name: 'Archive agent' });
    expect(dialog.textContent).toContain('history and transcripts are kept');
    expect(dialog.textContent).toContain('id is never reused');
  });

  it('withholds purge while a session references the agent, and says why', async () => {
    open({ sessions: [aSession('se1'), aSession('se2')] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Archive' }));

    const dialog = await screen.findByRole('dialog', { name: 'Archive agent' });
    expect(within(dialog).queryByRole('button', { name: 'Delete permanently' })).toBeNull();
    expect(dialog.textContent).toContain('2 sessions reference this agent');
  });

  it('offers purge behind a typed confirmation when nothing references it', async () => {
    const view = open({ sessions: [] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive agent' });

    const purge = within(dialog).getByRole('button', { name: 'Delete permanently' });
    expect(purge).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Agent name'), 'Priya');
    expect(purge).toBeEnabled();
    await user.click(purge);

    await waitFor(() =>
      expect(view.calls.at(-1)).toMatchObject({
        path: '/api/roster/agents/priya?purge=true',
        method: 'DELETE',
      }),
    );
  });

  it('archives without purging on the plain Archive button', async () => {
    const view = open({ sessions: [aSession('se1')] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive agent' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));

    await waitFor(() =>
      expect(view.calls.at(-1)).toMatchObject({
        path: '/api/roster/agents/priya',
        method: 'DELETE',
      }),
    );
  });
});

describe('the effective-permissions preview (§7.3)', () => {
  it('compiles against the chosen project through roster, and renders what came back', async () => {
    open();
    const user = userEvent.setup();

    await screen.findByRole('option', { name: 'lpm' });
    await user.selectOptions(screen.getByLabelText('Against project'), 'lpm');

    const panel = await screen.findByRole('region', { name: 'Effective permissions' });
    await waitFor(() => expect(within(panel).getByText('acceptEdits')).toBeInTheDocument());
    expect(within(panel).getByText('Read, Edit')).toBeInTheDocument();
    expect(within(panel).getByText('Bash(git push*)')).toBeInTheDocument();
  });

  it('shows roster’s refusal rather than guessing a set', async () => {
    open({
      validate: {
        status: 400,
        body: { error: 'unknown_project', message: 'No project "ghost" exists.' },
      },
    });
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'lpm' });
    await user.selectOptions(screen.getByLabelText('Against project'), 'lpm');

    expect(await screen.findByText('No project "ghost" exists.')).toBeInTheDocument();
  });
});

describe('the session history (§7.3)', () => {
  it('lists this agent’s sessions and links to each transcript', async () => {
    open({ sessions: [aSession('se1')] });
    const history = await screen.findByRole('region', { name: 'Sessions' });
    const link = within(history).getByRole('link', { name: 'Fixed the 500' });
    expect(link).toHaveAttribute('href', '/sessions/se1');
  });

  it('says so plainly when the agent has never run', async () => {
    open({ sessions: [] });
    const history = await screen.findByRole('region', { name: 'Sessions' });
    expect(within(history).getByText('This agent has not run yet.')).toBeInTheDocument();
  });
});

describe('role addenda (roster §4)', () => {
  it('shows a box per role, filled from the agent, and marks the unlisted ones', async () => {
    open({
      agent: anAgent({
        id: 'priya',
        name: 'Priya',
        roleAddenda: { skeptic: '## As the skeptic\n\nArgue against.\n' },
      }),
    });

    const addenda = await screen.findByRole('group', { name: 'Role addenda' });
    for (const role of ['implementer', 'architect', 'skeptic', 'reviewer', 'overseer']) {
      expect(within(addenda).getByLabelText(new RegExp(`^${role}`, 'u'))).toBeInTheDocument();
    }
    expect(within(addenda).getByLabelText(/^skeptic/u)).toHaveValue(
      '## As the skeptic\n\nArgue against.\n',
    );
    // The seat list and the addenda are independent (§4), and the form says so
    // rather than hiding the box for a role the agent is not listed for.
    expect(within(addenda).getByLabelText(/^skeptic/u)).toHaveAccessibleName(
      'skeptic (not a listed role)',
    );
  });

  it('posts an edited addendum verbatim, and null for one the user cleared', async () => {
    const view = open({
      agent: anAgent({
        id: 'priya',
        name: 'Priya',
        roleAddenda: { skeptic: 'to be cleared', reviewer: 'untouched' },
      }),
    });
    const user = userEvent.setup();

    const addenda = await screen.findByRole('group', { name: 'Role addenda' });
    await user.clear(within(addenda).getByLabelText(/^skeptic/u));
    await user.type(within(addenda).getByLabelText(/^architect/u), 'Draw the seams first.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(view.calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = view.calls.find((call) => call.method === 'PATCH');
    expect((patch?.body as Record<string, unknown>)['roleAddenda']).toEqual({
      skeptic: null,
      architect: 'Draw the seams first.',
      reviewer: 'untouched',
    });
  });
});
