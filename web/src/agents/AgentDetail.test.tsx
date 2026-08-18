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
 *   roster's `/validate` and nothing else (§4);
 * - **integrations are visible and editable** (§7.3, roster §10) — add, edit and
 *   remove round-trip through the same whole-agent PATCH every other field
 *   takes, a `secretRef` is rendered as a *name* and never as a value, and the
 *   connectors summary answers "what can this agent reach" at a glance.
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

// ---------------------------------------------------------------------------
// Integrations (§7.3, roster §10)
// ---------------------------------------------------------------------------

const GMAIL = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server-gmail'],
  env: { GMAIL_TOKEN: { secretRef: 'mcp.gmail.token' }, GMAIL_USER: 'me@example.com' },
  toolPrefixHint: 'mcp__gmail__',
};

function withGmail(extra: Partial<Parameters<typeof anAgent>[0]> = {}) {
  return anAgent({ id: 'priya', name: 'Priya', integrations: { gmail: GMAIL }, ...extra });
}

/** The `integrations` object from the last PATCH the page sent. */
function patchedIntegrations(calls: { path: string; method: string; body: unknown }[]): unknown {
  const patch = calls.filter((call) => call.method === 'PATCH').at(-1);
  return (patch?.body as Record<string, unknown> | undefined)?.['integrations'];
}

describe('the integrations panel (§7.3)', () => {
  it('shows the agent’s servers, their tool prefix, and the ref by name only', async () => {
    open({ agent: withGmail() });

    const panel = await screen.findByRole('group', { name: 'Integrations' });
    expect(within(panel).getByLabelText('Server name')).toHaveValue('gmail');
    expect(within(panel).getByLabelText('Command')).toHaveValue('npx');
    expect(within(panel).getByLabelText('Arguments (one per line)')).toHaveValue(
      '-y\nserver-gmail',
    );
    // The prefix every permission rule for this server has to start with.
    expect(panel.textContent).toContain('mcp__gmail__*');
    // A ref renders as its own name; there is no value in the wire shape to render.
    expect(within(panel).getByLabelText('Secret reference')).toHaveValue('mcp.gmail.token');
    expect(within(panel).getByLabelText('Value')).toHaveValue('me@example.com');
  });

  it('says out loud that an agent does not inherit the owner’s personal Claude config (roster §7.3)', async () => {
    open({ agent: withGmail() });
    const panel = await screen.findByRole('group', { name: 'Integrations' });
    expect(panel.textContent).toContain('don’t inherit your personal Claude config');
  });

  it('badges an unresolved ref and offers the stdin command, never a value', async () => {
    open({
      agent: withGmail({
        credentials: [{ integration: 'gmail', secretRef: 'mcp.gmail.token', resolved: false }],
      }),
    });

    const panel = await screen.findByRole('group', { name: 'Integrations' });
    expect(within(panel).getByText('needs credential')).toBeInTheDocument();
    expect(panel.textContent).toContain('agentmanager secrets set mcp.gmail.token --stdin');
  });

  it('edits a server and posts the exact shape roster’s schema wants', async () => {
    const view = open({ agent: withGmail() });
    const user = userEvent.setup();

    const panel = await screen.findByRole('group', { name: 'Integrations' });
    await user.clear(within(panel).getByLabelText('Command'));
    await user.type(within(panel).getByLabelText('Command'), 'node');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchedIntegrations(view.calls)).toBeDefined());
    expect(patchedIntegrations(view.calls)).toEqual({
      gmail: { ...GMAIL, command: 'node' },
    });
  });

  it('adds a connector with a secret header and posts a ref, not a value', async () => {
    const view = open({ agent: anAgent({ id: 'priya', name: 'Priya' }) });
    const user = userEvent.setup();

    const panel = await screen.findByRole('group', { name: 'Integrations' });
    expect(within(panel).getByText(/No connectors/u)).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Add a connector' }));
    const card = await screen.findByRole('group', { name: 'New connector' });
    await user.type(within(card).getByLabelText('Server name'), 'docs');
    await user.selectOptions(within(card).getByLabelText('Transport'), 'http');

    const named = await screen.findByRole('group', { name: 'docs' });
    await user.type(within(named).getByLabelText('URL'), 'https://mcp.example.com/mcp');
    await user.click(within(named).getByRole('button', { name: 'Add header' }));
    await user.type(within(named).getByLabelText('Header'), 'Authorization');
    // Ticking `secret` proposes the conventional ref rather than reusing a
    // literal that was typed into a value box.
    await user.click(within(named).getByRole('checkbox', { name: 'secret' }));

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchedIntegrations(view.calls)).toBeDefined());
    expect(patchedIntegrations(view.calls)).toEqual({
      docs: {
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: { secretRef: 'mcp.docs.authorization' } },
        toolPrefixHint: 'mcp__docs__',
      },
    });
  });

  it('removes the last connector by sending null, which is how roster spells "clear"', async () => {
    const view = open({ agent: withGmail() });
    const user = userEvent.setup();

    const panel = await screen.findByRole('group', { name: 'Integrations' });
    await user.click(within(panel).getByRole('button', { name: 'Remove connector' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(view.calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(patchedIntegrations(view.calls)).toBeNull();
  });

  it('warns in the field about a credential-shaped literal, where roster would refuse it', async () => {
    const view = open({ agent: withGmail() });
    const user = userEvent.setup();

    const panel = await screen.findByRole('group', { name: 'Integrations' });
    // Untick `secret` on the token: the value box empties, and the warning names
    // the key rather than waiting for a 400 after Save.
    await user.click(within(panel).getAllByRole('checkbox', { name: 'secret' })[0] as HTMLElement);

    await waitFor(() =>
      expect(within(panel).getByText(/GMAIL_TOKEN.*credential-shaped/su)).toBeInTheDocument(),
    );
    expect(view.calls.filter((call) => call.method === 'PATCH')).toEqual([]);
  });

  it('renders roster’s integration diagnostic beside the server rather than as a page banner', async () => {
    open({
      agent: withGmail({
        diagnostics: [
          {
            level: 'warn',
            code: 'roster.integration.no-allow-rule',
            message:
              'integration "gmail" is declared but no permission rule mentions mcp__gmail__*',
            path: 'integrations.gmail',
          },
        ],
      }),
    });

    const panel = await screen.findByRole('group', { name: 'Integrations' });
    expect(
      within(panel).getByText(/no permission rule mentions mcp__gmail__\*/u),
    ).toBeInTheDocument();
    // Once, not twice: the page-level list yields the ones it can place.
    expect(screen.getAllByText(/no permission rule mentions mcp__gmail__\*/u)).toHaveLength(1);
  });
});

describe('the paste-import (§7.3)', () => {
  const PASTED = JSON.stringify({
    mcpServers: {
      docs: {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer sk-live-value', 'X-Tenant': '${TENANT}' },
      },
    },
  });

  it('previews the mapping before anything is applied, and applies nothing until Save', async () => {
    const view = open({ agent: anAgent({ id: 'priya', name: 'Priya' }) });
    const user = userEvent.setup();

    const panel = await screen.findByRole('group', { name: 'Integrations' });
    await user.click(within(panel).getByRole('button', { name: 'Import from .mcp.json' }));
    const importer = await screen.findByRole('region', { name: 'Import from .mcp.json' });
    await user.type(within(importer).getByLabelText('.mcp.json'), PASTED.replaceAll('{', '{{'));
    await user.click(within(importer).getByRole('button', { name: 'Preview the mapping' }));

    // The alias roster does not accept is rewritten, and the rewrite is stated.
    expect(within(importer).getByText(/streamable-http is a .mcp.json alias/u)).toBeInTheDocument();
    // A live-looking bearer never leaves the textarea the owner pasted it into:
    // it is not in the mapping table, not in the flag copy, and not in the draft
    // those describe. (The textarea itself still holds what was typed, which is
    // the user's own text and not something the app repeated back.)
    const mapping = importer.querySelector('[data-import-flags="docs"]');
    expect(mapping?.textContent ?? '').not.toContain('sk-live-value');
    expect(importer.querySelector('.import__table')?.textContent ?? '').not.toContain(
      'sk-live-value',
    );
    // Nothing has been written, and nothing has even been added to the form yet.
    expect(view.calls.filter((call) => call.method === 'PATCH')).toEqual([]);

    await user.click(within(importer).getByRole('button', { name: 'Add 1 connector' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchedIntegrations(view.calls)).toBeDefined());
    expect(patchedIntegrations(view.calls)).toEqual({
      docs: {
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: {
          // The credential-shaped key is a ref by force (roster §10)…
          Authorization: { secretRef: 'mcp.docs.authorization' },
          // …and the `${VAR}` is converted, because it does not expand in the
          // programmatic option the compiler uses.
          'X-Tenant': { secretRef: 'mcp.docs.x-tenant' },
        },
        toolPrefixHint: 'mcp__docs__',
      },
    });
  });

  it('will not let a credential-shaped key be kept as a literal, and will for a placeholder', async () => {
    open({ agent: anAgent({ id: 'priya', name: 'Priya' }) });
    const user = userEvent.setup();

    const panel = await screen.findByRole('group', { name: 'Integrations' });
    await user.click(within(panel).getByRole('button', { name: 'Import from .mcp.json' }));
    const importer = await screen.findByRole('region', { name: 'Import from .mcp.json' });
    await user.type(within(importer).getByLabelText('.mcp.json'), PASTED.replaceAll('{', '{{'));
    await user.click(within(importer).getByRole('button', { name: 'Preview the mapping' }));

    const required = importer.querySelector('[data-flag="Authorization"] input');
    const optional = importer.querySelector('[data-flag="X-Tenant"] input');
    expect(required).toBeDisabled();
    expect(optional).toBeEnabled();
  });
});

describe('the connectors summary (§7.3)', () => {
  it('answers "what can this agent reach" without scrolling into the form', async () => {
    open({
      agent: withGmail({
        credentials: [{ integration: 'gmail', secretRef: 'mcp.gmail.token', resolved: false }],
      }),
    });

    const summary = await screen.findByRole('region', { name: 'Connectors' });
    expect(within(summary).getByText('gmail')).toBeInTheDocument();
    expect(within(summary).getByText('mcp__gmail__*')).toBeInTheDocument();
    expect(within(summary).getByText('npx -y server-gmail')).toBeInTheDocument();
    expect(within(summary).getByText('mcp.gmail.token')).toBeInTheDocument();
    expect(within(summary).getByText('needs credential')).toBeInTheDocument();
  });

  it('says plainly when an agent has none, and why that is the default', async () => {
    open({ agent: anAgent({ id: 'priya', name: 'Priya' }) });
    const summary = await screen.findByRole('region', { name: 'Connectors' });
    expect(summary.textContent).toContain('does not inherit your personal Claude config');
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
