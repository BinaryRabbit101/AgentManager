/**
 * The launch flow, rendered (DESIGN §6; IMPLEMENTATION §3).
 *
 * The fast path is the criterion: **type, Enter**. Everything else in §6 is a
 * rule about what must be visible before that happens — the elevation and its
 * reason, the work-edition refusal, and a queue-full refusal that reads as an
 * explanation rather than a stack trace.
 *
 * The whole app is mounted rather than the component: the pickers read the roster
 * and the project list through the real query layer, and the submit goes through
 * the real `ApiClient` so `429` arrives as the typed outcome §3.1 defines.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { anAgent, aProject, BOOT_FACTS, json, mount, type Responder } from '../../test/harness';
import { App } from '../App';
import type { AgentView, EffectiveConfig, Project } from '../api/types';
import { useAppStore } from '../state/store';

import { defaultRole, preselectedAgentId } from './LaunchFlow';

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
    if (path === '/api/assignments/solo') {
      bodies.push(typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined);
      const answer = options.solo ?? {
        status: 201,
        body: { assignmentId: 'as1', sessionId: 'se1', warnings: [] },
      };
      return json(answer.body, answer.status);
    }
    if (path.endsWith('/validate')) {
      // roster M8 is not mounted in this build; the default is its 404.
      const answer = options.validate ?? {
        status: 404,
        body: { error: 'not_found', message: 'No route POST /api/roster/agents/priya/validate.' },
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

function openFlow(
  intent: Parameters<ReturnType<typeof useAppStore.getState>['openLaunch']>[0],
): void {
  useAppStore.getState().openLaunch(intent);
}

beforeEach(() => {
  useAppStore.getState().closeLaunch();
});

async function flow(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: 'Launch' });
}

/**
 * The prompt, by role rather than by its label.
 *
 * §6's label names the agent ("What should **Priya** do?"), so it reads "the
 * agent" for the instant before the roster query answers — and a test that
 * queried the finished wording would be asserting a race rather than the flow.
 */
function promptOf(dialog: HTMLElement): HTMLElement {
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

  it('pre-selects the project’s first default agent when the flow opens project-first', () => {
    const fromDrag = { agentId: 'priya', projectId: 'lpm', origin: 'drag' as const };
    expect(preselectedAgentId(fromDrag, ['sam'])).toBe('priya');
    const fromProject = { agentId: null, projectId: 'lpm', origin: 'project' as const };
    expect(preselectedAgentId(fromProject, ['sam', 'ada'])).toBe('sam');
    expect(preselectedAgentId(fromProject, undefined)).toBeNull();
  });

  it('reads defaults.agentIds from the project and fills the picker', async () => {
    const fixture = serving({
      agents: [PRIYA, anAgent({ id: 'sam', name: 'Sam' })],
      defaults: { agentIds: ['sam'] },
    });
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentId: null, projectId: 'lpm', origin: 'project' });
    const dialog = await flow();
    await waitFor(() => expect(within(dialog).getByLabelText('Agent')).toHaveValue('sam'));
  });
});

describe('the fast path: type, Enter (§6)', () => {
  it('autofocuses the prompt and submits POST /api/assignments/solo on Enter', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    const prompt = promptOf(dialog);
    await waitFor(() => expect(prompt).toHaveFocus());

    const user = userEvent.setup();
    await user.keyboard('reproduce the 500 on /invoices{Enter}');

    await waitFor(() => expect(fixture.posts).toContain('/api/assignments/solo'));
    // orchestrator §16.7's body, and nothing invented alongside it.
    expect(fixture.bodies).toEqual([
      { projectId: 'lpm', agentId: 'priya', prompt: 'reproduce the 500 on /invoices' },
    ]);
    // The flow closes and the app navigates to the session it started (§6).
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Launch' })).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Session' })).toBeInTheDocument(),
    );
  });

  it('leaves Shift+Enter as a newline, because a multi-line brief is normal', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    const prompt = promptOf(dialog);
    await waitFor(() => expect(prompt).toHaveFocus());

    const user = userEvent.setup();
    await user.keyboard('first{Shift>}{Enter}{/Shift}second');
    expect(prompt).toHaveValue('first\nsecond');
    expect(fixture.posts).not.toContain('/api/assignments/solo');
  });

  it('refuses to launch with no prompt', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    expect(within(dialog).getByRole('button', { name: /Launch/u })).toBeDisabled();
  });

  it('has a ≥44px target on every control, for touch (§15, IMPLEMENTATION §3)', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    // Asserted against the stylesheet rather than against jsdom's zero layout:
    // every interactive element in the flow carries a class the sheet sizes.
    for (const control of within(dialog).getAllByRole('button')) {
      expect(control.className, control.textContent ?? '').toMatch(/button|card-menu/u);
    }
    expect(within(dialog).getByLabelText('Agent').closest('.field')).not.toBeNull();
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
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
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
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
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

describe('the permission preview, and the roster M8 gap (§6)', () => {
  it('hides the panel behind one sentence when /validate is not mounted', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    const user = userEvent.setup();
    await user.click(within(dialog).getByText('Permissions'));

    await waitFor(() =>
      expect(within(dialog).getByText('permission preview available soon')).toBeInTheDocument(),
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
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
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
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    const prompt = promptOf(dialog);
    await waitFor(() => expect(prompt).toHaveFocus());
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
    // Still open, so the prompt is not lost.
    expect(screen.getByRole('dialog', { name: 'Launch' })).toBeInTheDocument();
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
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    const prompt = promptOf(dialog);
    await waitFor(() => expect(prompt).toHaveFocus());
    await userEvent.setup().keyboard('go{Enter}');

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('The runner module is not running');
  });
});

describe('the degraded states of §3.5', () => {
  it('says why nothing can be launched when the orchestrator module is absent', async () => {
    const fixture = serving();
    const boot = {
      ...BOOT_FACTS,
      health: {
        ...BOOT_FACTS.health,
        modules: BOOT_FACTS.health.modules.filter((one) => one.name !== 'orchestrator'),
      },
    };
    mount(<App />, { respond: fixture.respond, boot });
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();

    expect(within(dialog).getByRole('alert').textContent).toContain(
      'The orchestrator module is not running',
    );
    expect(within(dialog).getByRole('button', { name: /Launch/u })).toBeDisabled();
  });

  it('omits the remote toggle when the remote module is not loaded (§13.5)', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    expect(within(dialog).queryByText(/Allow remote starts/u)).toBeNull();
  });

  it('shows the remote toggle when the module is present', async () => {
    const fixture = serving();
    const boot = {
      ...BOOT_FACTS,
      health: {
        ...BOOT_FACTS.health,
        modules: [...BOOT_FACTS.health.modules, { name: 'remote', status: 'ok' as const }],
      },
    };
    mount(<App />, { respond: fixture.respond, boot });
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    await waitFor(() =>
      expect(within(dialog).getByText(/Allow remote starts for Priya/u)).toBeInTheDocument(),
    );
  });
});

describe('Escape closes the flow and starts nothing (§15)', () => {
  it('closes without a request', async () => {
    const fixture = serving();
    mount(<App />, { respond: fixture.respond });
    openFlow({ agentId: 'priya', projectId: 'lpm', origin: 'drag' });
    const dialog = await flow();
    await waitFor(() => expect(promptOf(dialog)).toHaveFocus());
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Launch' })).toBeNull());
    expect(fixture.posts).not.toContain('/api/assignments/solo');
  });
});
