/**
 * Start work with **one** agent — the solo path (DESIGN §6; IMPLEMENTATION §3).
 *
 * These are the launch flow's own assertions, moved to the geography of the one
 * flow rather than rewritten: the fast path is still **type, Enter**, the
 * elevation banner is still never collapsed, the work-edition refusal still
 * renders disabled with its reason, a `429` still reads as an explanation rather
 * than a stack trace, and a `409` is still a question with an automatic retry.
 * The dialog they are asserted against is the only thing that changed.
 *
 * The whole app is mounted rather than the component: the pickers read the
 * roster and the project list through the real query layer, and the submit goes
 * through the real `ApiClient` so `429` arrives as the typed outcome §3.1
 * defines.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { anAgent, aProject, BOOT_FACTS, json, mount, type Responder } from '../../test/harness';
import { App } from '../App';
import type { AgentView, EffectiveConfig, Project } from '../api/types';
import { PATTERNS } from '../assignments/fixtures';
import { useAppStore, type StartWorkIntent } from '../state/store';

import { defaultRole, preselectedAgentIds } from './model';

const PRIYA = anAgent({ id: 'priya', name: 'Priya' });
const LPM = aProject({ id: 'lpm', name: 'littlepocketmuseum' });

interface Options {
  readonly agents?: readonly AgentView[];
  readonly projects?: readonly Project[];
  readonly defaults?: Record<string, unknown>;
  readonly solo?: { status: number; body: unknown };
  readonly validate?: { status: number; body: unknown };
}

function serving(options: Options = {}): {
  respond: Responder;
  posts: string[];
  bodies: unknown[];
} {
  const posts: string[] = [];
  const bodies: unknown[] = [];
  const agents = options.agents ?? [PRIYA];
  const projects = options.projects ?? [LPM];

  const respond: Responder = (url, init) => {
    const path = url.split('?')[0] ?? url;
    if (init.method === 'POST' || init.method === 'PUT') posts.push(path);
    if (path === '/api/roster/agents') return json({ agents, diagnostics: [] });
    if (path === '/api/projects') return json({ projects });
    if (path === '/api/patterns') return json(PATTERNS);
    // §10.4's open-assignment count, from the list the app already reads.
    if (path === '/api/assignments' && init.method !== 'POST') return json({ assignments: [] });
    if (path === '/api/assignments/solo') {
      bodies.push(typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined);
      const answer = options.solo ?? {
        status: 201,
        body: { assignmentId: 'as1', sessionId: 'se1', warnings: [] },
      };
      return json(answer.body, answer.status);
    }
    if (path.endsWith('/validate')) {
      // The route is mounted since roster M8; the default is a refusal, which
      // is what the panel has to render honestly.
      const answer = options.validate ?? {
        status: 400,
        body: { error: 'unknown_project', message: 'No project "ghost" exists.' },
      };
      return json(answer.body, answer.status);
    }
    if (path.startsWith('/api/projects/')) {
      const id = path.slice('/api/projects/'.length);
      const project = projects.find((one) => one.id === id);
      return project === undefined
        ? json({ error: 'not_found', message: 'no such project' }, 404)
        : json({ ...project, defaults: options.defaults ?? { agentIds: [] } });
    }
    if (path.startsWith('/api/sessions/')) {
      return json({ error: 'not_found', message: 'no session yet' }, 404);
    }
    if (path.endsWith('/avatar')) return new Response(new Blob(['png']), { status: 200 });
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
  return { respond, posts, bodies };
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
 * The task box, by role rather than by its label.
 *
 * §6's label names the agent ("What should **Priya** do?"), so it reads "they"
 * for the instant before the roster query answers — and a test that queried the
 * finished wording would be asserting a race rather than the flow. It is the
 * only textbox on the solo path; the pattern fields belong to two agents or
 * more.
 */
function taskOf(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('textbox');
}

describe('the pre-fill rules (§6)', () => {
  it('defaults the role to implementer where the agent declares it', () => {
    expect(defaultRole(anAgent({ id: 'a' }))).toBeUndefined();
    const declared = {
      ...anAgent({ id: 'a' }),
      definition: {
        ...anAgent({ id: 'a' }).definition,
        capabilities: { roles: ['architect', 'implementer'] },
      },
    };
    expect(defaultRole(declared)).toBe('implementer');
    const noImplementer = {
      ...declared,
      definition: { ...declared.definition, capabilities: { roles: ['skeptic'] } },
    };
    expect(defaultRole(noImplementer)).toBe('skeptic');
  });

  it('pre-selects the project’s default agents when the flow opens project-first', () => {
    const fromDrag = { agentIds: ['priya'], projectId: 'lpm', origin: 'drag' as const };
    expect(preselectedAgentIds(fromDrag, ['sam'])).toEqual(['priya']);
    const fromProject = { agentIds: [], projectId: 'lpm', origin: 'project' as const };
    // **All** of them, not `agentIds[0]`: the flow can seat every agent the
    // project nominates, so dropping the rest would narrow what it asked for.
    expect(preselectedAgentIds(fromProject, ['sam', 'ada'])).toEqual(['sam', 'ada']);
    expect(preselectedAgentIds(fromProject, undefined)).toEqual([]);
  });

  it('reads defaults.agentIds from the project and ticks them', async () => {
    const fixture = serving({
      agents: [PRIYA, anAgent({ id: 'sam', name: 'Sam' })],
      defaults: { agentIds: ['sam'] },
    });
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentIds: [], projectId: 'lpm', origin: 'project' });
    const dialog = await flow();
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: /^Sam/u })).toBeChecked(),
    );
    expect(within(dialog).getByRole('checkbox', { name: /^Priya/u })).not.toBeChecked();
  });

  it('skips the project step when the gesture carried one, and still lets it change', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    // No picker: the question is already answered (§6).
    expect(within(dialog).queryByLabelText('Project')).toBeNull();
    await waitFor(() => expect(within(dialog).getByText('littlepocketmuseum')).toBeInTheDocument());
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Change project' }));
    expect(within(dialog).getByLabelText('Project')).toBeInTheDocument();
  });
});

describe('the fast path: type, Enter (§6)', () => {
  it('autofocuses the task and submits POST /api/assignments/solo on Enter', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    const task = taskOf(dialog);
    await waitFor(() => expect(task).toHaveFocus());

    const user = userEvent.setup();
    await user.keyboard('reproduce the 500 on /invoices{Enter}');

    await waitFor(() => expect(fixture.posts).toContain('/api/assignments/solo'));
    // orchestrator §16.7's body, and nothing invented alongside it.
    expect(fixture.bodies).toEqual([
      { projectId: 'lpm', agentId: 'priya', prompt: 'reproduce the 500 on /invoices' },
    ]);
    // The flow closes and the app navigates to the session it started (§6).
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start work' })).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Session' })).toBeInTheDocument(),
    );
  });

  it('leaves Shift+Enter as a newline, because a multi-line brief is normal', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    const task = taskOf(dialog);
    await waitFor(() => expect(task).toHaveFocus());

    const user = userEvent.setup();
    await user.keyboard('first{Shift>}{Enter}{/Shift}second');
    expect(task).toHaveValue('first\nsecond');
    expect(fixture.posts).not.toContain('/api/assignments/solo');
  });

  it('refuses to start with no task, and says which field is missing', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    expect(within(dialog).getByRole('button', { name: /Start work/u })).toBeDisabled();
    // The reason, in words, beside the button that is off.
    await waitFor(() => expect(within(dialog).getByText('Describe the task.')).toBeInTheDocument());
  });

  it('has a ≥44px target on every control, for touch (§15, IMPLEMENTATION §3)', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    // Asserted against the stylesheet rather than against jsdom's zero layout:
    // every interactive element in the flow carries a class the sheet sizes.
    for (const control of within(dialog).getAllByRole('button')) {
      expect(control.className, control.textContent ?? '').toMatch(/button|card-menu/u);
    }
    // Every roster row is a `.startwork__agent` label, which the sheet gives a
    // 44px minimum — the checkbox itself is never the target.
    for (const box of within(dialog).getAllByRole('checkbox')) {
      expect(box.closest('.startwork__agent, .launch__toggle')).not.toBeNull();
    }
  });
});

describe('the elevation banner is never collapsed (§6)', () => {
  const elevated = {
    agentIds: [],
    permissionElevation: {
      allow: ['Bash(git push:*)'],
      reason: 'the deploy script needs to push tags',
    },
  };

  it('shows the widened rules and the reason before launch', async () => {
    const fixture = serving({ defaults: elevated });
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    await waitFor(() =>
      expect(within(dialog).getByText('Elevated permissions')).toBeInTheDocument(),
    );
    expect(within(dialog).getByText('Bash(git push:*)')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Reason: the deploy script needs to push tags'),
    ).toBeInTheDocument();
  });

  it('renders disabled with the work-edition reason and the layer that set it (§13.5)', async () => {
    const fixture = serving({ defaults: elevated });
    const boot = {
      ...BOOT_FACTS,
      config: {
        ...BOOT_FACTS.config,
        edition: 'work',
        config: { policy: { allowPermissionElevation: false } },
        sources: { 'policy.allowPermissionElevation': { layer: 'edition', origin: 'work' } },
      } satisfies EffectiveConfig,
    };
    mount(<App />, { respond: fixture.respond, boot });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    await waitFor(() =>
      expect(within(dialog).getByText('Elevated permissions')).toBeInTheDocument(),
    );
    // Shown disabled with a reason, not hidden.
    const banner = within(dialog).getByRole('note');
    expect(banner).toHaveAttribute('data-permitted', 'false');
    expect(banner.textContent).toContain('not permitted on this machine (work edition)');
    expect(banner.textContent).toContain('set by the edition layer');
    expect(banner.textContent).toContain('Bash(git push:*)');
  });
});

describe('the permission preview (§6)', () => {
  it('shows roster’s refusal verbatim and guesses nothing', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    const user = userEvent.setup();
    await user.click(within(dialog).getByText('Permissions'));

    await waitFor(() =>
      expect(within(dialog).getByText('No project "ghost" exists.')).toBeInTheDocument(),
    );
    // Nothing is guessed: no mode, no rule list.
    expect(within(dialog).queryByText('Mode')).toBeNull();
  });

  it('renders roster’s compiled set when the route answers', async () => {
    const fixture = serving({
      validate: {
        status: 200,
        body: {
          effective: {
            mode: 'acceptEdits',
            allow: ['Read', 'Edit'],
            deny: ['Bash(rm:*)'],
            ask: [],
            elevation: null,
          },
          diagnostics: [],
        },
      },
    });
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    const user = userEvent.setup();
    await user.click(within(dialog).getByText('Permissions'));
    await waitFor(() => expect(within(dialog).getByText('acceptEdits')).toBeInTheDocument());
    expect(within(dialog).getByText('Read, Edit')).toBeInTheDocument();
    expect(within(dialog).getByText('Bash(rm:*)')).toBeInTheDocument();
  });
});

describe('failure handling (§6, IMPLEMENTATION §3)', () => {
  it('renders 429 queue_full as an explanation with a link to the queue', async () => {
    const message =
      'The launch queue is full (50 of 50 waiting). Nothing was recorded — start this session ' +
      'again when the queue drains.';
    const fixture = serving({
      solo: { status: 429, body: { error: 'queue_full', message, queued: 50, limit: 50 } },
    });
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    const task = taskOf(dialog);
    await waitFor(() => expect(task).toHaveFocus());
    const user = userEvent.setup();
    await user.keyboard('go{Enter}');

    const alert = await within(dialog).findByRole('alert');
    // The server's message, verbatim — not a stack trace, not a paraphrase.
    expect(alert.textContent).toContain(message);
    expect(alert).toHaveAttribute('data-error-code', 'queue_full');
    expect(within(alert).getByRole('link', { name: 'See the queue' })).toHaveAttribute(
      'href',
      '/usage',
    );
    // Still open, so the task is not lost.
    expect(screen.getByRole('dialog', { name: 'Start work' })).toBeInTheDocument();
  });

  it('surfaces a 503 with the server’s own words', async () => {
    const fixture = serving({
      solo: {
        status: 503,
        body: {
          error: 'runner_unavailable',
          message: 'The runner module is not running, so no session can be started.',
        },
      },
    });
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    const task = taskOf(dialog);
    await waitFor(() => expect(task).toHaveFocus());
    await userEvent.setup().keyboard('go{Enter}');

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('The runner module is not running');
  });
});

describe('the degraded states of §3.5', () => {
  it('says why nothing can be started when the orchestrator module is absent', async () => {
    const fixture = serving();
    const boot = {
      ...BOOT_FACTS,
      health: {
        ...BOOT_FACTS.health,
        modules: BOOT_FACTS.health.modules.filter((one) => one.id !== 'orchestrator'),
      },
    };
    mount(<App />, { respond: fixture.respond, boot });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    expect(within(dialog).getByRole('alert').textContent).toContain(
      'The orchestrator module is not running',
    );
    expect(within(dialog).getByRole('button', { name: /Start work/u })).toBeDisabled();
  });

  it('omits the remote toggle when the remote module is not loaded (§13.5)', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    expect(within(dialog).queryByText(/Allow remote starts/u)).toBeNull();
  });

  it('shows the remote toggle when the module is present', async () => {
    const fixture = serving();
    const boot = {
      ...BOOT_FACTS,
      health: {
        ...BOOT_FACTS.health,
        modules: [...BOOT_FACTS.health.modules, { id: 'remote', status: 'ok' as const }],
      },
    };
    mount(<App />, { respond: fixture.respond, boot });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    await waitFor(() =>
      expect(within(dialog).getByText(/Allow remote starts for Priya/u)).toBeInTheDocument(),
    );
  });
});

/**
 * IMPLEMENTATION §10: "A remote launch of an ungranted agent shows the grant
 * prompt and retries automatically — tested against **`POST /api/assignments/
 * solo`**, the path the UI actually uses."
 */
describe('the grant prompt and its automatic retry (§6, §13.4)', () => {
  const REMOTE_BOOT = {
    ...BOOT_FACTS,
    health: {
      ...BOOT_FACTS.health,
      modules: [...BOOT_FACTS.health.modules, { id: 'remote', status: 'ok' as const }],
    },
  };

  it('asks once, then retries the original request with the atomic grant', async () => {
    let refused = true;
    const posts: unknown[] = [];
    const base = serving();
    const respond: Responder = (url, init) => {
      const path = url.split('?')[0] ?? url;
      if (path === '/api/assignments/solo' && init.method === 'POST') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        posts.push(body);
        if (refused && body['confirmRemoteAccess'] !== true) {
          refused = false;
          return json(
            {
              error: 'remote_access_required',
              message: 'These agents have not been allowed to be started remotely yet.',
              agents: [{ agentId: 'priya', agentName: 'Priya' }],
            },
            409,
          );
        }
        return json({ assignmentId: 'as1', sessionId: 'se1', warnings: [] }, 201);
      }
      return base.respond(url, init);
    };

    mount(<App />, { respond, boot: REMOTE_BOOT, token: 'a-device-token' });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    const user = userEvent.setup();
    await user.type(taskOf(dialog), 'Fix the billing migration{Enter}');

    // Not an error — a question (§13.4: "Never presented as an error").
    const prompt = await screen.findByText(/Allow Priya to be started remotely\?/u);
    expect(prompt.closest('[data-grant-prompt="true"]')).not.toBeNull();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(posts).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Allow and start' }));

    // The same request, once more, with the grant made in the same call.
    await waitFor(() => expect(posts).toHaveLength(2));
    const retry = posts[1] as Record<string, unknown>;
    expect(retry['confirmRemoteAccess']).toBe(true);
    expect(retry['prompt']).toBe('Fix the billing migration');
    expect(retry['agentId']).toBe('priya');
    // And the session opened, so the extra tap cost the user nothing else.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Session' })).toBeInTheDocument(),
    );
  });

  it('pre-authorises from the desk instead, through remote’s grant route (§6)', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond, boot: REMOTE_BOOT });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    const user = userEvent.setup();
    await user.click(await within(dialog).findByLabelText(/Allow remote starts for Priya/u));
    await waitFor(() => expect(fixture.posts).toContain('/api/remote/agents/priya/access'));
    // Nothing was launched by ticking a box.
    expect(fixture.posts).not.toContain('/api/assignments/solo');
  });
});

describe('Escape closes the flow and starts nothing (§15)', () => {
  it('closes without a request', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentIds: ['priya'], projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    await waitFor(() => expect(taskOf(dialog)).toHaveFocus());
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start work' })).toBeNull());
    expect(fixture.posts).not.toContain('/api/assignments/solo');
  });
});
