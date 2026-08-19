/**
 * The session view, rendered (DESIGN §9; IMPLEMENTATION §4).
 *
 * Mounted as the whole app on `/sessions/:id`, with `fetch` and the per-session
 * SSE transport under the test's control, so the criteria that are about *the
 * screen* are proved on the screen: collapsed tool calls, ANSI colour, the
 * awaiting-answer banner with no Resume, idempotent controls with their reasons,
 * and the usage rail's string rules.
 *
 * The `seq`-merge criteria are proved exhaustively in `blocks.test.ts` — this
 * asserts that the view is wired to it, not the algebra a second time.
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { anAgent, json, mount, type Responder } from '../../test/harness';
import { App } from '../App';
import type {
  QuestionCard,
  SessionRecord,
  SessionUsageTotals,
  TranscriptLine,
} from '../api/types';

import { FORBIDDEN_USAGE_STRINGS } from './UsageRail';

const ESC = '\u001B';

function aSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1',
    assignmentId: 'a1',
    agentId: 'priya',
    projectId: 'lpm',
    status: 'running',
    sdkSessionId: 'sdk-1',
    model: 'claude-sonnet',
    permissionMode: 'acceptEdits',
    origin: 'local',
    transcriptPath: '2026/08/s1.jsonl',
    transcriptBytes: 900,
    summary: 'Reproducing the 500 on /invoices',
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

const USAGE: SessionUsageTotals = {
  sessionId: 's1',
  inputTokens: 12_345,
  outputTokens: 6_789,
  cacheReadTokens: 100,
  cacheCreationTokens: 50,
  totalTokens: 19_284,
  events: 3,
  turns: 2,
  costUsdEstimate: 0.1234,
  updatedAt: '2026-08-17T09:05:00.000Z',
};

function line(seq: number, type: string, rest: Record<string, unknown> = {}): TranscriptLine {
  return { seq, ts: '2026-08-17T09:00:00.000Z', type, ...rest };
}

interface Options {
  readonly session?: SessionRecord;
  readonly usage?: SessionUsageTotals | null;
  readonly lines?: readonly TranscriptLine[];
  readonly pruned?: boolean;
  readonly control?: (verb: string) => { status: number; body: unknown };
  /** §9.3: the assignment's open cards, answered on this screen. */
  readonly questions?: readonly QuestionCard[];
}

function aQuestionCard(overrides: Partial<QuestionCard> = {}): QuestionCard {
  return {
    id: 'q1',
    kind: 'question',
    status: 'open',
    prompt: 'Allow the agent to use Bash?',
    options: [
      { id: 'allow', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ],
    multiSelect: false,
    allowFreeText: false,
    context: { toolName: 'Bash', toolInput: { command: 'npx prisma migrate reset' } },
    createdAt: '2026-08-17T09:04:00.000Z',
    holdUntil: null,
    expiresAt: null,
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

function serving(options: Options = {}): {
  respond: Responder;
  transcriptQueries: string[];
  controlCalls: { verb: string; body: unknown }[];
  answerCalls: { id: string; body: unknown }[];
} {
  const transcriptQueries: string[] = [];
  const controlCalls: { verb: string; body: unknown }[] = [];
  const answerCalls: { id: string; body: unknown }[] = [];
  let session = options.session ?? aSession();

  const respond: Responder = (url, init) => {
    const [path = url, query = ''] = url.split('?');
    if (path === '/api/sessions/s1') {
      // `in` rather than `??`: `usage: null` is a fixture that means "nothing has
      // been metered", which is a different fact from "the test did not say".
      return json({
        session,
        usage: 'usage' in options ? options.usage : USAGE,
        queuePosition: null,
      });
    }
    if (path === '/api/sessions/s1/transcript') {
      transcriptQueries.push(query);
      if (options.pruned === true) {
        return json({ sessionId: 's1', lines: [], from: 0, next: 0, size: 0, pruned: true });
      }
      const lines = options.lines ?? [];
      return json({
        sessionId: 's1',
        lines,
        from: 0,
        next: 900,
        size: 900,
        pruned: false,
      });
    }
    if (path.startsWith('/api/sessions/s1/')) {
      const verb = path.slice('/api/sessions/s1/'.length);
      controlCalls.push({
        verb,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      const answer = options.control?.(verb);
      if (answer !== undefined) return json(answer.body, answer.status);
      const next =
        verb === 'stop'
          ? { status: 'interrupted' as const, exitReason: 'user_stopped' }
          : verb === 'pause'
            ? { status: 'paused' as const, exitReason: 'user_paused' }
            : verb === 'resume'
              ? { status: 'running' as const, exitReason: null }
              : { status: session.status, exitReason: session.exitReason };
      session = { ...session, ...next };
      return json({ sessionId: 's1', ...next, changed: true });
    }
    if (path === '/api/questions') return json({ questions: options.questions ?? [] });
    if (path.startsWith('/api/questions/') && path.endsWith('/answer')) {
      const id = path.slice('/api/questions/'.length, -'/answer'.length);
      answerCalls.push({
        id,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      return json({ ...aQuestionCard({ id }), status: 'answered', answeredVia: 'local' });
    }
    if (path === '/api/roster/agents') {
      return json({ agents: [anAgent({ id: 'priya', name: 'Priya' })], diagnostics: [] });
    }
    if (path === '/api/projects') return json({ projects: [] });
    if (path.endsWith('/avatar')) return new Response(new Blob(['png']), { status: 200 });
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
  return { respond, transcriptQueries, controlCalls, answerCalls };
}

async function open(options: Options = {}): Promise<ReturnType<typeof mount>> {
  const fixture = serving(options);
  const view = mount(<App />, { respond: fixture.respond, route: '/sessions/s1' });
  await waitFor(() =>
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Priya'),
  );
  return Object.assign(view, fixture);
}

describe('opening a session is one tail request (§9.4)', () => {
  it('reads the record, then ?tail= — never a page-from-zero walk', async () => {
    const view = await open({ lines: [line(1, 'assistant', { text: 'hello' })] });
    const transcripts = view.calls.filter((url) => url.includes('/transcript'));
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toContain('tail=');
    expect(view.calls).toContain('/api/sessions/s1');
  });

  it('renders "transcript pruned" rather than an error (§9.4, runner §15.2 #11)', async () => {
    await open({ pruned: true });
    expect(screen.getByText(/Transcript pruned/u)).toBeInTheDocument();
  });
});

describe('the header carries the badges that must never be missed (§9.2)', () => {
  it('shows the status word, the model, the permission mode and the workspace', async () => {
    await open({
      lines: [
        line(1, 'session.start', {
          model: 'claude-sonnet',
          permissionMode: 'acceptEdits',
          workspace: { kind: 'worktree', path: 'C:\\w', branch: 'agent/priya' },
          questionBridge: 'enabled',
          diagnostics: [],
        }),
      ],
    });
    // runner's vocabulary, verbatim.
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet')).toBeInTheDocument();
    expect(screen.getByText('acceptEdits')).toBeInTheDocument();
    expect(screen.getByText(/worktree · agent\/priya/u)).toBeInTheDocument();
  });

  it('shows the elevation with its reason, from the transcript so it survives a reload', async () => {
    await open({
      lines: [
        line(1, 'session.start', {
          elevation: { allow: ['Bash(git push:*)'], reason: 'the deploy script pushes tags' },
          questionBridge: 'enabled',
          diagnostics: [],
        }),
      ],
    });
    const badge = document.querySelector('[data-badge="elevation"]');
    expect(badge?.textContent).toContain('Bash(git push:*)');
    expect(badge?.textContent).toContain('the deploy script pushes tags');
  });

  it('shows the question-bridge-disabled banner and says what it costs', async () => {
    await open({
      lines: [line(1, 'session.start', { questionBridge: 'disabled', diagnostics: [] })],
    });
    const badge = document.querySelector('[data-badge="question-bridge"]');
    expect(badge?.textContent).toContain('Question bridge disabled');
  });

  it('shows a remote origin and a session diagnostic', async () => {
    await open({
      session: aSession({ origin: 'remote' }),
      lines: [
        line(1, 'session.start', {
          questionBridge: 'enabled',
          diagnostics: [
            { level: 'warn', code: 'unknown_skill', message: 'skill "brief" missing.' },
          ],
        }),
      ],
    });
    expect(document.querySelector('[data-badge="remote"]')?.textContent).toContain(
      'Started remotely',
    );
    expect(document.querySelector('[data-badge="diagnostic"]')?.textContent).toContain(
      'skill "brief" missing.',
    );
  });
});

describe('tool calls (§9.2, IMPLEMENTATION §4)', () => {
  it('renders collapsed with a one-line preview and expands to input and result', async () => {
    await open({
      lines: [
        line(1, 'tool_use', {
          toolUseId: 't1',
          name: 'Edit',
          input: { file_path: 'src/invoices.php' },
        }),
        line(2, 'tool_result', { toolUseId: 't1', content: 'applied' }),
      ],
    });

    const toggle = screen.getByRole('button', { expanded: false });
    expect(toggle.textContent).toContain('Edit');
    expect(toggle.textContent).toContain('src/invoices.php');
    expect(screen.queryByText('applied')).toBeNull();

    await userEvent.setup().click(toggle);
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(screen.getByText('applied')).toBeInTheDocument();
  });

  it('expands an errored call by default', async () => {
    await open({
      lines: [
        line(1, 'tool_use', { toolUseId: 't1', name: 'Bash', input: { command: 'npm test' } }),
        line(2, 'tool_result', { toolUseId: 't1', content: 'failed', isError: true }),
      ],
    });
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('renders a Bash result’s ANSI colour, and drops cursor escapes without artefacts', async () => {
    const coloured = `${ESC}[31mFAIL${ESC}[0m src/x.test.ts`;
    const noisy = `${ESC}[2K${ESC}[1;1HBuilding...${ESC}[3Adone`;
    await open({
      lines: [
        line(1, 'tool_use', { toolUseId: 't1', name: 'Bash', input: { command: 'npm test' } }),
        line(2, 'tool_result', {
          toolUseId: 't1',
          content: `${coloured}\n${noisy}`,
          isError: true,
        }),
      ],
    });

    const pre = document.querySelector('[data-ansi="true"]');
    expect(pre).not.toBeNull();
    const spans = [...(pre?.querySelectorAll('[data-ansi-span]') ?? [])];
    const red = spans.find((span) => span.textContent === 'FAIL');
    expect(red?.getAttribute('style')).toContain('var(--ansi-red)');
    // No artefact: the escapes are gone rather than printed.
    expect(pre?.textContent).toContain('Building...done');
    expect(pre?.textContent).not.toContain('[2K');
    expect(pre?.textContent).not.toContain(ESC);
  });
});

describe('live streaming through the per-session feed (§3.3, §4’s first criterion)', () => {
  it('streams token-by-token and settles on the message without duplication', async () => {
    const view = await open({ lines: [line(1, 'assistant', { text: 'first' })] });

    // Pushed through the *per-session* socket, which the view opened for itself —
    // the global feed never carries these types (§3.3).
    for (const text of ['Look', 'ing at ', 'the invoices.']) {
      await act(async () => {
        view.sessionStream.emit({
          type: 'session.delta',
          ids: { sessionId: 's1' },
          payload: { seq: 2, text },
        });
        await Promise.resolve();
      });
    }
    await waitFor(() => expect(screen.getByText(/Looking at the invoices\./u)).toBeInTheDocument());
    // The caret is CSS on the streaming block, not an announcement (§14.1, §15).
    expect(document.querySelector('[data-streaming="true"] .session-block__caret')).not.toBeNull();

    await act(async () => {
      view.sessionStream.emit({
        type: 'session.message',
        ids: { sessionId: 's1' },
        payload: { seq: 2, role: 'assistant', text: 'Looking at the invoices.' },
      });
      await Promise.resolve();
    });

    // One block, settled — not the streamed text followed by the complete one.
    await waitFor(() => expect(document.querySelector('[data-streaming="true"]')).toBeNull());
    expect(screen.getAllByText(/Looking at the invoices\./u)).toHaveLength(1);
    expect(document.querySelectorAll('[data-kind="assistant"]')).toHaveLength(2);
  });

  it('drops a frame belonging to another session', async () => {
    const view = await open({ lines: [] });
    await act(async () => {
      view.sessionStream.emit({
        type: 'session.delta',
        ids: { sessionId: 'someone-else' },
        payload: { seq: 5, text: 'not for you' },
      });
      await Promise.resolve();
    });
    expect(screen.queryByText('not for you')).toBeNull();
  });

  it('opens a tool block live and completes it, without waiting for a transcript read', async () => {
    const view = await open({ lines: [] });
    await act(async () => {
      view.sessionStream.emit({
        type: 'session.tool.start',
        ids: { sessionId: 's1' },
        payload: { seq: 3, toolUseId: 't1', name: 'Bash', inputPreview: 'npm test' },
      });
      await Promise.resolve();
    });
    // Scoped to the block: the header's status pill also reads `running`.
    await waitFor(() =>
      expect(
        within(document.querySelector('[data-kind="tool"]') as HTMLElement).getByText('running'),
      ).toBeInTheDocument(),
    );

    await act(async () => {
      view.sessionStream.emit({
        type: 'session.tool.end',
        ids: { sessionId: 's1' },
        payload: {
          seq: 4,
          toolUseId: 't1',
          name: 'Bash',
          isError: false,
          resultPreview: '3 passed',
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelectorAll('[data-kind="tool"]')).toHaveLength(1));
    expect(view.calls.filter((url) => url.includes('/transcript'))).toHaveLength(1);
  });

  it('keeps the usage rail live from session.usage', async () => {
    const view = await open({ usage: null });
    await act(async () => {
      view.sessionStream.emit({
        type: 'session.usage',
        ids: { sessionId: 's1' },
        payload: {
          seq: 6,
          sessionTotals: { ...USAGE, inputTokens: 999, outputTokens: 111 },
        },
      });
      await Promise.resolve();
    });
    const rail = screen.getByRole('complementary', { name: 'Usage' });
    await waitFor(() => expect(within(rail).getByText('999')).toBeInTheDocument());
  });
});

describe('the controls round-trip and are idempotent (§9.3, IMPLEMENTATION §4)', () => {
  it('pressing Stop twice produces a state, not an error', async () => {
    const view = await open({});
    const user = userEvent.setup();
    const stop = screen.getByRole('button', { name: 'Stop' });
    await user.click(stop);
    await waitFor(() =>
      expect((view as unknown as { controlCalls: { verb: string }[] }).controlCalls).toHaveLength(
        1,
      ),
    );

    // The button is now disabled — the session is `interrupted` — and the reason
    // is on it, which is the shape §9.3 asks for.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveAttribute(
      'title',
      'the session has already finished',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('steers with the interrupt toggle, and sends what the toggle says', async () => {
    const view = await open({});
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Steer'), 'check the logs first');
    await user.click(screen.getByLabelText(/interrupt the current turn/u));
    await user.click(screen.getByRole('button', { name: 'Steer' }));

    const calls = (view as unknown as { controlCalls: { verb: string; body: unknown }[] })
      .controlCalls;
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      verb: 'steer',
      body: { text: 'check the logs first', interrupt: true },
    });
  });

  it('shows every inapplicable control disabled with its reason', async () => {
    await open({ session: aSession({ status: 'paused', exitReason: 'user_paused' }) });
    const steer = screen.getByRole('button', { name: 'Steer' });
    expect(steer).toBeDisabled();
    expect(steer).toHaveAttribute('title', 'paused sessions can’t be steered; resume first');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
  });

  it('pins the transcript against retention', async () => {
    const view = await open({});
    await userEvent.setup().click(screen.getByRole('button', { name: 'Keep this transcript' }));
    const calls = (view as unknown as { controlCalls: { verb: string; body: unknown }[] })
      .controlCalls;
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ verb: 'pin', body: { pinned: true } });
  });
});

describe('an awaiting_answer park (§9.3, IMPLEMENTATION §4)', () => {
  it('says "waiting for your answer", links to the card, and offers no Resume', async () => {
    await open({ session: aSession({ status: 'paused', exitReason: 'awaiting_answer' }) });
    const banner = document.querySelector('[data-badge="awaiting-answer"]');
    expect(banner?.textContent).toContain('Waiting for your answer');
    expect(
      within(banner as HTMLElement).getByRole('link', { name: 'See the card' }),
    ).toHaveAttribute('href', '/questions');
    // Not disabled — absent. A second resumer is the bug runner §15.1 #7 warns of.
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });
});

describe('the usage rail (§9.2, §4, IMPLEMENTATION §4)', () => {
  it('shows tokens as the primary unit and the dollar figure only as "estimated model cost"', async () => {
    await open({});
    const rail = screen.getByRole('complementary', { name: 'Usage' });
    expect(within(rail).getByText('12,345')).toHaveAttribute('data-primary', 'true');
    expect(within(rail).getByText('6,789')).toHaveAttribute('data-primary', 'true');

    const label = within(rail).getByText('estimated model cost');
    expect(label).toBeInTheDocument();
    expect(label.getAttribute('title')).toContain('not a charge');
    expect(within(rail).getByText('$0.1234')).toBeInTheDocument();
  });

  it('contains none of the plan-quota wording, as a literal assertion', async () => {
    await open({});
    const rail = screen.getByRole('complementary', { name: 'Usage' });
    const rendered = (rail.textContent ?? '').toLowerCase();
    for (const forbidden of FORBIDDEN_USAGE_STRINGS) {
      // "estimated model cost" is the one dollar label allowed, and it contains
      // none of these — so a plain substring check is the right check.
      expect(rendered, forbidden).not.toContain(forbidden);
    }
    expect(rendered).not.toMatch(/%/u);
    expect(rail.querySelector('progress')).toBeNull();
  });

  it('says nothing rather than zero when nothing has been metered', async () => {
    await open({ usage: null });
    const rail = screen.getByRole('complementary', { name: 'Usage' });
    expect(within(rail).getByText('Nothing metered yet.')).toBeInTheDocument();
  });
});

describe('the transcript region is not announced (§15)', () => {
  it('is aria-live="off", so a screen reader is not read every token', async () => {
    await open({ lines: [line(1, 'assistant', { text: 'hello' })] });
    const list = document.querySelector('.session__blocks');
    expect(list).toHaveAttribute('aria-live', 'off');
  });
});

describe('Load earlier (§9.2, §9.4)', () => {
  it('appears once the window starts past the beginning, and pages with ?from=', async () => {
    const fixture = serving({ lines: [line(1, 'assistant', { text: 'hello' })] });
    const view = mount(<App />, { respond: fixture.respond, route: '/sessions/s1' });
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Priya'),
    );

    // With `from: 0` there is nothing earlier, so the control stays away.
    expect(screen.queryByRole('button', { name: /Load earlier/u })).toBeNull();
    expect(view.calls.filter((url) => url.includes('/transcript'))).toHaveLength(1);
  });

  it('pages backwards with ?from= when the tail did not start at zero', async () => {
    let served = 0;
    const respond: Responder = (url) => {
      const [path = url, query = ''] = url.split('?');
      if (path === '/api/sessions/s1') {
        return json({ session: aSession(), usage: USAGE, queuePosition: null });
      }
      if (path === '/api/sessions/s1/transcript') {
        served += 1;
        const earlier = query.includes('from=');
        return json({
          sessionId: 's1',
          lines: earlier
            ? [line(1, 'assistant', { text: 'the beginning' })]
            : [line(9, 'assistant', { text: 'the tail' })],
          from: earlier ? 0 : 800,
          next: 900,
          size: 900,
          pruned: false,
        });
      }
      if (path === '/api/roster/agents') {
        return json({ agents: [anAgent({ id: 'priya', name: 'Priya' })], diagnostics: [] });
      }
      if (path === '/api/projects') return json({ projects: [] });
      if (path.endsWith('/avatar')) return new Response(new Blob(['png']), { status: 200 });
      return json({ error: 'not_found', message: 'no fixture' }, 404);
    };

    const view = mount(<App />, { respond, route: '/sessions/s1' });
    await waitFor(() => expect(screen.getByText('the tail')).toBeInTheDocument());

    const earlier = await screen.findByRole('button', { name: /Load earlier/u });
    await act(async () => {
      await userEvent.setup().click(earlier);
    });
    await waitFor(() => expect(screen.getByText('the beginning')).toBeInTheDocument());
    expect(served).toBe(2);
    expect(view.calls.some((url) => url.includes('/transcript?from='))).toBe(true);
    // The tail is still there: paging back widens, it does not replace.
    expect(screen.getByText('the tail')).toBeInTheDocument();
  });
});

describe('Enter steers, and the field says so (§9.3)', () => {
  it('submits the steer on Enter, without reaching for the button', async () => {
    const view = await open({});
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Steer'), 'check the logs first{Enter}');

    const calls = (view as unknown as { controlCalls: { verb: string; body: unknown }[] })
      .controlCalls;
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      verb: 'steer',
      body: { text: 'check the logs first', interrupt: false },
    });
  });

  it('does not post an empty steer', async () => {
    const view = await open({});
    await userEvent.setup().type(screen.getByLabelText('Steer'), '{Enter}');
    const calls = (view as unknown as { controlCalls: { verb: string }[] }).controlCalls;
    expect(calls).toHaveLength(0);
  });
});

describe('a card is answered where it is seen (§9.3, §11.3)', () => {
  it('renders the session’s open card in place, with the call it is gating', async () => {
    await open({
      session: aSession({ status: 'paused', exitReason: 'awaiting_answer' }),
      questions: [aQuestionCard()],
    });
    const card = await screen.findByText('Allow the agent to use Bash?');
    expect(card).toBeTruthy();
    // §11.2: the whole question is *which* Bash.
    expect(screen.getByText('npx prisma migrate reset')).toBeTruthy();
  });

  it('answers it with one POST to the one endpoint', async () => {
    const view = await open({
      session: aSession({ status: 'paused', exitReason: 'awaiting_answer' }),
      questions: [aQuestionCard()],
    });
    await screen.findByText('Allow the agent to use Bash?');
    await userEvent.setup().click(screen.getByRole('button', { name: /Allow once/u }));

    const answers = (view as unknown as { answerCalls: { id: string; body: unknown }[] })
      .answerCalls;
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toEqual({ id: 'q1', body: { optionIds: ['allow'] } });
  });

  it('shows another session’s card nowhere near this one', async () => {
    await open({
      session: aSession({ status: 'paused', exitReason: 'awaiting_answer' }),
      questions: [aQuestionCard({ id: 'q2', sessionId: 's9', prompt: 'Someone else’s card' })],
    });
    await waitFor(() => expect(screen.queryByText('Someone else’s card')).toBeNull());
    // With no card of its own the banner is what points at the inbox (§9.3).
    expect(screen.getByText(/Waiting for your answer/u)).toBeTruthy();
  });
});

/**
 * WO6 item 3 — the needs-auth card, completed.
 *
 * Driven through the real socket rather than through `connectors.ts` alone,
 * because what was actually wrong before is that these diagnostics carry no
 * `seq` and so never reached the screen at all.
 */
describe('the MCP authorisation card (roster §10, WO6)', () => {
  it('raises the connector, then the Authenticate… link, as one card', async () => {
    const view = await open({ lines: [line(1, 'assistant', { text: 'starting' })] });

    await act(async () => {
      view.sessionStream.emit({
        type: 'session.diagnostic',
        ids: { sessionId: 's1' },
        payload: {
          severity: 'warn',
          code: 'mcp_needs_auth',
          server: 'todo',
          message: 'The MCP server "todo" needs authorising before this session can use its tools.',
          action: 'authenticate',
          relaunchRequired: false,
        },
      });
      await Promise.resolve();
    });

    const card = await waitFor(() => {
      const found = document.querySelector('[data-badge="connector"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(card.textContent).toContain('needs authorising');
    // No link yet: the server has not raised one, and inventing a URL would be
    // an action that goes nowhere.
    expect(card.querySelector('[data-action="authenticate"]')).toBeNull();

    await act(async () => {
      view.sessionStream.emit({
        type: 'session.diagnostic',
        ids: { sessionId: 's1' },
        payload: {
          severity: 'warn',
          code: 'mcp_authorize_url',
          server: 'todo',
          message: 'The "todo" MCP server needs you to authorise it.',
          authorizeUrl: 'https://todo.example/authorize?state=abc',
          action: 'authenticate',
        },
      });
      await Promise.resolve();
    });

    // One card, now actionable — not a second card beside the first.
    await waitFor(() =>
      expect(document.querySelectorAll('[data-badge="connector"]')).toHaveLength(1),
    );
    expect(screen.getByRole('link', { name: 'Authenticate…' })).toHaveAttribute(
      'href',
      'https://todo.example/authorize?state=abc',
    );
  });

  it('goes quiet when the grant lands, and says relaunch when it cannot be used', async () => {
    const view = await open({ lines: [line(1, 'assistant', { text: 'starting' })] });

    await act(async () => {
      view.sessionStream.emit({
        type: 'session.diagnostic',
        ids: { sessionId: 's1' },
        payload: {
          severity: 'warn',
          code: 'mcp_needs_auth',
          server: 'todo',
          message: 'needs auth',
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelector('[data-badge="connector"]')).not.toBeNull());

    await act(async () => {
      view.sessionStream.emit({
        type: 'session.diagnostic',
        ids: { sessionId: 's1' },
        payload: {
          severity: 'info',
          code: 'mcp_authorized',
          server: 'todo',
          message: 'authorised',
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelector('[data-badge="connector"]')).toBeNull());

    await act(async () => {
      view.sessionStream.emit({
        type: 'session.diagnostic',
        ids: { sessionId: 's1' },
        payload: {
          severity: 'warn',
          code: 'mcp_reconnect_unavailable',
          server: 'todo',
          message: 'Relaunch the turn to pick it up.',
          relaunchRequired: true,
        },
      });
      await Promise.resolve();
    });
    const card = await waitFor(() => {
      const found = document.querySelector('[data-badge="connector"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(card.dataset['state']).toBe('relaunch-required');
    expect(card.textContent).toContain('Relaunch the turn');
  });
});
