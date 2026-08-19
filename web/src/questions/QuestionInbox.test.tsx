/**
 * The question inbox, rendered (DESIGN §11; IMPLEMENTATION §5).
 *
 * The milestone's hardest criterion is a **request count**: "A cold `/questions`
 * load issuing a second request is a milestone failure." So the first thing here
 * counts requests, and every card fixture is orchestrator §11.1's projection —
 * recommendations inline, ids denormalised — because that is what makes one
 * request enough.
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { json, mount, type Responder } from '../../test/harness';
import { App } from '../App';
import type { QuestionCard } from '../api/types';

function aCard(overrides: Partial<QuestionCard> = {}): QuestionCard {
  return {
    id: 'q1',
    kind: 'question',
    status: 'open',
    prompt: 'Store transcripts in the DB or on disk?',
    options: [
      { id: 'disk', label: 'On disk' },
      { id: 'db', label: 'In SQLite' },
    ],
    multiSelect: false,
    allowFreeText: true,
    context: null,
    createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    holdUntil: null,
    // A minute past twenty hours, so the label is not on a rounding boundary.
    expiresAt: new Date(Date.now() + 20 * 3_600_000 + 60_000).toISOString(),
    assignmentId: 'a1',
    projectId: 'lpm',
    sessionId: 's1',
    recommendations: [],
    disagreement: false,
    contested: false,
    answeredVia: null,
    answeredAt: null,
    answer: null,
    ...overrides,
  };
}

const STANCES: QuestionCard['recommendations'] = [
  {
    agentId: 'sam',
    role: 'skeptic',
    stance: 'On disk',
    strength: 'blocking',
    rationale: 'A 500MB transcript in SQLite blows the WAL.',
  },
  {
    agentId: 'ada',
    role: 'architect',
    stance: 'In SQLite',
    strength: 'lean',
    rationale: 'One store is simpler to back up.',
  },
];

interface Options {
  readonly open?: readonly QuestionCard[];
  readonly answered?: readonly QuestionCard[];
  readonly one?: QuestionCard;
  readonly answer?: { status: number; body: unknown };
  /** The roster half of "Always allow" (runner §5.1), when a test varies it. */
  readonly allow?: { status: number; body: unknown };
}

function serving(options: Options = {}): {
  respond: Responder;
  answerCalls: { id: string; body: unknown }[];
  allowCalls: { agentId: string; body: unknown }[];
} {
  const answerCalls: { id: string; body: unknown }[] = [];
  const allowCalls: { agentId: string; body: unknown }[] = [];
  // The fixture keeps the server's own record, because "the card moves to
  // Answered" is a fact about the server's lists as much as about the cache.
  let openCards = [...(options.open ?? [])];
  let answeredCards = [...(options.answered ?? [])];

  const respond: Responder = (url, init) => {
    const [path = url, query = ''] = url.split('?');
    if (path === '/api/questions') {
      return json({ questions: query.includes('status=answered') ? answeredCards : openCards });
    }
    if (path.endsWith('/answer')) {
      const id = path.slice('/api/questions/'.length, -'/answer'.length);
      const body: unknown =
        typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      answerCalls.push({ id, body });
      if (options.answer !== undefined) return json(options.answer.body, options.answer.status);
      const source = [...openCards, ...answeredCards, options.one]
        .filter((card): card is QuestionCard => card !== undefined)
        .find((card) => card.id === id);
      const request = body as { optionIds?: string[]; text?: string } | undefined;
      const settled: QuestionCard = {
        ...(source ?? aCard({ id })),
        status: 'answered',
        answeredVia: 'local',
        answeredAt: new Date().toISOString(),
        answer: {
          ...(request?.optionIds === undefined ? {} : { optionIds: request.optionIds }),
          ...(request?.text === undefined ? {} : { text: request.text }),
        },
      };
      openCards = openCards.filter((card) => card.id !== id);
      answeredCards = [settled, ...answeredCards];
      return json(settled);
    }
    if (path.startsWith('/api/questions/')) {
      const id = path.slice('/api/questions/'.length);
      const card =
        [...openCards, ...answeredCards].find((one) => one.id === id) ??
        (options.one?.id === id ? options.one : undefined);
      return card === undefined
        ? json({ error: 'question_not_found', message: `No question ${id} exists.` }, 404)
        : json(card);
    }
    if (path.endsWith('/permissions/allow')) {
      const agentId = path.slice('/api/roster/agents/'.length, -'/permissions/allow'.length);
      const body: unknown =
        typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      allowCalls.push({ agentId, body });
      if (options.allow !== undefined) return json(options.allow.body, options.allow.status);
      return json({ agent: { definition: { id: agentId } }, rule: '', added: true });
    }
    if (path === '/api/roster/agents') return json({ agents: [], diagnostics: [] });
    if (path === '/api/projects') return json({ projects: [] });
    if (path.startsWith('/api/sessions/')) return json({ error: 'nope', message: 'no' }, 404);
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
  return { respond, answerCalls, allowCalls };
}

function inbox(
  options: Options = {},
  route = '/questions',
): ReturnType<typeof mount> & {
  answerCalls: { id: string; body: unknown }[];
  allowCalls: { agentId: string; body: unknown }[];
} {
  const fixture = serving(options);
  const view = mount(<App />, { respond: fixture.respond, route });
  return Object.assign(view, {
    answerCalls: fixture.answerCalls,
    allowCalls: fixture.allowCalls,
  });
}

describe('one request, cold (§11.1, IMPLEMENTATION §5)', () => {
  it('draws every card from a single GET /api/questions', async () => {
    const view = inbox({ open: [aCard({ recommendations: STANCES })] });
    await waitFor(() =>
      expect(screen.getByText('Store transcripts in the DB or on disk?')).toBeInTheDocument(),
    );

    // No roster fetch, no project fetch, no assignment fetch: the projection
    // carries the recommendations inline and the ids denormalised.
    const questionCalls = view.calls.filter((url) => url.startsWith('/api/questions'));
    expect(questionCalls).toHaveLength(1);
    expect(questionCalls[0]).toContain('status=open');
    expect(view.calls.some((url) => url.startsWith('/api/roster'))).toBe(false);
    expect(view.calls.some((url) => url.startsWith('/api/assignments'))).toBe(false);
  });

  it('says nothing is waiting rather than showing an empty list', async () => {
    inbox({ open: [] });
    await waitFor(() => expect(screen.getByText('Nothing is waiting on you.')).toBeInTheDocument());
  });
});

describe('all three kinds render from one component (§16-3, IMPLEMENTATION §5)', () => {
  it('gives each its own chip and the server’s own options', async () => {
    inbox({
      open: [
        aCard({ id: 'q1', kind: 'question', prompt: 'Which store?' }),
        aCard({
          id: 'g1',
          kind: 'approval_gate',
          prompt: 'Let this pair write to src/?',
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'deny', label: 'Deny' },
          ],
        }),
        aCard({
          id: 'b1',
          kind: 'budget_halt',
          prompt: 'Raise the budget by 50%?',
          options: [
            { id: 'raise', label: 'Raise by 50%' },
            { id: 'stop', label: 'Stop here' },
          ],
        }),
      ],
    });
    await waitFor(() => expect(screen.getByText('Which store?')).toBeInTheDocument());

    expect(screen.getByText('QUESTION')).toBeInTheDocument();
    expect(screen.getByText('APPROVAL')).toBeInTheDocument();
    expect(screen.getByText('BUDGET')).toBeInTheDocument();
    // Same DOM shape for all three — one component, no per-kind branch.
    expect(document.querySelectorAll('.question-card')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /Raise by 50%/u })).toBeInTheDocument();
    // And no invented option anywhere.
    expect(screen.queryByRole('button', { name: /do nothing/iu })).toBeNull();
  });
});

describe('stances are words, and nothing else (§11.2, IMPLEMENTATION §5)', () => {
  it('renders the word for every rung, with no number, percentage or bar', async () => {
    inbox({
      open: [
        aCard({
          recommendations: [
            ...STANCES,
            { agentId: 'bea', role: 'reviewer', stance: null, strength: 'defer', rationale: null },
            {
              agentId: 'cyd',
              role: 'implementer',
              stance: 'In SQLite',
              strength: 'strong',
              rationale: null,
            },
          ],
        }),
      ],
    });
    await waitFor(() => expect(screen.getByText('BLOCKING')).toBeInTheDocument());

    const stances = document.querySelector('.question-card__stances');
    expect(stances?.textContent).toContain('BLOCKING');
    expect(stances?.textContent).toContain('lean');
    expect(stances?.textContent).toContain('defer');
    expect(stances?.textContent).toContain('strong');
    // A scan of the rendered output finds no numeric confidence and no bar.
    expect(stances?.textContent).not.toMatch(/[0-9]+\s*%/u);
    expect(stances?.querySelector('progress')).toBeNull();
    expect(stances?.querySelector('meter')).toBeNull();
    // Colour is carried by an emphasis attribute, beside the word — never alone.
    expect(stances?.querySelector('[data-emphasis="shout"]')).not.toBeNull();
  });

  it('keeps the server’s order and does not sort', async () => {
    // `blocking` first is the server's rank; the UI must not re-derive it, so a
    // fixture in the *other* order must render in the order it arrived.
    inbox({ open: [aCard({ recommendations: [...STANCES].reverse() })] });
    await waitFor(() => expect(screen.getByText('lean')).toBeInTheDocument());
    const who = [...document.querySelectorAll('.question-card__who')].map(
      (node) => node.textContent ?? '',
    );
    expect(who[0]).toContain('ada');
    expect(who[1]).toContain('sam');
  });

  it('attributes an engine-raised gate to AgentManager, never to an agent', async () => {
    inbox({
      open: [aCard({ id: 'g1', kind: 'approval_gate', prompt: 'Approve?', recommendations: [] })],
    });
    // Scoped to the card: the app frame's own title is also "AgentManager", and
    // matching that would prove nothing about the attribution.
    await waitFor(() => expect(document.querySelector('.question-card__asked')).not.toBeNull());
    const asked = document.querySelector('.question-card__asked');
    expect(within(asked as HTMLElement).getByText('AgentManager')).toHaveAttribute(
      'data-attribution',
      'engine',
    );
    // And an agent-raised gate is never attributed to the engine.
    expect(
      within(asked as HTMLElement)
        .queryByText('AgentManager')
        ?.getAttribute('data-attribution'),
    ).not.toBe('agent');
  });
});

describe('disagreement and contested are read flags (§16-1, IMPLEMENTATION §5)', () => {
  it('renders the divider and the banner from the flags, and nothing else changes', async () => {
    const base = aCard({ recommendations: STANCES });
    const view = inbox({ open: [{ ...base, disagreement: false, contested: false }] });
    await waitFor(() => expect(screen.getByText('BLOCKING')).toBeInTheDocument());
    expect(document.querySelector('[data-flag="disagreement"]')).toBeNull();
    expect(document.querySelector('[data-flag="contested"]')).toBeNull();
    view.unmount();

    // Only the flags are flipped — the same recommendations, the same everything.
    inbox({ open: [{ ...base, disagreement: true, contested: true }] });
    await waitFor(() =>
      expect(document.querySelector('[data-flag="disagreement"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-flag="disagreement"]')?.textContent).toBe(
      'The team disagrees',
    );
    expect(document.querySelector('[data-flag="contested"]')?.textContent).toContain('contested');
  });
});

describe('expiry is a countdown with no default action (§16-4, IMPLEMENTATION §5)', () => {
  it('counts down and offers nothing that acts on the deadline', async () => {
    inbox({ open: [aCard({ kind: 'approval_gate' })] });
    await waitFor(() => expect(screen.getByText('expires in 20h')).toBeInTheDocument());

    const card = document.querySelector('.question-card');
    const buttons = [...(card?.querySelectorAll('button') ?? [])].map(
      (button) => button.textContent ?? '',
    );
    // Exactly the server's options plus Submit for the free-text field.
    expect(buttons).toEqual(['On disk', 'In SQLite', 'Submit']);
    expect(card?.textContent).not.toMatch(/on expiry|by default|automatically/iu);
  });
});

describe('the answer flow (§11.3, IMPLEMENTATION §5)', () => {
  it('posts the chosen option and moves the card to Answered optimistically', async () => {
    const view = inbox({ open: [aCard()] });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'On disk' })).toBeInTheDocument(),
    );

    await act(async () => {
      await userEvent.setup().click(screen.getByRole('button', { name: 'On disk' }));
    });

    await waitFor(() => expect(view.answerCalls).toHaveLength(1));
    expect(view.answerCalls[0]).toEqual({ id: 'q1', body: { optionIds: ['disk'] } });
    // Gone from Open without a refetch standing between the tap and the change.
    await waitFor(() => expect(screen.getByText('Nothing is waiting on you.')).toBeInTheDocument());

    await act(async () => {
      await userEvent.setup().click(screen.getByRole('tab', { name: 'Answered' }));
    });
    await waitFor(() => expect(screen.getByText(/Answered local/u)).toBeInTheDocument());
  });

  it('sends free text when the card allows it', async () => {
    const view = inbox({ open: [aCard()] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument());

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/in your own words/u), 'neither — use both');
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Submit' }));
    });
    await waitFor(() => expect(view.answerCalls).toHaveLength(1));
    expect(view.answerCalls[0]?.body).toEqual({ text: 'neither — use both' });
  });

  it('collects a multi-select into one submit', async () => {
    const view = inbox({
      open: [
        aCard({
          multiSelect: true,
          allowFreeText: false,
          options: [
            { id: 'design', label: 'design' },
            { id: 'impl', label: 'implementation' },
          ],
        }),
      ],
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'design' })).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'design' }));
    await user.click(screen.getByRole('button', { name: 'implementation' }));
    expect(screen.getByRole('button', { name: 'design' })).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Submit' }));
    });
    await waitFor(() => expect(view.answerCalls).toHaveLength(1));
    expect(view.answerCalls[0]?.body).toEqual({ optionIds: ['design', 'impl'] });
  });

  it('shows the server’s refusal verbatim when someone answered first', async () => {
    const message = 'Question q1 is answered; only an open question can be answered.';
    inbox({
      open: [aCard()],
      answer: { status: 409, body: { error: 'question_not_open', message } },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'On disk' })).toBeInTheDocument(),
    );
    await act(async () => {
      await userEvent.setup().click(screen.getByRole('button', { name: 'On disk' }));
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message));
  });
});

describe('the deep link (§2.1, IMPLEMENTATION §5)', () => {
  it('renders an answerable card cold, in one request', async () => {
    const view = inbox({ one: aCard({ id: 'abc', recommendations: STANCES }) }, '/questions/abc');
    await waitFor(() =>
      expect(screen.getByText('Store transcripts in the DB or on disk?')).toBeInTheDocument(),
    );

    expect(view.calls.filter((url) => url.startsWith('/api/questions'))).toEqual([
      '/api/questions/abc',
    ]);
    // Answerable, not a link to somewhere answerable.
    expect(screen.getByRole('button', { name: 'On disk' })).toBeEnabled();

    await act(async () => {
      await userEvent.setup().click(screen.getByRole('button', { name: 'On disk' }));
    });
    await waitFor(() => expect(view.answerCalls).toHaveLength(1));
  });

  it('says so when the id names nothing, using the server’s message', async () => {
    inbox({}, '/questions/ghost');
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('No question ghost exists.'),
    );
  });
});

describe('the rail badge (§2.2, IMPLEMENTATION §5)', () => {
  it('shows the open count and clears it on answer', async () => {
    inbox({ open: [aCard({ id: 'q1' }), aCard({ id: 'q2', prompt: 'Second?' })] });
    await waitFor(() => expect(screen.getByText('Second?')).toBeInTheDocument());

    const badge = document.querySelector('[data-badge="questions"]');
    expect(badge?.textContent).toContain('2');

    await act(async () => {
      await userEvent
        .setup()
        .click(screen.getAllByRole('button', { name: 'On disk' })[0] as HTMLElement);
    });
    await waitFor(() =>
      expect(document.querySelector('[data-badge="questions"]')?.textContent).toContain('1'),
    );
  });

  it('bumps within one event of a question being raised, with no refetch in between', async () => {
    const view = inbox({ open: [] });
    await waitFor(() => expect(screen.getByText('Nothing is waiting on you.')).toBeInTheDocument());
    expect(document.querySelector('[data-badge="questions"]')).toBeNull();

    await act(async () => {
      view.stream.emit({
        id: '01RAISED',
        type: 'assignment.question.raised',
        ids: { assignmentId: 'a1', sessionId: 's1' },
        payload: { questionId: 'q9' },
      });
      await Promise.resolve();
    });

    // The store holds the count, so the badge does not wait for a round trip.
    await waitFor(() =>
      expect(document.querySelector('[data-badge="questions"]')?.textContent).toContain('1'),
    );

    await act(async () => {
      view.stream.emit({
        id: '01ANSWERED',
        type: 'assignment.question.answered',
        ids: { assignmentId: 'a1' },
        payload: { questionId: 'q9' },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelector('[data-badge="questions"]')).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// "Always allow" — runner DESIGN §5.1's third option (owner decision 2026-08-18)
// ---------------------------------------------------------------------------

/**
 * A tool gate carrying the server's derived rule.
 *
 * Every field here is the *server's*: runner puts the option in `options` and
 * the rule and agent in `context`. The UI derives none of it, which is the
 * property the first test below asserts and the reason the rest are possible.
 */
function aToolGate(overrides: Partial<QuestionCard> = {}): QuestionCard {
  return aCard({
    id: 'tg1',
    prompt: 'Claude wants to run npm run build',
    options: [
      { id: 'allow', label: 'Allow once' },
      { id: 'allow-always', label: 'Always allow' },
      { id: 'deny', label: 'Deny' },
    ],
    context: {
      toolName: 'Bash',
      toolInput: { command: 'npm run build' },
      durableRule: 'Bash(npm run:*)',
      agentId: 'priya',
    },
    ...overrides,
  });
}

async function clickAlways(): Promise<void> {
  await act(async () => {
    await userEvent.setup().click(screen.getByRole('button', { name: /Always allow/u }));
  });
}

describe('Always allow (runner §5.1, owner decision 2026-08-18)', () => {
  it('shows the rule on the button BEFORE the click', async () => {
    inbox({ open: [aToolGate()] });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Always allow/u })).toBeInTheDocument(),
    );

    // §11.2's argument about the gated call, applied to the standing permission:
    // a button that names no scope asks the user to approve what they cannot see.
    const button = screen.getByRole('button', { name: /Always allow/u });
    expect(button.textContent).toContain('Bash(npm run:*)');
    expect(button.textContent).toContain('priya');
    expect(button.getAttribute('data-durable-rule')).toBe('Bash(npm run:*)');
  });

  it('makes two calls in order: the answer, then the roster edit', async () => {
    const view = inbox({ open: [aToolGate()] });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Always allow/u })).toBeInTheDocument(),
    );

    await clickAlways();

    await waitFor(() => expect(view.allowCalls).toHaveLength(1));
    expect(view.answerCalls).toEqual([{ id: 'tg1', body: { optionIds: ['allow-always'] } }]);
    // The rule the server put on the card, sent back verbatim — the UI never
    // composes one of its own.
    expect(view.allowCalls[0]).toEqual({
      agentId: 'priya',
      body: { rule: 'Bash(npm run:*)' },
    });
    // Order is load-bearing: the answer is what releases the agent, and a roster
    // write must never hold up a call a human already approved.
    const order = view.calls.filter(
      (url) => url.endsWith('/answer') || url.endsWith('/permissions/allow'),
    );
    expect(order).toEqual([
      '/api/questions/tg1/answer',
      '/api/roster/agents/priya/permissions/allow',
    ]);
  });

  it('says what was remembered, for whom, and when it applies', async () => {
    inbox({ open: [aToolGate()] });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Always allow/u })).toBeInTheDocument(),
    );
    await clickAlways();

    const notice = await screen.findByText(/remembered for priya/u);
    // "applies from its next session" is the honest part: the rule is compiled
    // into the agent's options at launch, so it does nothing to the run that
    // just continued.
    expect(notice.textContent).toContain('Bash(npm run:*)');
    expect(notice.textContent).toContain('applies from its next session');
    expect(notice.textContent).toContain('Manage in the agent editor');
    expect(notice.getAttribute('data-answer-notice')).toBe('ok');
  });

  it('says the call ran and the remembering failed, in the server’s own words', async () => {
    const view = inbox({
      open: [aToolGate()],
      allow: {
        status: 400,
        body: {
          error: 'permission_rule_not_enforceable',
          message: '"Bash(npm run:*)" was refused: the rule engine would not honour it',
        },
      },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Always allow/u })).toBeInTheDocument(),
    );
    await clickAlways();

    const notice = await screen.findByText(/was not saved for priya/u);
    // Never "saved". The call ran; the rule did not land; the user has to know
    // the card will be back.
    expect(notice.textContent).toContain('The call was allowed');
    expect(notice.textContent).toContain('would not honour it');
    expect(notice.getAttribute('data-answer-notice')).toBe('danger');
    // And the answer itself still went through, exactly once.
    expect(view.answerCalls).toHaveLength(1);
  });

  it('makes no roster call when the answer itself failed', async () => {
    const view = inbox({
      open: [aToolGate()],
      answer: {
        status: 409,
        body: { error: 'question_not_open', message: 'That question was already answered.' },
      },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Always allow/u })).toBeInTheDocument(),
    );
    await clickAlways();

    await waitFor(() =>
      expect(screen.getByText('That question was already answered.')).toBeInTheDocument(),
    );
    // Nothing ran, so there is nothing to remember.
    expect(view.allowCalls).toEqual([]);
  });

  it('answers once, with no roster call, when the option carries no rule', async () => {
    // An older core, or a call no rule honestly describes: the option is there
    // but `context` names no rule, so the click is an ordinary allow-once. It is
    // never a click that silently drops the remembering it advertised — because
    // without a rule there is nothing on the button advertising it.
    const view = inbox({
      open: [aToolGate({ context: { toolName: 'Bash', toolInput: { command: 'x' } } })],
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Always allow/u })).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: /Always allow/u }).getAttribute('data-durable-rule'),
    ).toBeNull();

    await clickAlways();
    await waitFor(() => expect(view.answerCalls).toHaveLength(1));
    expect(view.allowCalls).toEqual([]);
  });

  it('leaves a card with only two options alone', async () => {
    inbox({
      open: [
        aToolGate({
          options: [
            { id: 'allow', label: 'Allow once' },
            { id: 'deny', label: 'Deny' },
          ],
        }),
      ],
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Allow once/u })).toBeInTheDocument(),
    );
    // The UI never invents an option (§11.2), so a card the server did not
    // widen stays two buttons even though its context names a rule.
    expect(screen.queryByRole('button', { name: /Always allow/u })).toBeNull();
  });

  it('works the same on the deep-link route', async () => {
    const card = aToolGate();
    const view = inbox({ one: card }, `/questions/${card.id}`);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Always allow/u })).toBeInTheDocument(),
    );
    await clickAlways();

    await waitFor(() => expect(view.allowCalls).toHaveLength(1));
    expect(await screen.findByText(/remembered for priya/u)).toBeInTheDocument();
  });
});
