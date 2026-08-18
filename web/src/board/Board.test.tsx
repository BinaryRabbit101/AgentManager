/**
 * The roster board, rendered (DESIGN §5.1, §5.2; IMPLEMENTATION §2).
 *
 * These mount the **whole app** rather than the `Board` component, because half
 * of what M2 promises is not inside the component: the live card update comes
 * through the event stream and §3.4's invalidation map, and the status pill is
 * folded into the store by the same wiring. A test that rendered `Board` with a
 * hand-built store would prove the markup and none of the behaviour.
 *
 * Only two seams are substituted — `fetch` and the SSE transport. Everything
 * else is the production path.
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { anAgent, aProject, BOOT_FACTS, json, mount, type Responder } from '../../test/harness';
import { App } from '../App';
import type { AgentView, Project } from '../api/types';

import { agentLabel, DELETED_AGENT_LABEL } from './AgentCard';

interface Fixture {
  readonly respond: Responder;
  set(next: { agents?: readonly AgentView[]; projects?: readonly Project[] }): void;
}

/** A responder whose roster can change under the client, as a file edit would. */
function serving(initial: {
  agents?: readonly AgentView[];
  projects?: readonly Project[];
  diagnostics?: readonly {
    level: 'error' | 'warn';
    code: string;
    message: string;
    agentId?: string;
  }[];
  avatar?: Blob;
}): Fixture {
  let agents = initial.agents ?? [];
  let projects = initial.projects ?? [];
  const respond: Responder = (url) => {
    const path = url.split('?')[0] ?? url;
    if (path === '/api/roster/agents') {
      return json({ agents, diagnostics: initial.diagnostics ?? [] });
    }
    if (path === '/api/projects') return json({ projects });
    if (path.endsWith('/avatar')) {
      return new Response(initial.avatar ?? new Blob(['png']), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
  return {
    respond,
    set: (next) => {
      if (next.agents !== undefined) agents = next.agents;
      if (next.projects !== undefined) projects = next.projects;
    },
  };
}

function card(name: string): HTMLElement {
  const link = screen.getByRole('link', { name });
  const host = link.closest('li');
  if (host === null) throw new Error(`"${name}" is not inside a card`);
  return host;
}

describe('the card grid and its three avatar kinds (§5.2)', () => {
  it('renders emoji, initials and a file avatar fetched to an object URL', async () => {
    const fixture = serving({
      agents: [
        anAgent({ id: 'priya', name: 'Priya', avatar: { kind: 'emoji', value: '🐛' } }),
        anAgent({
          id: 'sam',
          name: 'Sam Vale',
          avatar: { kind: 'initials', value: 'SV', color: '#123456' },
        }),
        anAgent({ id: 'pat', name: 'Pat', avatar: { kind: 'file', value: 'avatar.png' } }),
      ],
    });
    mount(<App />, { respond: fixture.respond });

    await waitFor(() => expect(screen.getByRole('link', { name: 'Priya' })).toBeInTheDocument());

    // Emoji, at its own kind, with the agent's name as the accessible name (§15).
    const emoji = within(card('Priya')).getByRole('img', { name: 'Priya' });
    expect(emoji).toHaveAttribute('data-kind', 'emoji');
    expect(emoji).toHaveTextContent('🐛');

    const initials = within(card('Sam Vale')).getByRole('img', { name: 'Sam Vale' });
    expect(initials).toHaveAttribute('data-kind', 'initials');
    expect(initials).toHaveTextContent('SV');

    // The `file` kind is the only one that touches the network, and it renders
    // from an object URL rather than from `<img src="/api/…">`.
    const file = within(card('Pat')).getByRole('img', { name: 'Pat' });
    expect(file).toHaveAttribute('data-kind', 'file');
    await waitFor(() => {
      const image = file.querySelector('img');
      expect(image?.getAttribute('src')).toMatch(/^blob:/u);
    });
  });

  it('falls back to initials from the name when a definition declares no avatar', async () => {
    const fixture = serving({ agents: [anAgent({ id: 'x', name: 'Ada Lovelace' })] });
    mount(<App />, { respond: fixture.respond });
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toHaveTextContent('AL'),
    );
  });

  it('shows the specialty word, the tagline, the overseer mark and the pin', async () => {
    const fixture = serving({
      agents: [
        anAgent({
          id: 'priya',
          name: 'Priya',
          specialty: 'bug-patching',
          tagline: 'Reproduces first, then fixes.',
          overseer: true,
          pinned: true,
        }),
      ],
    });
    mount(<App />, { respond: fixture.respond });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Priya' })).toBeInTheDocument());

    // §14.1: colour is never the only carrier — the word is always present.
    // (Scoped to the card: the specialty filter renders the same word as an
    // option, and matching that would prove nothing about the chip.)
    expect(within(card('Priya')).getByText('bug-patching')).toBeInTheDocument();
    expect(screen.getByText('Reproduces first, then fixes.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Overseer' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Pinned' })).toBeInTheDocument();
  });

  it('shows the needs-credential badge from roster’s own flag', async () => {
    const fixture = serving({
      agents: [anAgent({ id: 'priya', name: 'Priya', needsCredentials: true })],
    });
    mount(<App />, { respond: fixture.respond });
    await waitFor(() => expect(screen.getByText('needs credential')).toBeInTheDocument());
  });

  it('has an empty state with a voice, not "no records found"', async () => {
    mount(<App />, { respond: serving({}).respond });
    await waitFor(() =>
      expect(
        screen.getByText(
          'No agents yet — describe someone in a sentence and Claude will draft them.',
        ),
      ).toBeInTheDocument(),
    );
  });
});

describe('a roster diagnostic (§5.2, IMPLEMENTATION §2)', () => {
  it('renders as a badge carrying the server’s message, and the board still renders', async () => {
    const fixture = serving({
      agents: [
        anAgent({
          id: 'broken',
          name: 'Broken',
          diagnostics: [
            {
              level: 'error',
              code: 'invalid_agent_json',
              message: 'agent.json is not valid JSON at line 3.',
              agentId: 'broken',
            },
          ],
        }),
        anAgent({ id: 'fine', name: 'Fine' }),
      ],
      diagnostics: [
        {
          level: 'error',
          code: 'unreadable_agent_folder',
          message: 'C:\\roster\\ghost could not be read.',
        },
      ],
    });
    mount(<App />, { respond: fixture.respond });

    await waitFor(() => expect(screen.getByRole('link', { name: 'Broken' })).toBeInTheDocument());

    // The message, verbatim — a diagnostic the UI rewords is one nobody can search.
    const badge = within(card('Broken')).getByText('agent.json is not valid JSON at line 3.');
    expect(badge).toHaveAttribute('data-diagnostic-code', 'invalid_agent_json');
    expect(badge).toHaveAttribute('data-tone', 'danger');

    // A library-wide diagnostic has no card to hang on, so it sits above the grid…
    expect(screen.getByText('C:\\roster\\ghost could not be read.')).toBeInTheDocument();
    // …and the rest of the board is unaffected.
    expect(screen.getByRole('link', { name: 'Fine' })).toBeInTheDocument();
  });

  it('surfaces a failed roster read as the server’s message, not a blank grid', async () => {
    mount(<App />, {
      respond: () =>
        json({ error: 'roster_unreadable', message: 'The roster folder is not readable.' }, 500),
    });
    await waitFor(() =>
      expect(screen.getByText('The roster folder is not readable.')).toBeInTheDocument(),
    );
  });
});

describe('the status pill, live from session.* (§5.2)', () => {
  it('starts idle and follows a session start and end with no reload', async () => {
    const fixture = serving({
      agents: [anAgent({ id: 'priya', name: 'Priya' })],
      projects: [aProject({ id: 'lpm', name: 'littlepocketmuseum' })],
    });
    const { stream, calls } = mount(<App />, { respond: fixture.respond });

    await waitFor(() => expect(screen.getByRole('link', { name: 'Priya' })).toBeInTheDocument());
    expect(within(card('Priya')).getByText('idle')).toBeInTheDocument();

    await act(async () => {
      stream.emit({
        id: '01START',
        type: 'session.started',
        ids: { agentId: 'priya', projectId: 'lpm', sessionId: '01SESSION' },
        payload: { summary: 'Reproducing the 500 on /invoices' },
      });
      await Promise.resolve();
    });

    // The word, the project it is pointed at, and the headline.
    const working = card('Priya');
    expect(within(working).getByText('working')).toBeInTheDocument();
    expect(within(working).getByText('· littlepocketmuseum')).toBeInTheDocument();
    expect(within(working).getByText('Reproducing the 500 on /invoices')).toBeInTheDocument();

    const before = calls.length;
    await act(async () => {
      stream.emit({ id: '01END', type: 'session.ended', ids: { agentId: 'priya' } });
      await Promise.resolve();
    });
    await waitFor(() => expect(within(card('Priya')).getByText('idle')).toBeInTheDocument());
    // A lifecycle event never refetches the roster: the pill is store state.
    expect(calls.slice(before).filter((url) => url.startsWith('/api/roster'))).toEqual([]);
  });

  it('reads awaiting_user for a park on a question, in orchestrator’s own words', async () => {
    const fixture = serving({ agents: [anAgent({ id: 'priya', name: 'Priya' })] });
    const { stream } = mount(<App />, { respond: fixture.respond });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Priya' })).toBeInTheDocument());

    await act(async () => {
      stream.emit({
        id: '01PAUSE',
        type: 'session.paused',
        ids: { agentId: 'priya' },
        payload: { exitReason: 'awaiting_answer' },
      });
      await Promise.resolve();
    });
    expect(within(card('Priya')).getByText('awaiting user')).toBeInTheDocument();
  });
});

describe('roster.changed updates the card in place (IMPLEMENTATION §2)', () => {
  it('re-reads the roster and repaints the affected card — no reload', async () => {
    const fixture = serving({
      agents: [anAgent({ id: 'priya', name: 'Priya', tagline: 'Reproduces first.' })],
    });
    const { stream } = mount(<App />, { respond: fixture.respond });
    await waitFor(() => expect(screen.getByText('Reproduces first.')).toBeInTheDocument());

    // The file on disk is edited — or `git pull` rewrote it. Roster's watcher
    // debounces and emits `roster.changed`; nothing else happens.
    fixture.set({
      agents: [anAgent({ id: 'priya', name: 'Priya', tagline: 'Reads the stack trace twice.' })],
    });

    await act(async () => {
      stream.emit({ id: '01ROSTER', type: 'roster.changed', ids: { agentId: 'priya' } });
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByText('Reads the stack trace twice.')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Reproduces first.')).not.toBeInTheDocument();
  });
});

describe('the archive filter (§5.2)', () => {
  it('hides an archived agent by default, shows it under the filter, and greys it', async () => {
    const fixture = serving({
      agents: [
        anAgent({ id: 'priya', name: 'Priya' }),
        anAgent({ id: 'old', name: 'Old Hand', archivedAt: '2026-07-01T00:00:00.000Z' }),
      ],
    });
    mount(<App />, { respond: fixture.respond });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Priya' })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Old Hand' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Archived' }));

    const archived = card('Old Hand');
    expect(archived).toHaveAttribute('data-archived', 'true');
    expect(within(archived).getByText('archived')).toBeInTheDocument();
    // The board says so rather than showing an empty list.
    expect(screen.queryByRole('link', { name: 'Priya' })).not.toBeInTheDocument();
  });

  it('says "No archived agents" rather than nothing when there are none', async () => {
    const fixture = serving({ agents: [anAgent({ id: 'priya', name: 'Priya' })] });
    mount(<App />, { respond: fixture.respond });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Priya' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(screen.getByText('No archived agents.')).toBeInTheDocument();
  });

  it('renders a session’s missing agent as "deleted agent", never blank', () => {
    // foundation §1.4 keeps the reference rather than the row, so this label is
    // reachable from anywhere a session names an agent.
    expect(agentLabel(undefined)).toBe(DELETED_AGENT_LABEL);
    expect(agentLabel(undefined)).toBe('deleted agent');
    expect(agentLabel(anAgent({ id: 'priya', name: 'Priya' }))).toBe('Priya');
  });
});

describe('filters and sort (§5.1)', () => {
  it('defaults to board order and can be switched to name', async () => {
    const fixture = serving({
      agents: [
        anAgent({ id: 'zed', name: 'Zed', boardOrder: 0 }),
        anAgent({ id: 'ana', name: 'Ana', boardOrder: 1 }),
      ],
    });
    mount(<App />, { respond: fixture.respond });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Zed' })).toBeInTheDocument());

    const names = (): string[] =>
      screen.getAllByRole('link', { name: /^(?:Zed|Ana)$/u }).map((link) => link.textContent ?? '');

    expect(screen.getByLabelText('Sort')).toHaveValue('board-order');
    expect(names()).toEqual(['Zed', 'Ana']);

    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'name');
    expect(names()).toEqual(['Ana', 'Zed']);
  });

  it('filters by specialty and by "working now"', async () => {
    const fixture = serving({
      agents: [
        anAgent({ id: 'priya', name: 'Priya', specialty: 'bug-patching' }),
        anAgent({ id: 'sam', name: 'Sam', specialty: 'testing' }),
      ],
    });
    const { stream } = mount(<App />, { respond: fixture.respond });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Priya' })).toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText('Specialty'), 'testing');
    expect(screen.queryByRole('link', { name: 'Priya' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sam' })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Specialty'), '');
    await act(async () => {
      stream.emit({ id: '01W', type: 'session.started', ids: { agentId: 'priya' } });
      await Promise.resolve();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Working now' }));
    expect(screen.getByRole('link', { name: 'Priya' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sam' })).not.toBeInTheDocument();
  });
});

/**
 * IMPLEMENTATION §10: "Per-agent grants show `expiresAt` on **both** the
 * settings screen and the board card, and update live on
 * `remote.agent.access.*`." The settings half is in
 * `settings/SettingsPage.test.tsx`; this is the card half.
 */
describe('the remote grant badge on the card (§13.2, remote §12.4)', () => {
  const REMOTE_BOOT = {
    ...BOOT_FACTS,
    health: {
      ...BOOT_FACTS.health,
      modules: [...BOOT_FACTS.health.modules, { id: 'remote', status: 'ok' as const }],
    },
  };

  function withGrants(grants: readonly unknown[]): Responder {
    const base = serving({ agents: [anAgent({ id: 'priya', name: 'Priya' })] });
    return (url, init) => {
      const path = url.split('?')[0] ?? url;
      if (path === '/api/remote/agents') return json({ agents: grants });
      return base.respond(url, init);
    };
  }

  it('shows the expiry, and repaints when a grant event arrives', async () => {
    const mounted = mount(<App />, {
      respond: withGrants([
        {
          agentId: 'priya',
          agentName: 'Priya',
          enabled: true,
          grantedAt: '2026-08-17T09:00:00.000Z',
          expiresAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString(),
          grantedVia: 'local',
          tokenId: 'tok_1',
        },
      ]),
      boot: REMOTE_BOOT,
    });

    const badge = await waitFor(() => {
      const found = document.querySelector('[data-remote-grant="priya"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(badge.textContent).toContain('expires in 2 days');
    expect(badge.getAttribute('data-grant-expires')).not.toBe('');

    // The list is invalidated by the grant events (§3.4), so a revoke elsewhere
    // repaints the card rather than leaving a stale promise on it.
    const before = mounted.calls.filter((call) => call.startsWith('/api/remote/agents')).length;
    mounted.stream.emit({
      type: 'remote.agent.access.revoked',
      id: 'evt_grant',
      ids: { agentId: 'priya' },
    });
    await waitFor(() =>
      expect(
        mounted.calls.filter((call) => call.startsWith('/api/remote/agents')).length,
      ).toBeGreaterThan(before),
    );
  });

  /**
   * §5.2's home-edition menu entry, and §13.2's "the same toggle appears on the
   * board card". The board is the only surface that can *end* a grant in one
   * gesture — the launch flow's toggle grants and cannot take it back — so the
   * revoke direction is what these pin.
   */
  const GRANT = {
    agentId: 'priya',
    agentName: 'Priya',
    enabled: true,
    grantedAt: '2026-08-17T09:00:00.000Z',
    expiresAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString(),
    grantedVia: 'local',
    tokenId: 'tok_1',
  };

  /** Records what was PUT at the access route, so the direction can be asserted. */
  function grantsRecording(grants: readonly unknown[]): {
    readonly respond: Responder;
    readonly puts: unknown[];
  } {
    const puts: unknown[] = [];
    const base = withGrants(grants);
    return {
      puts,
      respond: (url, init) => {
        const path = url.split('?')[0] ?? url;
        if (path === '/api/remote/agents/priya/access' && init.method === 'PUT') {
          puts.push(typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined);
          return json({ ok: true });
        }
        return base(url, init);
      },
    };
  }

  async function openMenu(): Promise<HTMLElement> {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Priya' }));
    return screen.getByRole('menu', { name: 'Priya actions' });
  }

  it('revokes a live grant from the card menu, checked to match the badge', async () => {
    const recorder = grantsRecording([GRANT]);
    mount(<App />, { respond: recorder.respond, boot: REMOTE_BOOT });
    await waitFor(() =>
      expect(document.querySelector('[data-remote-grant="priya"]')).not.toBeNull(),
    );

    const menu = await openMenu();
    const toggle = within(menu).getByRole('menuitemcheckbox', { name: /Allow remote starts/u });
    // The tick and the badge are two readings of one fact; they cannot disagree.
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    await userEvent.setup().click(toggle);
    await waitFor(() => expect(recorder.puts).toEqual([{ enabled: false }]));
  });

  it('grants from the card menu when there is none, and shows unchecked first', async () => {
    const recorder = grantsRecording([]);
    mount(<App />, { respond: recorder.respond, boot: REMOTE_BOOT });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Priya' })).toBeInTheDocument());

    const menu = await openMenu();
    const toggle = within(menu).getByRole('menuitemcheckbox', { name: /Allow remote starts/u });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await userEvent.setup().click(toggle);
    await waitFor(() => expect(recorder.puts).toEqual([{ enabled: true }]));
  });

  it('omits the toggle entirely in the work edition (§13.5)', async () => {
    mount(<App />, { respond: withGrants([]) });
    const menu = await openMenu();
    // Absent, not disabled: the capability does not exist here.
    expect(within(menu).queryByRole('menuitemcheckbox')).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Launch on…' })).toBeInTheDocument();
  });

  it('asks nothing of the remote module when it is not loaded (§3.5)', async () => {
    const mounted = mount(<App />, { respond: withGrants([]) });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Priya' })).toBeInTheDocument());
    expect(mounted.calls.filter((call) => call.startsWith('/api/remote'))).toEqual([]);
    expect(document.querySelector('[data-remote-grant]')).toBeNull();
  });
});
