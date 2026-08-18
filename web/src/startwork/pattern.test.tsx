/**
 * Start work with **two or more** agents (DESIGN §6, §10.4; orchestrator §3.5).
 *
 * These are the pattern create dialog's own criteria, moved to the geography of
 * the one flow, plus the two shapes it could not express:
 *
 * - "The create dialog **refuses nothing client-side that the server would
 *   accept**" — asserted by driving an input the server accepts and finding the
 *   submit still enabled, and by finding no validation of our own on the way.
 * - "surfaces **every** server `warning` before the user confirms" — asserted by
 *   the two-step flow: create parked (`autoStart: false`), warnings shown,
 *   nothing started. `role_not_declared` and `lead_not_overseer` are warnings
 *   now (owner decision 2026-08-18), so **Start** stays enabled beside them.
 * - "a returned `gate` **prevents any 'it's running' impression**" — asserted by
 *   the absence of the Start button and the presence of the card link.
 * - **Independently**: two agents, two solos, one brief (§6).
 * - **Team**: three agents, `pattern: 'overseer'`, the lead as the *only*
 *   member, a required token budget, and the others named in the goal as a
 *   suggestion the lead may overrule (§3.5).
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { anAgent, aProject, json, mount, type Responder } from '../../test/harness';
import { App } from '../App';
import { PATTERNS } from '../assignments/fixtures';
import { useAppStore, type StartWorkIntent } from '../state/store';

const ADA = anAgent({ id: 'ada', name: 'Ada' });
const SAM = anAgent({ id: 'sam', name: 'Sam' });
const RIO = anAgent({ id: 'rio', name: 'Rio', overseer: true });
const LPM = aProject({ id: 'lpm', name: 'littlepocketmuseum' });

interface Posted {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function serving(options: {
  created?: unknown;
  status?: number;
  posts?: Posted[];
  agents?: readonly ReturnType<typeof anAgent>[];
}): Responder {
  const agents = options.agents ?? [ADA, SAM];
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
      if (path === '/api/assignments/solo') {
        return json({ assignmentId: 'asg_solo', sessionId: 'ses_solo', warnings: [] }, 201);
      }
      return json({ outcome: { kind: 'planned' } });
    }
    if (path === '/api/roster/agents') return json({ agents, diagnostics: [] });
    if (path === '/api/projects') return json({ projects: [LPM] });
    if (path === '/api/patterns') return json(PATTERNS);
    if (path === '/api/assignments') return json({ assignments: [] });
    if (path === '/api/projects/lpm') return json({ ...LPM, defaults: { agentIds: [] } });
    if (path.startsWith('/api/sessions/')) {
      return json({ error: 'not_found', message: 'no session yet' }, 404);
    }
    if (path.endsWith('/avatar')) return new Response(new Blob(['png']), { status: 200 });
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
}

/**
 * The board, which is `/agents` since §2.4 gave `/` to the home screen.
 *
 * The flow is opened from a card there, and the screen behind it matters to
 * these tests for one reason: several assert that **no** `role="alert"` is on
 * screen, and home reads five lists this file has no fixtures for.
 */
const ROUTE = '/agents';

function open(intent: Partial<StartWorkIntent> = {}): void {
  useAppStore.getState().openStartWork({
    agentIds: ['ada', 'sam'],
    projectId: null,
    origin: 'drag',
    ...intent,
  });
}

async function dialog(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: 'Start work' });
}

/** The four things every pattern start needs said before Review is useful. */
async function fillIn(
  sheet: HTMLElement,
  user: ReturnType<typeof userEvent.setup>,
  task: string,
): Promise<void> {
  await waitFor(() =>
    expect(
      within(within(sheet).getByLabelText('Project')).getByRole('option', {
        name: 'littlepocketmuseum',
      }),
    ).toBeInTheDocument(),
  );
  await user.selectOptions(within(sheet).getByLabelText('Project'), 'lpm');
  await user.type(within(sheet).getByLabelText(/What should/u), task);
}

describe('the shape of the work is driven by the selection (§6)', () => {
  it('offers the pair and the independent option for two agents, and picks the pair', async () => {
    mount(<App />, { route: ROUTE, respond: serving({}) });
    open();
    const sheet = await dialog();

    const pair = await within(sheet).findByRole('radio', { name: /adversarial pair/iu });
    expect(pair).toBeChecked();
    expect(within(sheet).getByRole('radio', { name: /Independently/u })).not.toBeChecked();
    // Nobody is offered a team with two agents; the option list is the count's.
    expect(within(sheet).queryByRole('radio', { name: /As a team/u })).toBeNull();

    // The seating is shown, and swappable — who drafts is the user's call.
    await waitFor(() =>
      expect(within(sheet).getByText(/Ada drafts · Sam reviews\./u)).toBeInTheDocument(),
    );
    await userEvent.setup().click(within(sheet).getByRole('button', { name: 'Swap seats' }));
    expect(within(sheet).getByText(/Sam drafts · Ada reviews\./u)).toBeInTheDocument();
  });

  it('takes the pattern’s seats, cap and budget from GET /api/patterns', async () => {
    mount(<App />, { route: ROUTE, respond: serving({}) });
    open();
    const sheet = await dialog();

    // The defaults arrive pre-filled, in tokens, from the server's summary.
    await waitFor(() => expect(within(sheet).getByLabelText(/Round cap/u)).toHaveValue(3));
    expect(within(sheet).getByLabelText('Token budget')).toHaveValue(400_000);
    expect(within(sheet).getByLabelText(/Round cap \(max 6\)/u)).toBeInTheDocument();
    // `pair` is the one pattern that requires an artifact, and says so.
    expect(
      within(sheet).getByLabelText(/Artifact path \(required by this pattern\)/u),
    ).toBeInTheDocument();
  });

  it('lists the whole roster with its open-assignment count, hiding nobody (§16-9)', async () => {
    mount(<App />, { route: ROUTE, respond: serving({ agents: [ADA, SAM, RIO] }) });
    open({ agentIds: [] });
    const sheet = await dialog();

    for (const name of ['Ada', 'Sam', 'Rio']) {
      const box = await within(sheet).findByRole('checkbox', { name: new RegExp(name, 'u') });
      // Never disabled by capability: the choice is the user's (§16-9).
      expect(box).toBeEnabled();
    }
    // The hint is present and is a hint: Rio declares nothing either, so the
    // row says so rather than removing it.
    expect(within(sheet).getAllByText('no declared roles').length).toBeGreaterThan(0);
    expect(within(sheet).getAllByText('0 open').length).toBeGreaterThan(0);
  });
});

describe('every server warning is surfaced before the user confirms (§10.4)', () => {
  it('creates parked, shows the warnings, and starts nothing until Start', async () => {
    const posts: Posted[] = [];
    mount(<App />, {
      route: ROUTE,
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
    open();
    const sheet = await dialog();

    const user = userEvent.setup();
    await fillIn(sheet, user, 'Decide where transcripts live');
    await user.type(within(sheet).getByLabelText(/Artifact path/u), 'docs/decision.md');
    await user.click(within(sheet).getByRole('button', { name: 'Review' }));

    // One POST, and it asked orchestrator **not** to start it.
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toBe('/api/assignments');
    expect(posts[0]?.body['autoStart']).toBe(false);
    expect(posts[0]?.body['pattern']).toBe('pair');
    expect(posts[0]?.body['goal']).toBe('Decide where transcripts live');
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

  it('renders role_not_declared and lead_not_overseer as advice, not as blockers', async () => {
    const posts: Posted[] = [];
    mount(<App />, {
      route: ROUTE,
      respond: serving({
        posts,
        created: {
          assignmentId: 'asg_new',
          status: 'open',
          phase: 'planned',
          warnings: [
            {
              code: 'role_not_declared',
              message: 'Agent ada (Ada) does not declare the role "architect".',
            },
            {
              code: 'lead_not_overseer',
              message: 'The lead seat is held by a member in another role. It leads anyway.',
            },
          ],
        },
      }),
    });
    open();
    const sheet = await dialog();

    const user = userEvent.setup();
    await fillIn(sheet, user, 'Write the migration');
    await user.click(within(sheet).getByRole('button', { name: 'Review' }));

    // Advisory: warn-toned, listed under a sentence that says so, and Start is
    // still there and still enabled (owner decision 2026-08-18).
    await screen.findByText(/does not declare the role/u);
    expect(document.querySelector('[data-advisory="true"]')).not.toBeNull();
    expect(document.querySelector('[data-warning="role_not_declared"]')).toHaveAttribute(
      'data-tone',
      'warn',
    );
    expect(document.querySelector('[data-warning="lead_not_overseer"]')).not.toBeNull();
    expect(screen.getByText(/none of these stops it/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
    // A warning is not an alert: nothing here is presented as a failure.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses nothing client-side that the server would accept', async () => {
    mount(<App />, { route: ROUTE, respond: serving({}) });
    open();
    const sheet = await dialog();
    const user = userEvent.setup();
    await fillIn(sheet, user, 'go');

    // No artifact path, and a round cap above the pattern's own default: both
    // are the server's call (`maxRoundCap` is 6, and `requires.artifactPath` is
    // enforced there), so neither is refused here.
    const review = within(sheet).getByRole('button', { name: 'Review' });
    expect(review).toBeEnabled();
    await user.clear(within(sheet).getByLabelText(/Round cap/u));
    await user.type(within(sheet).getByLabelText(/Round cap/u), '5');
    expect(review).toBeEnabled();
    // And a `pair` with no token budget is accepted by `validate.ts`, so it is
    // accepted here — only `overseer` has no default and must be filled in.
    await user.clear(within(sheet).getByLabelText('Token budget'));
    expect(review).toBeEnabled();
  });

  it('shows the server’s refusal verbatim when it does refuse', async () => {
    mount(<App />, {
      route: ROUTE,
      respond: serving({
        status: 400,
        created: {
          error: 'scope_path_invalid',
          message: 'Scope path "..\\etc" leaves the project.',
        },
      }),
    });
    open();
    const sheet = await dialog();
    const user = userEvent.setup();
    await fillIn(sheet, user, 'go');
    await user.click(within(sheet).getByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('leaves the project');
  });
});

describe('a returned gate prevents any "it is running" impression (§10.4)', () => {
  it('offers no Start button, says it is waiting for approval, and links to the card', async () => {
    const posts: Posted[] = [];
    mount(<App />, {
      route: ROUTE,
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
    open();
    const sheet = await dialog();

    const user = userEvent.setup();
    await fillIn(sheet, user, 'go');
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

describe('Independently — one assignment each, same brief (§6)', () => {
  it('posts one solo per agent and opens the first session', async () => {
    const posts: Posted[] = [];
    mount(<App />, { route: ROUTE, respond: serving({ posts }) });
    open();
    const sheet = await dialog();

    const user = userEvent.setup();
    await fillIn(sheet, user, 'Read the importer and report');
    await user.click(within(sheet).getByRole('radio', { name: /Independently/u }));
    // The button says what it will do: a solo starts, it is not reviewed first.
    await user.click(within(sheet).getByRole('button', { name: /Start work/u }));

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts.map((post) => post.url)).toEqual([
      '/api/assignments/solo',
      '/api/assignments/solo',
    ]);
    expect(posts.map((post) => post.body['agentId'])).toEqual(['ada', 'sam']);
    // Same brief, twice — that is the whole difference from a pair.
    expect(posts.map((post) => post.body['prompt'])).toEqual([
      'Read the importer and report',
      'Read the importer and report',
    ]);
    // No pattern was created: independent work is N solos, not an assignment
    // with two seats (§16.7).
    expect(posts.some((post) => post.url === '/api/assignments')).toBe(false);
  });
});

describe('Team — an overseer lead that decomposes (§3.5, §10.4)', () => {
  const THREE = [ADA, SAM, RIO];

  function openTeam(): void {
    useAppStore
      .getState()
      .openStartWork({ agentIds: ['ada', 'sam', 'rio'], projectId: 'lpm', origin: 'agent-menu' });
  }

  it('offers the team option at three agents and defaults to it', async () => {
    mount(<App />, { route: ROUTE, respond: serving({ agents: THREE }) });
    openTeam();
    const sheet = await dialog();
    const team = await within(sheet).findByRole('radio', { name: /As a team/u });
    expect(team).toBeChecked();
    expect(within(sheet).queryByRole('radio', { name: /adversarial pair/iu })).toBeNull();
  });

  it('requires a token budget client-side, because the pattern has no default', async () => {
    mount(<App />, { route: ROUTE, respond: serving({ agents: THREE }) });
    openTeam();
    const sheet = await dialog();

    const user = userEvent.setup();
    await user.type(within(sheet).getByLabelText(/What should/u), 'Ship the importer rewrite');

    // The server refuses a budget-less overseer (`budget_required`), and §7.2
    // gives it no default on purpose — so the form collects it rather than
    // posting a null.
    await waitFor(() =>
      expect(within(sheet).getByLabelText(/Token budget \(required/u)).toHaveValue(null),
    );
    expect(within(sheet).getByRole('button', { name: 'Review' })).toBeDisabled();
    expect(
      within(sheet).getByText('This pattern needs a token budget — it has no default.'),
    ).toBeInTheDocument();

    await user.type(within(sheet).getByLabelText(/Token budget/u), '900000');
    expect(within(sheet).getByRole('button', { name: 'Review' })).toBeEnabled();
  });

  it('posts pattern overseer with the lead as its only member, the rest suggested in the goal', async () => {
    const posts: Posted[] = [];
    mount(<App />, { route: ROUTE, respond: serving({ posts, agents: THREE }) });
    openTeam();
    const sheet = await dialog();

    const user = userEvent.setup();
    await user.type(within(sheet).getByLabelText(/What should/u), 'Ship the importer rewrite');
    await user.type(within(sheet).getByLabelText(/Token budget/u), '900000');
    // The lead is the user's pick out of the selection, not a capability check.
    await user.selectOptions(within(sheet).getByLabelText('Lead'), 'rio');

    // The screen says what the goal will say, so the user is not told less than
    // the lead is — asserted before Review, because Review replaces the form.
    expect(within(sheet).getByText(/the lead decides the final split/u)).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Review' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    const body = posts[0]?.body ?? {};
    expect(body['pattern']).toBe('overseer');
    // **One** member: the workers hold seats in the children, never here (§3.5).
    expect(body['members']).toEqual([{ agentId: 'rio', role: 'overseer' }]);
    expect(body['tokenBudget']).toBe(900_000);
    expect(body['roundCap']).toBe(3);
    expect(body['autoStart']).toBe(false);

    // The others ride in the goal as a preference the lead may overrule.
    const goal = String(body['goal']);
    expect(goal).toContain('Ship the importer rewrite');
    expect(goal).toContain('Prefer seating these agents in child assignments');
    expect(goal).toContain('Ada (ada)');
    expect(goal).toContain('Sam (sam)');
    expect(goal).not.toContain('Rio (rio)');
    expect(goal).toContain('the final split is yours');
  });
});

describe('the flow closes the way every dialog does (§15)', () => {
  it('closes on Escape', async () => {
    mount(<App />, { route: ROUTE, respond: serving({}) });
    open();
    const sheet = await dialog();
    const user = userEvent.setup();
    sheet.focus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start work' })).toBeNull());
  });
});

describe('a remote start of two ungranted agents (§13.4, IMPLEMENTATION §10)', () => {
  it('prompts once, from the 409 body’s list, and retries automatically', async () => {
    const posts: Posted[] = [];
    let refused = true;
    const base = serving({ posts });
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
      return base(url, init);
    };

    mount(<App />, { route: ROUTE, respond, token: 'a-device-token' });
    open();
    const sheet = await dialog();

    const user = userEvent.setup();
    await fillIn(sheet, user, 'go');
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
