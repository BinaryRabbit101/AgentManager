/**
 * The app shell: boot, frame, connection indicator and theme toggle
 * (DESIGN §2.2, §3.3, §3.5, §14.2; IMPLEMENTATION §1).
 *
 * The acceptance criteria this covers are the ones about what the user sees
 * when something is wrong — a core that is not answering must produce a screen
 * that says so and names where to look, **never a blank page**.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BOOT_FACTS, json, mount, routes } from '../../test/harness';
import { App } from '../App';
import { ApiClient } from '../api/client';
import { THEME_STORAGE_KEY } from '../theme/theme';

import { BootGate, coreUrl, LOG_PATH_HINT } from './Boot';
import { OFFLINE_BANNER_DELAY_MS } from './ConnectionIndicator';

/**
 * A core with nothing in it — every list home and the board read, empty.
 *
 * Home is `/` now (§2.4) and reads five of these; a missing fixture would draw
 * an error notice with `role="alert"` on every screen in this file, which is
 * exactly the role the offline-banner assertions below look for.
 */
const EMPTY = routes({
  '/api/roster/agents': { agents: [], diagnostics: [] },
  '/api/roster/connectors': { connectors: [], diagnostics: [] },
  '/api/projects': { projects: [] },
  '/api/questions': { questions: [] },
  '/api/sessions': { sessions: [], next: null },
  '/api/assignments': { assignments: [] },
  '/api/orchestrator/status': {
    agents: [],
    assignments: { open: 0, halted: 0, awaitingUser: 0 },
    questions: { open: 0, oldestOpenedAt: null },
  },
});

function bootWith(respond: (url: string) => Response) {
  const client = new ApiClient({
    fetch: ((input: string) =>
      Promise.resolve(respond(input))) as unknown as typeof globalThis.fetch,
    tokens: { get: () => null, set: () => undefined },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BootGate client={client}>{(facts) => <p>edition {facts.config.edition}</p>}</BootGate>
    </QueryClientProvider>,
  );
}

describe('the boot sequence (§3.5, IMPLEMENTATION §1)', () => {
  it('learns edition and health before rendering anything else', async () => {
    const asked: string[] = [];
    bootWith((url) => {
      asked.push(url);
      if (url === '/api/config/effective') return json(BOOT_FACTS.config);
      return json(BOOT_FACTS.health);
    });

    // Nothing of the app is on screen while the two facts are in flight: half
    // the frame changes shape on `edition`, and a frame that flickers between
    // two shapes is worse than one that waits.
    expect(screen.getByRole('status')).toHaveTextContent('Reaching the core…');

    await waitFor(() => expect(screen.getByText('edition home')).toBeInTheDocument());
    expect(asked.sort()).toEqual(['/api/config/effective', '/api/health']);
  });

  it('renders a diagnostic screen naming the core URL and the log path, never a blank page', async () => {
    bootWith(() => {
      throw new TypeError('fetch failed');
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('AgentManager cannot reach its core');
    // The two facts a user with no working app actually needs.
    expect(alert).toHaveTextContent(coreUrl());
    expect(alert).toHaveTextContent(LOG_PATH_HINT);
    // And the honest explanation that the app cannot fix it from here.
    expect(alert).toHaveTextContent('The core runs as a separate service.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('surfaces the server’s own refusal message rather than paraphrasing it', async () => {
    bootWith(() =>
      json({ error: 'project_not_found', message: 'That project is not registered.' }, 404),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That project is not registered.');
  });

  /**
   * §3.2: "The pairing screen is reached **only** by a `401`." Until M10 a `401`
   * fell through to the diagnostic screen, which told an unpaired phone that the
   * core was unreachable — it is not; it is refusing this device. The client has
   * already cleared the stored token by the time we get here (§3.1), so there is
   * nothing to retry and the honest screen is the one that pairs.
   */
  it('shows the pairing screen on a 401 rather than the diagnostic screen', async () => {
    bootWith(() => json({ error: 'unauthorized', message: 'That token is no longer valid.' }, 401));
    expect(await screen.findByRole('heading', { name: 'Pair this device' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pair' })).toBeDisabled();
  });

  it('retries on demand and renders once the core answers', async () => {
    let up = false;
    bootWith((url) => {
      if (!up) throw new TypeError('fetch failed');
      return json(url === '/api/config/effective' ? BOOT_FACTS.config : BOOT_FACTS.health);
    });
    await screen.findByRole('alert');

    up = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('edition home')).toBeInTheDocument());
  });

  it('takes the core URL from the page’s own origin, never from configuration', () => {
    // §1.3: every call is same-origin and relative, so the origin the app was
    // loaded from *is* the core URL — in Electron too, which loads over http.
    expect(coreUrl({ origin: 'http://100.64.0.2:7478' })).toBe('http://100.64.0.2:7478');
    expect(coreUrl()).toBe(window.location.origin);
  });
});

describe('the frame and the debug panel (§2.2, IMPLEMENTATION §1)', () => {
  it('renders every destination as a real link inside a nav landmark', async () => {
    mount(<App />, { respond: EMPTY, route: '/agents' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    // §2.2's rail, in order. Home leads it and the board follows as Agents
    // (§2.4) — the roster is a destination now rather than the front door.
    for (const label of [
      'Home',
      'Agents',
      // §2.1's connector library (WO4), beside Agents: the thing agents are
      // given, rather than a setting.
      'Connectors',
      'Projects',
      'Sessions',
      'Assignments',
      'Questions',
      'Usage',
      'Settings',
    ]) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/agents');
    expect(screen.getByRole('main')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/No agents yet/u)).toBeInTheDocument());
  });

  it('shows the edition, the module list and the event filter', async () => {
    mount(<App />, { respond: EMPTY, route: '/agents' });
    expect(screen.getByTestId('debug-edition')).toHaveTextContent('home');
    expect(screen.getByTestId('debug-modules')).toHaveTextContent('roster:ok');
    expect(screen.getByTestId('debug-modules')).toHaveTextContent('orchestrator:ok');
    // The filter is visible because it is what makes the feed cheap (§3.3).
    expect(screen.getByTestId('debug-stream-url')).toHaveTextContent('/api/events?types=');
    await waitFor(() => expect(screen.getByText(/No agents yet/u)).toBeInTheDocument());
  });

  it('displays health warnings persistently, not as a dismissible toast', async () => {
    mount(<App />, {
      respond: EMPTY,
      route: '/agents',
      boot: {
        config: BOOT_FACTS.config,
        health: {
          ...BOOT_FACTS.health,
          status: 'degraded',
          conditions: [
            {
              level: 'warn',
              id: 'secrets.anthropicApiKeyOverridesSubscription',
              message: 'ANTHROPIC_API_KEY is set and overrides subscription auth.',
            },
          ],
        },
      },
    });
    const warning = screen.getByText('ANTHROPIC_API_KEY is set and overrides subscription auth.');
    expect(warning).toHaveAttribute(
      'data-condition-code',
      'secrets.anthropicApiKeyOverridesSubscription',
    );
    // No dismiss control: it is a fact about the machine, not an event.
    expect(within(screen.getByTestId('debug-panel')).queryByRole('button')).toBeNull();
    await waitFor(() => expect(screen.getByText(/No agents yet/u)).toBeInTheDocument());
  });

  it('renders every one of the routes rather than a blank frame', () => {
    // Foundation's history fallback hands a cold `GET /questions/abc` to the
    // SPA, so each route must render *something* from the first milestone.
    //
    // `/agents` and its two deeper routes are all here on purpose: react-router
    // v6 ranks by specificity rather than by declaration order, and this is what
    // proves it — `/agents/new` must reach the wizard and `/agents/a1` the
    // editor, not the board, now that `/agents` is a route of its own.
    for (const route of [
      '/agents',
      '/agents/new',
      '/agents/a1',
      '/connectors',
      '/projects',
      '/projects/p1',
      '/sessions',
      '/sessions/s1',
      '/assignments',
      '/assignments/a1',
      '/questions',
      '/questions/abc',
      '/usage',
      '/settings',
    ]) {
      const view = mount(<App />, { respond: EMPTY, route });
      expect(screen.getByRole('main').textContent, route).not.toBe('');
      expect(screen.getByRole('heading', { level: 2 }), route).toBeInTheDocument();
      view.unmount();
    }
  });

  it('says so on an address that names nothing, rather than showing an empty screen', () => {
    mount(<App />, { respond: EMPTY, route: '/not-a-screen' });
    expect(
      screen.getByText('That address does not name anything in AgentManager.'),
    ).toBeInTheDocument();
  });

  it('carries the deep-linked id through to the screen that reads it', () => {
    // M1 asserted this against a placeholder that echoed the id. M5 replaced the
    // placeholder with the real inbox, so the same property is now proven where
    // it matters: the id from the URL becomes the request the card is drawn from
    // (ui IMPLEMENTATION §5's deep link, orchestrator §10's ntfy target).
    const view = mount(<App />, { respond: EMPTY, route: '/questions/abc' });
    expect(view.calls).toContain('/api/questions/abc');
  });
});

describe('the connection indicator (§3.3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports reconnecting before the feed answers and live once it has replayed', async () => {
    const { stream } = mount(<App />, { respond: EMPTY });
    const indicator = (): HTMLElement => screen.getByTestId('connection');

    expect(indicator()).toHaveAttribute('data-state', 'reconnecting');
    expect(indicator()).toHaveTextContent('reconnecting');

    await act(async () => {
      stream.completeReplay();
      await Promise.resolve();
    });
    expect(indicator()).toHaveAttribute('data-state', 'live');
    // The word is beside the dot: colour is never the only carrier (§15).
    expect(indicator()).toHaveTextContent('live');
  });

  it('raises a full-width banner only after five seconds offline', async () => {
    const { stream } = mount(<App />, { respond: EMPTY });
    await act(async () => {
      stream.completeReplay();
      await Promise.resolve();
    });

    await act(async () => {
      stream.drop();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(screen.getByTestId('connection')).toHaveAttribute('data-state', 'offline');
    // Not yet a banner: `offline` has only just been reached.
    expect(screen.queryByText(/nothing on screen is live/u)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OFFLINE_BANNER_DELAY_MS + 100);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('The core is not answering.');
  });
});

describe('the theme toggle (§14.2)', () => {
  it('offers system, light and dark, and stamps the root attribute', async () => {
    mount(<App />, { respond: EMPTY });
    const select = screen.getByLabelText('Theme');
    expect(select).toHaveValue('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    await userEvent.selectOptions(select, 'dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    await userEvent.selectOptions(select, 'System');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('the global New agent affordance (§2.2)', () => {
  it('offers it from the top bar as a real link, on every screen', () => {
    mount(<App />, { respond: EMPTY, route: '/usage' });
    const banner = screen.getByRole('banner');
    const link = within(banner).getByRole('link', { name: 'New agent' });
    // A link, not a button: `/agents/new` is a route, and the wizard was
    // otherwise reachable only by typing the URL.
    expect(link).toHaveAttribute('href', '/agents/new');
  });

  it('lands on the wizard when it is followed', async () => {
    mount(<App />, { respond: EMPTY });
    await userEvent.click(screen.getByRole('link', { name: 'New agent' }));
    expect(await screen.findByRole('heading', { name: 'New agent' })).toBeInTheDocument();
  });
});
