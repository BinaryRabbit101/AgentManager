/**
 * The pattern create dialog (DESIGN §10.4; IMPLEMENTATION §9).
 *
 * Three criteria live here:
 *
 * - "The create dialog **refuses nothing client-side that the server would
 *   accept**" — asserted by driving an input the server accepts and finding the
 *   submit still enabled, and by finding no validation of our own on the way.
 * - "surfaces **every** server `warning` before the user confirms" — asserted
 *   by the two-step flow: create parked (`autoStart: false`), warnings shown,
 *   nothing started.
 * - "a returned `gate` **prevents any 'it's running' impression**" — asserted
 *   by the absence of the Start button and the presence of the card link.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { anAgent, aProject, json, mount, type Responder } from '../../test/harness';
import { App } from '../App';
import { useAppStore } from '../state/store';

import { PATTERNS } from './fixtures';

const ADA = anAgent({ id: 'ada', name: 'Ada' });
const SAM = anAgent({ id: 'sam', name: 'Sam' });
const LPM = aProject({ id: 'lpm', name: 'littlepocketmuseum' });

interface Posted {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function serving(options: { created?: unknown; status?: number; posts?: Posted[] }): Responder {
  return (url, init) => {
    const path = url.split('?')[0] ?? url;
    if (init.method === 'POST') {
      options.posts?.push({
        url: path,
        body: JSON.parse(init.body as string) as Record<string, unknown>,
      });
      if (path === '/api/assignments') {
        return json(
          options.created ?? {
            assignmentId: 'asg_new',
            status: 'open',
            phase: 'planned',
            warnings: [],
          },
          options.status ?? 201,
        );
      }
      return json({ outcome: { kind: 'planned' } });
    }
    if (path === '/api/roster/agents') return json({ agents: [ADA, SAM], diagnostics: [] });
    if (path === '/api/projects') return json({ projects: [LPM] });
    if (path === '/api/patterns') return json(PATTERNS);
    if (path.endsWith('/avatar')) return new Response(new Blob(['png']), { status: 200 });
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
}

/**
 * The board, which is `/agents` since §2.4 gave `/` to the home screen.
 *
 * The dialog is opened from a card there, and the screen behind it matters to
 * these tests for one reason: several assert that **no** `role="alert"` is on
 * screen, and home reads five lists this file has no fixtures for.
 */
const PAIR_ROUTE = '/agents';

function openPair(): void {
  useAppStore.getState().openPair({ agentId: 'ada', withAgentId: 'sam' });
}

async function dialog(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: 'Start a pair' });
}

describe('the dialog is driven entirely by GET /api/patterns (§10.4)', () => {
  it('takes its seats, roles, tiers, defaults and cap from the server', async () => {
    mount(<App />, { route: PAIR_ROUTE, respond: serving({}) });
    openPair();
    const sheet = await dialog();

    // Seat names and allowed roles are the pattern's, not this file's.
    await waitFor(() =>
      expect(sheet.querySelector('[data-seat="drafter"] legend')?.textContent).toContain('drafter'),
    );
    expect(within(sheet).getByText(/architect \/ implementer/u)).toBeInTheDocument();
    expect(within(sheet).getByText(/prefers max/u)).toBeInTheDocument();

    // The defaults arrive pre-filled, in tokens.
    await waitFor(() => expect(within(sheet).getByLabelText(/Round cap/u)).toHaveValue(3));
    expect(within(sheet).getByLabelText('Token budget')).toHaveValue(400_000);
    expect(within(sheet).getByLabelText(/Round cap \(max 6\)/u)).toBeInTheDocument();
  });

  it('lists candidates with their open-assignment count (§10.4)', async () => {
    mount(<App />, { route: PAIR_ROUTE, respond: serving({}) });
    openPair();
    const sheet = await dialog();
    const drafter = await within(sheet).findByLabelText('drafter agent');
    expect(within(drafter).getByRole('option', { name: 'Ada — 1 open' })).toBeInTheDocument();
    const critic = within(sheet).getByLabelText('critic agent');
    expect(within(critic).getByRole('option', { name: 'Sam — 0 open' })).toBeInTheDocument();
  });

  it('pre-fills the dragged agent as drafter and the target as critic (§5.3)', async () => {
    mount(<App />, { route: PAIR_ROUTE, respond: serving({}) });
    openPair();
    const sheet = await dialog();
    await waitFor(() => expect(within(sheet).getByLabelText('drafter agent')).toHaveValue('ada'));
    expect(within(sheet).getByLabelText('critic agent')).toHaveValue('sam');
  });
});

describe('every server warning is surfaced before the user confirms (§10.4)', () => {
  it('creates parked, shows the warnings, and starts nothing until Start', async () => {
    const posts: Posted[] = [];
    mount(<App />, { route: PAIR_ROUTE,
      respond: serving({
        posts,
        created: {
          assignmentId: 'asg_new',
          status: 'open',
          phase: 'planned',
          warnings: [
            { code: 'scope_overlap', message: 'Two assignments touch src/transcripts.' },
            { code: 'projection_exceeds_budget', message: 'Projected 500,000 tokens.' },
          ],
        },
      }),
    });
    openPair();
    const sheet = await dialog();

    const user = userEvent.setup();
    await waitFor(() =>
      expect(
        within(within(sheet).getByLabelText('Project')).getByRole('option', {
          name: 'littlepocketmuseum',
        }),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(within(sheet).getByLabelText('Project'), 'lpm');
    await user.type(within(sheet).getByLabelText(/Artifact path/u), 'docs/decision.md');
    await user.click(within(sheet).getByRole('button', { name: 'Review' }));

    // One POST, and it asked orchestrator **not** to start it.
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toBe('/api/assignments');
    expect(posts[0]?.body['autoStart']).toBe(false);
    expect(posts[0]?.body['pattern']).toBe('pair');
    expect(posts[0]?.body['members']).toEqual([
      { agentId: 'ada', role: 'architect' },
      { agentId: 'sam', role: 'skeptic' },
    ]);

    // Both warnings, verbatim, before anything runs.
    expect(await screen.findByText('Two assignments touch src/transcripts.')).toBeInTheDocument();
    expect(screen.getByText('Projected 500,000 tokens.')).toBeInTheDocument();
    expect(screen.getByText(/nothing has started/iu)).toBeInTheDocument();

    // Only now does Start advance it.
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]?.url).toBe('/api/assignments/asg_new/advance');
  });

  it('refuses nothing client-side that the server would accept', async () => {
    mount(<App />, { route: PAIR_ROUTE, respond: serving({}) });
    openPair();
    const sheet = await dialog();
    const user = userEvent.setup();

    // No project, no artifact, no goal: the server decides, not this dialog.
    const review = within(sheet).getByRole('button', { name: 'Review' });
    expect(review).toBeEnabled();

    // A round cap above the pattern's own default is still submittable — the
    // ceiling is the server's `maxRoundCap`, and 5 is inside it.
    await user.clear(within(sheet).getByLabelText(/Round cap/u));
    await user.type(within(sheet).getByLabelText(/Round cap/u), '5');
    expect(review).toBeEnabled();
  });

  it('shows the server’s refusal verbatim when it does refuse', async () => {
    mount(<App />, { route: PAIR_ROUTE,
      respond: serving({
        status: 400,
        created: {
          error: 'scope_path_invalid',
          message: 'Scope path "..\\etc" leaves the project.',
        },
      }),
    });
    openPair();
    const sheet = await dialog();
    const user = userEvent.setup();
    await user.click(within(sheet).getByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('leaves the project');
  });
});

describe('a returned gate prevents any "it is running" impression (§10.4)', () => {
  it('offers no Start button, says it is waiting for approval, and links to the card', async () => {
    const posts: Posted[] = [];
    mount(<App />, { route: PAIR_ROUTE,
      respond: serving({
        posts,
        created: {
          assignmentId: 'asg_gated',
          status: 'open',
          phase: 'planned',
          warnings: [],
          gate: { reason: 'a pair on a project with an elevation', questionId: 'q9' },
        },
      }),
    });
    openPair();
    const sheet = await dialog();

    const user = userEvent.setup();
    await user.click(within(sheet).getByRole('button', { name: 'Review' }));

    const gate = await screen.findByText(/Waiting for your approval/u);
    expect(gate).toHaveTextContent('a pair on a project with an elevation');
    expect(screen.getByRole('link', { name: 'Open the card' })).toHaveAttribute(
      'href',
      '/questions/q9',
    );
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    // And nothing was advanced.
    expect(posts.filter((post) => post.url.endsWith('/advance'))).toEqual([]);
  });
});

describe('a remote pattern launch of two ungranted agents (§13.4, IMPLEMENTATION §10)', () => {
  it('prompts once, from the 409 body’s list, and retries automatically', async () => {
    const posts: Posted[] = [];
    let refused = true;
    const respond: Responder = (url, init) => {
      const path = url.split('?')[0] ?? url;
      if (init.method === 'POST' && path === '/api/assignments') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        posts.push({ url: path, body });
        if (refused && body['confirmRemoteAccess'] !== true) {
          refused = false;
          // remote's own shape: `agents`, always present, one entry per
          // ungranted agent — which is why one refusal is one prompt.
          return json(
            {
              error: 'remote_access_required',
              message: 'These agents have not been allowed to be started remotely yet.',
              agents: [
                { agentId: 'ada', agentName: 'Ada' },
                { agentId: 'sam', agentName: 'Sam' },
              ],
            },
            409,
          );
        }
        return json(
          { assignmentId: 'asg_new', status: 'open', phase: 'planned', warnings: [] },
          201,
        );
      }
      return serving({ posts })(url, init);
    };

    mount(<App />, { route: PAIR_ROUTE, respond, token: 'a-device-token' });
    openPair();
    const sheet = await dialog();
    await within(sheet).findByLabelText('drafter agent');

    const user = userEvent.setup();
    await user.click(within(sheet).getByRole('button', { name: 'Review' }));

    // One prompt, naming both agents, and it is not an error.
    const prompt = await screen.findByText(/Allow Ada and Sam to be started remotely\?/u);
    expect(prompt.closest('[data-grant-prompt="true"]')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelectorAll('[data-grant-prompt="true"]')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Allow and continue' }));

    // The retry is the same request plus the atomic grant (remote §6.3), and
    // there is no second prompt.
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]?.body['confirmRemoteAccess']).toBe(true);
    expect(await screen.findByText(/nothing has started/iu)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-grant-prompt="true"]')).toHaveLength(0);
  });
});

describe('the dialog closes the way every dialog does (§15)', () => {
  it('closes on Escape', async () => {
    mount(<App />, { route: PAIR_ROUTE, respond: serving({}) });
    openPair();
    const sheet = await dialog();
    const user = userEvent.setup();
    sheet.focus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start a pair' })).toBeNull());
  });
});
