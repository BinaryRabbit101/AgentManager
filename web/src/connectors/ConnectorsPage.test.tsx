/**
 * The Connectors page (ui DESIGN §7.4, roster DESIGN §10.3, WO4).
 *
 * The criteria here are the owner's complaint, turned into claims:
 *
 * - a connector is **created here**, once, with a body roster accepts;
 * - the page says **who is using it**, and links to them;
 * - it is **assigned** by an ordinary agent `PATCH` carrying `{ connector: id }`
 *   under the connector's id — and unassigned by the same route;
 * - an agent that already has a *different* server under that name is **refused
 *   inline**, not silently renamed;
 * - a delete refused with a 409 renders the blocking agents **as links**,
 *   because going and detaching it is the next thing to do;
 * - no credential **value** appears anywhere: the page shows the `secretRef`
 *   name and the CLI verb that stores it (foundation §3.5).
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../App';
import { anAgent, json, mount, type Responder } from '../../test/harness';
import type { AgentView } from '../api/types';
import { useAppStore } from '../state/store';

afterEach(() => useAppStore.getState().reset());

const GMAIL = {
  id: 'shared-gmail',
  label: 'Gmail (work)',
  description: 'The team mailbox.',
  transport: 'stdio' as const,
  toolPrefix: 'mcp__shared-gmail__',
  auth: 'credentials' as const,
  credentials: [{ secretRef: 'mcp.shared-gmail.token', resolved: false }],
  usedBy: ['priya'],
  config: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gmail'],
    env: { GMAIL_TOKEN: { secretRef: 'mcp.shared-gmail.token' } },
  },
  meta: { createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
};

interface Fixture {
  readonly connectors?: readonly unknown[];
  readonly agents?: readonly AgentView[];
  /** What `DELETE` answers with; a 200 unless a case wants the 409. */
  readonly deleteWith?: { readonly status: number; readonly body: unknown };
}

function serving(fixture: Fixture = {}) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const agents = fixture.agents ?? [
    anAgent({
      id: 'priya',
      name: 'Priya',
      integrations: { 'shared-gmail': { connector: 'shared-gmail' } },
    }),
    anAgent({ id: 'sam', name: 'Sam' }),
  ];

  const respond: Responder = (url, init) => {
    const path = url.split('?')[0] ?? url;
    const method = init.method ?? 'GET';
    if (method !== 'GET') {
      calls.push({
        path,
        method,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
    }

    if (path === '/api/roster/connectors' && method === 'GET') {
      return json({ connectors: fixture.connectors ?? [GMAIL], diagnostics: [] });
    }
    if (path === '/api/roster/connectors' && method === 'POST') return json(GMAIL, 201);
    if (path.startsWith('/api/roster/connectors/') && method === 'DELETE') {
      const answer = fixture.deleteWith ?? {
        status: 200,
        body: { connectorId: 'shared-gmail', removed: true },
      };
      return json(answer.body, answer.status);
    }
    if (path.startsWith('/api/roster/connectors/') && method === 'PATCH') return json(GMAIL);
    if (path === '/api/roster/agents') return json({ agents, diagnostics: [] });
    if (path.startsWith('/api/roster/agents/') && method === 'PATCH') return json(agents[0]);
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };

  return { respond, calls };
}

function at(fixture: ReturnType<typeof serving>) {
  return mount(<App />, { respond: fixture.respond, route: '/connectors' });
}

describe('the list (§7.4)', () => {
  it('renders each connector with its prefix, credential badge and used-by links', async () => {
    at(serving());

    const card = await screen.findByText('Gmail (work)');
    const row = card.closest('li');
    expect(row).not.toBeNull();
    const scope = within(row as HTMLElement);

    expect(scope.getByText('shared-gmail')).toBeInTheDocument();
    expect(scope.getByText('stdio')).toBeInTheDocument();
    expect(scope.getByText('mcp__shared-gmail__*')).toBeInTheDocument();

    // The credential is a *name* and the fix is the documented CLI verb. The
    // page has no route that could return a value, so there is nothing to leak.
    expect(scope.getByText('needs credential')).toBeInTheDocument();
    expect(
      scope.getByText('agentmanager secrets set mcp.shared-gmail.token --stdin'),
    ).toBeInTheDocument();

    // "used by" is the same answer DELETE refuses on, rendered as somewhere to go.
    expect(scope.getByRole('link', { name: 'Priya' })).toHaveAttribute('href', '/agents/priya');
  });

  it('teaches what a connector is when the library is empty', async () => {
    at(serving({ connectors: [] }));
    expect(await screen.findByText(/No connectors yet/u)).toBeInTheDocument();
    expect(
      screen.getByText(/An agent can still carry a one-off server of its own/u),
    ).toBeInTheDocument();
  });
});

describe('create (§7.4)', () => {
  it('posts an id, a label and a §10 config', async () => {
    const fixture = serving({ connectors: [] });
    at(fixture);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'New connector' }));
    await user.type(screen.getByLabelText('Label'), 'Todo');
    await user.type(screen.getByLabelText('Connector id'), 'todo');
    await user.type(screen.getByLabelText('Command'), 'npx');
    await user.click(screen.getByRole('button', { name: 'Create connector' }));

    await waitFor(() => expect(fixture.calls).toHaveLength(1));
    expect(fixture.calls[0]).toMatchObject({
      path: '/api/roster/connectors',
      method: 'POST',
      body: {
        id: 'todo',
        label: 'Todo',
        config: { transport: 'stdio', command: 'npx', toolPrefixHint: 'mcp__todo__' },
      },
    });
  });

  it('warns a credential-shaped literal in the field, by the editor’s own rules', async () => {
    at(serving({ connectors: [] }));
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'New connector' }));
    await user.type(screen.getByLabelText('Connector id'), 'todo');
    await user.type(screen.getByLabelText('Command'), 'npx');
    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    await user.type(screen.getByLabelText('Variable'), 'TODO_TOKEN');
    await user.type(screen.getByLabelText('Value'), 'sk-live-1234');

    expect(await screen.findByText(/is credential-shaped/u)).toBeInTheDocument();
  });
});

describe('assign to agents (§7.4)', () => {
  it('patches the toggled agent with { connector } under the connector’s id', async () => {
    const fixture = serving();
    at(fixture);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Assign to agents…' }));
    // Priya already references it and arrives ticked; Sam does not.
    expect(await screen.findByLabelText('Priya')).toBeChecked();
    await user.click(screen.getByLabelText('Sam'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(fixture.calls).toHaveLength(1));
    expect(fixture.calls[0]).toEqual({
      path: '/api/roster/agents/sam',
      method: 'PATCH',
      body: { integrations: { 'shared-gmail': { connector: 'shared-gmail' } } },
    });
  });

  it('unticking removes the reference, and an emptied record is sent as null', async () => {
    const fixture = serving();
    at(fixture);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Assign to agents…' }));
    await user.click(await screen.findByLabelText('Priya'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(fixture.calls).toHaveLength(1));
    // `null` is roster's spelling of "clear this field" (§9.1) — an empty object
    // would declare zero integrations, which is a different statement.
    expect(fixture.calls[0]).toEqual({
      path: '/api/roster/agents/priya',
      method: 'PATCH',
      body: { integrations: null },
    });
  });

  it('refuses inline when an agent already has a different server under that name', async () => {
    const fixture = serving({
      agents: [
        anAgent({
          id: 'sam',
          name: 'Sam',
          integrations: { 'shared-gmail': { transport: 'stdio', command: 'other' } },
        }),
      ],
    });
    at(fixture);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Assign to agents…' }));

    expect(await screen.findByLabelText('Sam')).toBeDisabled();
    expect(
      screen.getByText(/already has a different server called “shared-gmail”/u),
    ).toBeInTheDocument();
    // Nothing was written: the refusal is the outcome, not a partial apply.
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(fixture.calls).toEqual([]);
  });
});

describe('delete (§7.4, roster §10.3)', () => {
  it('lists the blocking agents as links when roster refuses with a 409', async () => {
    const fixture = serving({
      deleteWith: {
        status: 409,
        body: {
          error: 'connector_in_use',
          message: 'Connector "shared-gmail" is referenced by 1 agent(s): priya.',
          connectorId: 'shared-gmail',
          agentIds: ['priya'],
        },
      },
    });
    at(fixture);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('Still referenced by');
    expect(within(notice).getByRole('link', { name: 'Priya' })).toHaveAttribute(
      'href',
      '/agents/priya',
    );
  });

  it('deletes when nothing references it', async () => {
    const fixture = serving({ connectors: [{ ...GMAIL, usedBy: [] }] });
    at(fixture);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(fixture.calls).toContainEqual({
        path: '/api/roster/connectors/shared-gmail',
        method: 'DELETE',
        body: undefined,
      }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('paste-import, one level up (§7.4)', () => {
  const PASTED = JSON.stringify({
    mcpServers: { todo: { command: 'npx', args: ['-y', 'server-todo'] } },
  });

  it('creates a library connector per pasted server rather than adding it to an agent', async () => {
    const fixture = serving({ connectors: [] });
    at(fixture);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Import from .mcp.json' }));
    // `{` and `[` are `userEvent.type`'s own escapes, so they are doubled — the
    // textarea still receives the JSON exactly as it was written above.
    await user.type(
      screen.getByLabelText('.mcp.json'),
      PASTED.replaceAll('{', '{{').replaceAll('[', '[['),
    );
    await user.click(screen.getByRole('button', { name: 'Preview the mapping' }));
    await user.click(
      await screen.findByRole('button', { name: 'Create 1 connector in the library' }),
    );

    await waitFor(() => expect(fixture.calls).toHaveLength(1));
    expect(fixture.calls[0]).toMatchObject({
      path: '/api/roster/connectors',
      method: 'POST',
      body: { id: 'todo', config: { command: 'npx', args: ['-y', 'server-todo'] } },
    });
  });
});
