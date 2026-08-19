/**
 * The integrations panel's library half (ui DESIGN §7.3.1, roster §10.3, WO4).
 *
 * `AgentDetail.test.tsx` owns the inline server — add, edit, remove, and the
 * whole-agent PATCH they ride out on. This file owns the three things that only
 * exist because a connector can now be defined once and referenced: **attach**
 * from the library, **detach**, and **convert to inline copy**.
 *
 * The panel is mounted through the harness rather than bare, because the claim
 * being tested is precisely that it fetches the library *itself* — the editor
 * passes it nothing about connectors, and a test that handed it a list would
 * prove the wrong thing.
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { json, mount, type Responder } from '../../test/harness';

import { IntegrationsPanel } from './IntegrationsPanel';
import { integrationsBody, type IntegrationForm } from './integrationsModel';

const SHARED_GMAIL = {
  id: 'shared-gmail',
  label: 'Gmail (work)',
  transport: 'stdio' as const,
  toolPrefix: 'mcp__shared-gmail__',
  auth: 'credentials' as const,
  credentials: [{ secretRef: 'mcp.shared-gmail.token', resolved: false }],
  usedBy: [],
  config: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gmail'],
    env: { GMAIL_TOKEN: { secretRef: 'mcp.shared-gmail.token' } },
  },
  meta: { createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
};

function library(connectors: readonly unknown[] = [SHARED_GMAIL]): Responder {
  return (url) =>
    url.split('?')[0] === '/api/roster/connectors'
      ? json({ connectors, diagnostics: [] })
      : json({ error: 'not_found', message: 'no fixture' }, 404);
}

/** The panel under a tiny stateful holder, so edits are visible to the test. */
function open(initial: readonly IntegrationForm[] = [], respond = library()) {
  const held: { rows: readonly IntegrationForm[] } = { rows: initial };

  function Editing(): ReactElement {
    const [rows, setRows] = useState<readonly IntegrationForm[]>(initial);
    held.rows = rows;
    return <IntegrationsPanel integrations={rows} onChange={setRows} idPrefix="p" />;
  }

  mount(<Editing />, { respond });
  return {
    rows: (): readonly IntegrationForm[] => held.rows,
    body: (): Record<string, unknown> => integrationsBody(held.rows),
  };
}

describe('attach from the library (§7.3.1, roster §10.3)', () => {
  it('offers the library and appends a reference that serialises to { connector }', async () => {
    const view = open();
    const user = userEvent.setup();

    const select = await screen.findByLabelText('Attach from library');
    await user.selectOptions(select, 'shared-gmail');

    // The row is a reference, not a copy: nothing of the server's config is in
    // the definition this agent would save.
    expect(view.body()).toEqual({ 'shared-gmail': { connector: 'shared-gmail' } });
  });

  it('shows what the library holds, and links to where it is managed', async () => {
    open([
      {
        name: 'mail',
        transport: 'stdio',
        command: '',
        args: '',
        url: '',
        oauth: false,
        fields: [],
        connector: 'shared-gmail',
      },
    ]);

    expect(await screen.findByText('Gmail (work)')).toBeInTheDocument();
    expect(screen.getByText('stdio')).toBeInTheDocument();
    // The prefix is the *agent-local* name, which is the one thing the agent owns.
    expect(screen.getByText('mcp__mail__*')).toBeInTheDocument();
    // §10's secret idiom, unchanged by the connector living in the library.
    expect(screen.getByText('needs credential')).toBeInTheDocument();
    expect(
      screen.getByText('agentmanager secrets set mcp.shared-gmail.token --stdin'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Managed on the Connectors page' })).toHaveAttribute(
      'href',
      '/connectors',
    );
  });

  it('stops offering a connector this agent already references', async () => {
    open([
      {
        name: 'shared-gmail',
        transport: 'stdio',
        command: '',
        args: '',
        url: '',
        oauth: false,
        fields: [],
        connector: 'shared-gmail',
      },
    ]);
    await screen.findByText('Gmail (work)');
    // Nothing left to attach, so the control is not drawn at all rather than
    // drawn empty.
    expect(screen.queryByLabelText('Attach from library')).toBeNull();
  });

  it('detaches without touching the library', async () => {
    const view = open([
      {
        name: 'mail',
        transport: 'stdio',
        command: '',
        args: '',
        url: '',
        oauth: false,
        fields: [],
        connector: 'shared-gmail',
      },
    ]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Detach' }));
    expect(view.body()).toEqual({});
  });

  it('converts a reference into an editable copy of the library’s config', async () => {
    const view = open([
      {
        name: 'mail',
        transport: 'stdio',
        command: '',
        args: '',
        url: '',
        oauth: false,
        fields: [],
        connector: 'shared-gmail',
      },
    ]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Convert to inline copy' }));

    // The row is now an ordinary card holding what the library holds — under the
    // agent's own name, and with the credential still a *reference*.
    expect(await screen.findByLabelText('Server name')).toHaveValue('mail');
    expect(view.body()).toEqual({
      mail: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-gmail'],
        env: { GMAIL_TOKEN: { secretRef: 'mcp.shared-gmail.token' } },
        toolPrefixHint: 'mcp__mail__',
      },
    });
  });

  it('says so when the library no longer holds a referenced connector', async () => {
    open(
      [
        {
          name: 'mail',
          transport: 'stdio',
          command: '',
          args: '',
          url: '',
          oauth: false,
          fields: [],
          connector: 'gone',
        },
      ],
      library([]),
    );

    // Both halves: the panel-level problem (roster's `missing-connector`, said
    // early) and the row itself, which must not vanish — a dangling reference
    // with no visible cause is a launch refusal nobody can act on.
    await waitFor(() =>
      expect(screen.getByText(/references the library connector “gone”/u)).toBeInTheDocument(),
    );
    expect(screen.getByText(/The library has no connector called “gone”/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Convert to inline copy' })).toBeNull();
  });
});
