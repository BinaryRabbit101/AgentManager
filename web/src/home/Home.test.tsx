/**
 * The home screen, rendered (DESIGN §2.4; §11.3's one answer path).
 *
 * These mount the **whole app** at `/` rather than the `Home` component, for the
 * reason the board's tests do: what home promises is not all inside the
 * component. The card it answers is the inbox's card, the POST it makes is the
 * inbox's POST, and the geography it claims — home at `/`, the board at
 * `/agents` — is the router's. A test that rendered `Home` in isolation would
 * prove the markup and none of that.
 *
 * Only `fetch` and the SSE transport are substituted. Everything else is the
 * production path.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { anAgent, aProject, json, mount, type Responder } from '../../test/harness';
import { App } from '../App';
import type { QuestionCard, SessionRecord } from '../api/types';

const ADA = anAgent({ id: 'ada', name: 'Ada' });
const LPM = aProject({ id: 'lpm', name: 'littlepocketmuseum' });

function aSession(overrides: Partial<SessionRecord> & { readonly id: string }): SessionRecord {
  return {
    assignmentId: 'asg_1',
    agentId: 'ada',
    projectId: 'lpm',
    status: 'running',
    sdkSessionId: null,
    model: 'claude',
    permissionMode: 'default',
    origin: 'local',
    transcriptPath: 'C:\\transcripts\\one.jsonl',
    transcriptBytes: 10,
    summary: null,
    pinned: false,
    startedAt: '2026-08-17T09:00:00.000Z',
    endedAt: null,
    exitReason: null,
    role: 'implementer',
    resumedFrom: null,
    blockedReason: null,
    turns: 1,
    ...overrides,
  };
}

const QUESTION: QuestionCard = {
  id: 'q1',
  kind: 'question',
  status: 'open',
  prompt: 'Store transcripts in the DB or on disk?',
  options: [
    { id: 'disk', label: 'On disk' },
    { id: 'db', label: 'In SQLite' },
  ],
  multiSelect: false,
  allowFreeText: false,
  context: null,
  createdAt: '2026-08-17T09:00:00.000Z',
  holdUntil: null,
  expiresAt: null,
  assignmentId: 'asg_1',
  projectId: 'lpm',
  sessionId: 'ses_run',
  recommendations: [],
  disagreement: false,
  contested: false,
  answeredVia: null,
  answeredAt: null,
  answer: null,
} as unknown as QuestionCard;

interface Fixture {
  readonly respond: Responder;
  /** Every non-GET call, which is how "one endpoint" is asserted. */
  readonly posts: { url: string; body: unknown }[];
}

/**
 * One responder for all three regions, because home is one screen.
 *
 * `sessions` is served the way the core serves it — filtered by `status` when
 * one is asked for, and newest-first over everything when none is.
 */
function serving(options: {
  questions?: readonly QuestionCard[];
  assignments?: readonly unknown[];
  sessions?: readonly SessionRecord[];
}): Fixture {
  const sessions = options.sessions ?? [];
  const posts: { url: string; body: unknown }[] = [];
  const respond: Responder = (url, init) => {
    if (init.method !== undefined && init.method !== 'GET') {
      posts.push({
        url,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      });
      return json({ ...QUESTION, status: 'answered', answeredVia: 'ui' });
    }
    const [path, query] = url.split('?');
    switch (path) {
      case '/api/roster/agents':
        return json({ agents: [ADA], diagnostics: [] });
      case '/api/projects':
        return json({ projects: [LPM] });
      case '/api/questions':
        return json({ questions: options.questions ?? [] });
      case '/api/assignments':
        return json({ assignments: options.assignments ?? [] });
      case '/api/orchestrator/status':
        return json({
          agents: [],
          assignments: { open: 0, halted: 0, awaitingUser: 0 },
          questions: { open: options.questions?.length ?? 0, oldestOpenedAt: null },
        });
      case '/api/sessions': {
        const status = new URLSearchParams(query ?? '').get('status');
        return json({
          sessions: status === null ? sessions : sessions.filter((one) => one.status === status),
          next: null,
        });
      }
      default:
        if ((path ?? '').endsWith('/avatar'))
          return new Response(new Blob(['png']), { status: 200 });
        return json({ error: 'not_found', message: `No fixture for ${path ?? url}.` }, 404);
    }
  };
  return { respond, posts };
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

describe('home is the three regions, in priority order (§2.4)', () => {
  it('shows what needs you, what is running and what just finished', async () => {
    const fixture = serving({
      questions: [QUESTION],
      assignments: [
        {
          id: 'asg_halt',
          projectId: 'lpm',
          pattern: 'solo',
          status: 'open',
          phase: 'halted',
          goal: 'Move transcripts off the hot path',
          scope: null,
          write: false,
          createdBy: 'user',
          parentAssignmentId: null,
          leadAgentId: 'ada',
          artifactPath: null,
          tokenBudget: null,
          tokensUsed: 0,
          roundCap: null,
          roundsUsed: 0,
          haltReason: 'budget_exhausted',
          closeReason: null,
          createdAt: '2026-08-17T09:00:00.000Z',
          updatedAt: null,
          closedAt: null,
          members: [],
        },
      ],
      sessions: [
        aSession({ id: 'ses_run' }),
        aSession({ id: 'ses_queued', status: 'queued', startedAt: null }),
        aSession({
          id: 'ses_done',
          status: 'done',
          endedAt: '2026-08-17T10:00:00.000Z',
          summary: 'Rewrote the importer',
        }),
        aSession({ id: 'ses_failed', status: 'failed', exitReason: 'tool_error' }),
      ],
    });
    mount(<App />, { respond: fixture.respond });

    // 1. Needs you: the card itself, and the halted assignment as a row to go to.
    await screen.findByText('Store transcripts in the DB or on disk?');
    const needs = region('Needs you');
    expect(within(needs).getByText('Store transcripts in the DB or on disk?')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(needs).getByRole('link', { name: 'Move transcripts off the hot path' }),
      ).toHaveAttribute('href', '/assignments/asg_halt'),
    );
    expect(within(needs).getByText('budget exhausted')).toBeInTheDocument();

    // 2. Running now: the live session and the queued one behind it, each a link
    //    to its own page, with the elapsed time in words.
    const running = region('Running now');
    await waitFor(() =>
      expect(running.querySelector('[data-session-id="ses_run"]')).not.toBeNull(),
    );
    // The name carries the avatar's own accessible name beside the agent's, so
    // the match is on the agent rather than on the exact composed string.
    expect(within(running).getAllByRole('link', { name: /Ada/u })[0]).toHaveAttribute(
      'href',
      '/sessions/ses_run',
    );
    expect(within(running).getAllByText('littlepocketmuseum').length).toBeGreaterThan(0);
    expect(within(running).getByText(/running for/u)).toBeInTheDocument();
    expect(running.querySelector('[data-session-id="ses_queued"]')).not.toBeNull();
    expect(within(running).getByText('waiting for a slot')).toBeInTheDocument();

    // 3. Recently finished: the outcome as a word, linking to the transcript.
    const recent = region('Recently finished');
    await waitFor(() =>
      expect(recent.querySelector('[data-session-id="ses_done"]')).not.toBeNull(),
    );
    expect(within(recent).getByText('done')).toBeInTheDocument();
    expect(within(recent).getByText('Rewrote the importer')).toBeInTheDocument();
    expect(within(recent).getByText('tool error')).toBeInTheDocument();
    // The running session is not in the finished region, and vice versa.
    expect(recent.querySelector('[data-session-id="ses_run"]')).toBeNull();
    expect(running.querySelector('[data-session-id="ses_done"]')).toBeNull();
  });

  it('answers a card in place, through the one endpoint the inbox uses (§11.3)', async () => {
    const fixture = serving({ questions: [QUESTION], sessions: [] });
    mount(<App />, { respond: fixture.respond });

    const card = await screen.findByText('Store transcripts in the DB or on disk?');
    expect(card).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /On disk/u }));

    await waitFor(() => expect(fixture.posts).toHaveLength(1));
    expect(fixture.posts[0]?.url).toBe('/api/questions/q1/answer');
    expect(fixture.posts[0]?.body).toEqual({ optionIds: ['disk'] });
    // The optimistic move is the inbox's: the card leaves the open list.
    await waitFor(() =>
      expect(screen.queryByText('Store transcripts in the DB or on disk?')).toBeNull(),
    );
  });

  it('teaches rather than apologises when there is nothing to show', async () => {
    mount(<App />, { respond: serving({}).respond });

    expect(await screen.findByText('Nothing needs you.')).toBeInTheDocument();
    // Not "nothing is running" — nothing has *ever* run, which is a different
    // sentence and the only one that says what to do about it.
    const running = region('Running now');
    await waitFor(() => expect(within(running).getByText(/Nothing has run yet/u)).toBeVisible());
    expect(
      within(running).getByRole('link', { name: /Launch an agent at a project/u }),
    ).toHaveAttribute('href', '/projects');
    expect(
      within(region('Recently finished')).getByText(/Nothing has finished yet/u),
    ).toBeVisible();
  });

  it('offers Start work from the running region, without hunting for an agent first', async () => {
    mount(<App />, { respond: serving({}).respond });
    const start = await within(region('Running now')).findByRole('button', { name: 'Start work' });

    await userEvent.click(start);

    // §6's one flow, opened with neither question answered — home knows neither
    // the agents nor the project, and the flow is where both are asked.
    expect(await screen.findByRole('dialog', { name: 'Start work' })).toBeInTheDocument();
  });

  it('follows the event feed rather than polling (§3.4, §16)', async () => {
    const fixture = serving({ sessions: [aSession({ id: 'ses_run' })] });
    const mounted = mount(<App />, { respond: fixture.respond });
    await waitFor(() =>
      expect(region('Running now').querySelector('[data-session-id="ses_run"]')).not.toBeNull(),
    );

    const before = mounted.calls.filter((url) => url.startsWith('/api/sessions')).length;
    mounted.stream.emit({ id: 'e1', type: 'session.ended', ids: { sessionId: 'ses_run' } });

    // A lifecycle frame invalidates `['sessions']`, so the regions refetch —
    // which is the only reason they are allowed not to poll.
    await waitFor(() =>
      expect(mounted.calls.filter((url) => url.startsWith('/api/sessions')).length).toBeGreaterThan(
        before,
      ),
    );
  });
});

describe('the board moved to /agents (§2.1)', () => {
  it('renders the roster there, not at home', async () => {
    mount(<App />, { respond: serving({}).respond, route: '/agents' });
    expect(await screen.findByRole('link', { name: 'Ada' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
  });

  it('keeps the deeper agent routes ahead of it, as react-router ranks them', () => {
    const wizard = mount(<App />, { respond: serving({}).respond, route: '/agents/new' });
    expect(screen.getByRole('heading', { level: 2, name: /New agent/u })).toBeInTheDocument();
    wizard.unmount();

    mount(<App />, { respond: serving({}).respond, route: '/agents/ada' });
    // The editor, not the board: a board here would mean `/agents` had swallowed
    // its own children.
    expect(screen.queryByRole('group', { name: 'Filters' })).toBeNull();
  });
});
