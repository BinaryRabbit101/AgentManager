/**
 * The project page (ui IMPLEMENTATION §7).
 *
 * Criteria, each as a named test:
 *
 * - a worktree with unmerged commits under **Review needed**, Clean up behind a
 *   confirmation naming the branch, a clean worktree never there;
 * - the timeline's `outcome` matching the server in all four cases — read, never
 *   derived;
 * - a pruned transcript saying so and offering no dead link;
 * - dropping an agent on a work item (and its pointer-free equivalent) opening
 *   the launch flow with the item attached and its scope paths shown, and the
 *   created assignment carrying `workItemIds`;
 * - **no project env value anywhere in the DOM**;
 * - all four health states rendering, and `missing` offering Relocate that keeps
 *   the project id.
 *
 * The clone half of §7 is `clone.test.ts` (the fold) and
 * `QuickAddDialog.test.tsx` (the flow); the rail's progress row is asserted here
 * only where it belongs to this page, which is nowhere.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../App';
import { aProject, anAgent, json, mount, type Responder } from '../../test/harness';
import type {
  AssignmentOutcome,
  ProjectActivityEntry,
  Project,
  WorkItem,
  WorkspaceListEntry,
} from '../api/types';
import { useAppStore } from '../state/store';

afterEach(() => useAppStore.getState().reset());

const AGENT = anAgent({ id: 'priya', name: 'Priya' });

function anEntry(overrides: Partial<ProjectActivityEntry> = {}): ProjectActivityEntry {
  return {
    assignmentId: 'as1',
    workItemIds: [],
    agentIds: ['priya'],
    pattern: null,
    scopeSummary: 'src/api',
    workspace: { kind: 'worktree', path: 'C:\\wt\\a', branch: 'am/as1' },
    startedAt: '2026-08-16T10:00:00.000Z',
    endedAt: null,
    outcome: 'running',
    tokens: { input: 100, output: 50 },
    sessions: [
      {
        id: 'se1',
        agentId: 'priya',
        status: 'running',
        transcriptAvailable: true,
        summary: 'Reproducing the 500',
        pinned: false,
        startedAt: '2026-08-16T10:00:00.000Z',
        endedAt: null,
      },
    ],
    ...overrides,
  };
}

function aWorkItem(overrides: Partial<WorkItem> & { readonly id: string }): WorkItem {
  return {
    projectId: 'lpm',
    kind: 'bug',
    title: overrides.id,
    body: '',
    status: 'open',
    rank: 1,
    scopePaths: [],
    source: 'user',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

function aLease(overrides: Partial<WorkspaceListEntry> & { readonly id: string }) {
  return {
    projectId: 'lpm',
    assignmentId: 'as1',
    kind: 'worktree' as const,
    path: 'C:\\wt\\a',
    branch: 'am/as1',
    baseCommit: 'abc',
    write: true,
    state: 'released' as const,
    acquiredAt: '2026-08-16T10:00:00.000Z',
    releasedAt: '2026-08-16T11:00:00.000Z',
    scopePaths: [],
    ...overrides,
  };
}

interface Fixture {
  readonly project?: Partial<Project> & { readonly defaults?: unknown };
  readonly entries?: readonly ProjectActivityEntry[];
  readonly workItems?: readonly WorkItem[];
  readonly workspaces?: readonly unknown[];
}

function serving(fixture: Fixture = {}) {
  const posted: { path: string; method: string; body: unknown }[] = [];
  const project = {
    ...aProject({ id: 'lpm', name: 'littlepocketmuseum' }),
    defaults: {},
    workspacePolicy: 'auto',
    retention: null,
    ...fixture.project,
  };

  const respond: Responder = (url, init) => {
    const path = url.split('?')[0] ?? url;
    if (init.method !== undefined && init.method !== 'GET') {
      posted.push({
        path,
        method: init.method,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
    }
    if (path === '/api/projects') return json({ projects: [project] });
    if (path === '/api/projects/lpm') return json(project);
    if (path === '/api/projects/lpm/activity') {
      return json({ entries: fixture.entries ?? [], total: 0, limit: 50, offset: 0 });
    }
    if (path === '/api/projects/lpm/work-items') {
      if (init.method === 'POST') return json(aWorkItem({ id: 'new' }), 201);
      return json({ workItems: fixture.workItems ?? [] });
    }
    if (path === '/api/projects/lpm/workspaces') {
      return json({ workspaces: fixture.workspaces ?? [] });
    }
    if (path.startsWith('/api/work-items/')) return json(aWorkItem({ id: 'w1' }));
    if (path === '/api/projects/lpm/relocate') return json(project);
    if (path.includes('/workspaces/') && path.endsWith('/cleanup')) return json({ removed: true });
    if (path === '/api/roster/agents') return json({ agents: [AGENT], diagnostics: [] });
    if (path === '/api/orchestrator/status') {
      return json({
        agents: [],
        assignments: { open: 0, halted: 0, awaitingUser: 0 },
        questions: { open: 0, oldestOpenedAt: null },
      });
    }
    if (path === '/api/assignments/solo') {
      return json({ assignmentId: 'as9', sessionId: 'se9', warnings: [] }, 201);
    }
    if (path.endsWith('/validate')) return json({ effective: null }, 400);
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
  return { respond, posted };
}

function open(fixture: Fixture = {}) {
  const api = serving(fixture);
  const mounted = mount(<App />, { respond: api.respond, route: '/projects/lpm' });
  return { ...mounted, posted: api.posted };
}

// ---------------------------------------------------------------------------
// Header and health
// ---------------------------------------------------------------------------

describe('the header (§8.2 region 1)', () => {
  it('renders every health state the server computes', async () => {
    open({
      project: {
        health: [
          { code: 'missing', level: 'error', message: 'The folder is gone.' },
          { code: 'dirty', level: 'warn', message: 'Uncommitted changes.' },
          { code: 'stale-agents', level: 'warn', message: 'A default agent is gone.' },
          { code: 'orphaned-worktrees', level: 'warn', message: 'A lease outlived its process.' },
        ],
      },
    });

    for (const code of ['missing', 'dirty', 'stale-agents', 'orphaned-worktrees']) {
      const chip = await screen.findByText(code);
      expect(chip).toHaveAttribute('data-health', code);
    }
  });

  it('offers Relocate only when the folder is missing, and keeps the project id', async () => {
    const view = open({
      project: {
        health: [{ code: 'missing', level: 'error', message: 'The folder is gone.' }],
      },
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Relocate' }));
    await user.type(screen.getByLabelText('New folder path'), 'D:\\Moved\\lpm');
    await user.click(screen.getByRole('button', { name: 'Relocate' }));

    await waitFor(() =>
      expect(view.posted.map((call) => call.path)).toContain('/api/projects/lpm/relocate'),
    );
    // The id is in the URL of the request: projects re-canonicalises the same
    // row, so the page's history is still this project's.
    expect(view.posted.at(-1)).toEqual({
      path: '/api/projects/lpm/relocate',
      method: 'POST',
      body: { localPath: 'D:\\Moved\\lpm' },
    });
  });

  it('has no Relocate when the folder is fine', async () => {
    open();
    await screen.findByRole('heading', { name: 'littlepocketmuseum' });
    expect(screen.queryByRole('button', { name: 'Relocate' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Review needed
// ---------------------------------------------------------------------------

describe('Review needed (§8.2 region 2)', () => {
  it('lists a worktree with unmerged commits, with its branch and count', async () => {
    open({
      workspaces: [aLease({ id: 'l1', review: { commits: 3, dirty: false, present: true } })],
    });

    const region = await screen.findByRole('region', { name: 'Review needed' });
    expect(within(region).getByText('am/as1')).toBeInTheDocument();
    expect(region.textContent).toContain('3 commits');
  });

  it('never shows a clean worktree there', async () => {
    open({
      workspaces: [aLease({ id: 'l1', review: { commits: 0, dirty: false, present: true } })],
    });
    await screen.findByRole('heading', { name: 'littlepocketmuseum' });
    expect(screen.queryByRole('region', { name: 'Review needed' })).toBeNull();
  });

  it('requires a confirmation that names the branch before cleaning up', async () => {
    // Projects never discards agent output on its own (§4.4), so the UI never
    // makes cleanup one click — and the dialog says which branch is going.
    const view = open({
      workspaces: [aLease({ id: 'l1', review: { commits: 2, dirty: true, present: true } })],
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Clean up' }));
    const dialog = screen.getByRole('dialog', { name: 'Clean up worktree' });
    expect(dialog.textContent).toContain('am/as1');
    expect(view.posted).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Remove am/as1' }));
    await waitFor(() =>
      expect(view.posted.at(-1)?.path).toBe('/api/projects/lpm/workspaces/l1/cleanup'),
    );
  });
});

// ---------------------------------------------------------------------------
// Activity timeline
// ---------------------------------------------------------------------------

describe('the activity timeline (§8.2 region 3)', () => {
  it('renders the server’s outcome in all four cases, read and never derived', async () => {
    const outcomes: readonly AssignmentOutcome[] = ['running', 'completed', 'stopped', 'failed'];
    open({
      entries: outcomes.map((outcome, index) =>
        anEntry({
          assignmentId: `as${String(index)}`,
          outcome,
          // Session statuses that would *derive* a different answer if the UI
          // were deriving: every row here has one `done` session.
          sessions: [
            {
              id: `se${String(index)}`,
              agentId: 'priya',
              status: 'done',
              transcriptAvailable: true,
              summary: null,
              pinned: false,
              startedAt: null,
              endedAt: null,
            },
          ],
        }),
      ),
    });

    for (const outcome of outcomes) {
      const chip = await screen.findByText(outcome);
      expect(chip).toHaveAttribute('data-outcome', outcome);
    }
  });

  it('says "transcript pruned" and offers no link when the transcript is gone', async () => {
    open({
      entries: [
        anEntry({
          sessions: [
            {
              id: 'se1',
              agentId: 'priya',
              status: 'done',
              transcriptAvailable: false,
              summary: 'Finished',
              pinned: false,
              startedAt: null,
              endedAt: null,
            },
          ],
        }),
      ],
    });

    const pruned = await screen.findByText('transcript pruned');
    expect(pruned).toHaveAttribute('data-transcript', 'pruned');
    expect(screen.queryByRole('link', { name: 'transcript' })).toBeNull();
  });

  it('links to the transcript when it is there', async () => {
    open({ entries: [anEntry()] });
    const link = await screen.findByRole('link', { name: 'transcript' });
    expect(link).toHaveAttribute('href', '/sessions/se1');
  });
});

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

describe('work items (§8.2 region 4, §5.3 row 2)', () => {
  const items = [
    aWorkItem({ id: 'w1', title: 'Fix the 500 on /invoices', scopePaths: ['src/api'], rank: 1 }),
    aWorkItem({ id: 'w2', title: 'Tidy the tests', rank: 2 }),
  ];

  it('creates one from a title alone', async () => {
    const view = open({ workItems: items });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('New work item'), 'Rotate the log');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(view.posted.at(-1)).toEqual({
        path: '/api/projects/lpm/work-items',
        method: 'POST',
        body: { title: 'Rotate the log' },
      }),
    );
  });

  it('reorders with ▲▼ as a single rank patch', async () => {
    const view = open({ workItems: items });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Move Tidy the tests up' }));

    await waitFor(() =>
      expect(view.posted.at(-1)).toEqual({
        path: '/api/work-items/w2',
        method: 'PATCH',
        body: { rank: 0 },
      }),
    );
  });

  it('takes a keyboard drag from an agent chip onto a row (§5.3 row 2, §5.4)', async () => {
    // The real `KeyboardSensor` through dnd-kit, as the board's own test does.
    // The ring here is [this project, w1, w2] — the chip is a source and not a
    // target — so the lift lands on the project and one press reaches the item.
    const view = open({ workItems: items });
    const user = userEvent.setup();

    const chip = await screen.findByRole('button', { name: 'Launch Priya on a work item' });
    chip.focus();
    await user.keyboard(' ');
    const live = (): string =>
      [...document.querySelectorAll('[aria-live="assertive"]')]
        .map((region) => region.textContent ?? '')
        .join(' ');
    expect(live()).toContain('Picked up Priya');

    await user.keyboard('{ArrowDown}');
    expect(live()).toContain('Launch Priya on the work item “Fix the 500 on /invoices”.');

    await user.keyboard(' ');

    const dialog = await screen.findByRole('dialog', { name: 'Start work' });
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: /^Priya/u })).toBeChecked(),
    );
    // Nothing is started by the drop itself (§5.3).
    expect(view.posted.find((call) => call.path === '/api/assignments/solo')).toBeUndefined();
    expect(live()).toContain('Nothing has started yet');
  });

  it('opens Start work with the item attached and its scope paths shown', async () => {
    const view = open({ workItems: items });
    const user = userEvent.setup();

    const row = (await screen.findByText('Fix the 500 on /invoices')).closest('li');
    if (row === null) throw new Error('the work item row is not on the page');
    await user.click(within(row).getByRole('button', { name: 'Assign an agent…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Start work' });
    // §5.3: the title seeds the task and the scope paths are shown.
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/What should/u)).toHaveValue('Fix the 500 on /invoices'),
    );
    expect(within(dialog).getByText(/Scoped to src\/api/u)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('checkbox', { name: /^Priya/u }));
    await user.click(within(dialog).getByRole('button', { name: /Start work/u }));

    await waitFor(() =>
      expect(view.posted.find((call) => call.path === '/api/assignments/solo')).toBeDefined(),
    );
    // The created assignment carries them; projects flips the item to
    // `in_progress` server-side — the UI never sets a status it does not own.
    expect(view.posted.find((call) => call.path === '/api/assignments/solo')?.body).toMatchObject({
      projectId: 'lpm',
      agentId: 'priya',
      workItemIds: ['w1'],
    });
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('project settings (§8.2)', () => {
  it('never renders an env value, literal or referenced', async () => {
    const secret = 'super-secret-value';
    open({
      project: {
        defaults: {
          env: [
            { name: 'STRIPE_KEY', secretRef: 'project.lpm.STRIPE_KEY' },
            { name: 'LEGACY_TOKEN', value: secret },
          ],
        },
      },
    });

    await screen.findByRole('heading', { name: 'littlepocketmuseum' });
    await userEvent.click(screen.getByText('Settings', { selector: 'summary' }));

    expect(await screen.findByText('STRIPE_KEY')).toBeInTheDocument();
    expect(screen.getByText('LEGACY_TOKEN')).toBeInTheDocument();
    // The whole criterion, asserted over the whole document rather than over the
    // one element that happens to render it.
    expect(document.body.textContent).not.toContain(secret);
    expect(screen.getByText(/from the secret project\.lpm\.STRIPE_KEY/u)).toBeInTheDocument();
  });

  it('shows the elevation with its mandatory reason', async () => {
    open({
      project: {
        defaults: {
          permissionElevation: {
            allow: ['Bash(git push*)'],
            reason: 'the deploy script needs to push tags',
          },
        },
      },
    });
    await screen.findByRole('heading', { name: 'littlepocketmuseum' });
    await userEvent.click(screen.getByText('Settings', { selector: 'summary' }));

    expect(await screen.findByText('the deploy script needs to push tags')).toBeInTheDocument();
  });
});
