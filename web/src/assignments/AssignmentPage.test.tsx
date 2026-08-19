/**
 * The assignment / collaboration view (IMPLEMENTATION §9's acceptance list).
 *
 * Each `describe` below is one acceptance criterion, quoted. The two that are
 * about a *viewport* rather than about behaviour — "without scrolling on
 * desktop and above the fold on phone", and the 390px stack — are asserted the
 * way jsdom can honestly assert them: the facts are inside the sticky header,
 * the header is the first thing in the document order, the column rules live
 * behind a `min-width: 900px` query so a phone has no columns at all, and every
 * entry carries its own attribution row so identity never depends on which
 * column something sits in. What is left — that it *looks* right at 390px — is
 * on the manual list, named.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { anAgent, json, mount, type Responder } from '../../test/harness';
import { App } from '../App';

import { aConversation, anAssignment, aSoloAssignment } from './fixtures';

const ADA = anAgent({ id: 'ada', name: 'Ada' });
const SAM = anAgent({ id: 'sam', name: 'Sam' });

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function serving(options: {
  assignment?: ReturnType<typeof anAssignment>;
  conversation?: ReturnType<typeof aConversation>;
  calls?: Recorded[];
}): Responder {
  const assignment = options.assignment ?? anAssignment();
  const conversation = options.conversation ?? aConversation();
  return (url, init) => {
    const path = url.split('?')[0] ?? url;
    const method = init.method ?? 'GET';
    if (method !== 'GET') {
      options.calls?.push({
        url: path,
        method,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      return json(assignment);
    }
    if (path === '/api/roster/agents') return json({ agents: [ADA, SAM], diagnostics: [] });
    if (path === '/api/projects') return json({ projects: [] });
    if (path.endsWith('/conversation')) return json(conversation);
    if (path.startsWith('/api/assignments/')) return json(assignment);
    if (path.endsWith('/avatar')) return new Response(new Blob(['png']), { status: 200 });
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
}

function mountAssignment(respond: Responder, id = 'asg_1'): ReturnType<typeof mount> {
  return mount(<App />, { respond, route: `/assignments/${id}` });
}

async function heading(): Promise<HTMLElement> {
  return screen.findByRole('heading', { name: 'Move transcripts off the hot path' });
}

describe('a completed 3-round pair renders as an ordered, readable dialogue (§10.2)', () => {
  it('names who spoke, in which seat, in which round, with the headline and the verdict', async () => {
    mountAssignment(serving({}));
    await heading();

    // Three rounds, in the server's order, labelled.
    const rounds = await screen.findAllByRole('region', { name: /^Round \d$/u });
    expect(rounds.map((round) => round.getAttribute('aria-label'))).toEqual([
      'Round 1',
      'Round 2',
      'Round 3',
    ]);

    // Who spoke, in which seat — and in which round, on the entry itself.
    expect(within(rounds[0]!).getByText('Ada · architect')).toBeInTheDocument();
    expect(within(rounds[0]!).getByText('Sam · skeptic')).toBeInTheDocument();
    expect(within(rounds[0]!).getAllByText('round 1')).toHaveLength(2);

    // The report headline as the bold lead.
    expect(within(rounds[0]!).getByText('Draft 1: store transcripts on disk').tagName).toBe(
      'STRONG',
    );

    // The verdict as a chip, with the blocking issue as a severity-marked list.
    const revise = within(rounds[0]!).getByText('revise');
    expect(revise).toHaveAttribute('data-verdict', 'revise');
    const blocking = within(rounds[0]!).getByText(/blows the WAL/u);
    expect(blocking.closest('li')).toHaveAttribute('data-severity', 'high');

    // Non-blocking notes are collapsed rather than absent.
    expect(within(rounds[0]!).getByText('1 non-blocking note').tagName).toBe('SUMMARY');

    // The third round accepts.
    expect(within(rounds[2]!).getByText('accept')).toHaveAttribute('data-verdict', 'accept');
  });

  it('links the artifact and every turn to its full session transcript', async () => {
    mountAssignment(serving({}));
    await heading();

    expect(screen.getByText(/artifact: docs\/decision.md/u)).toBeInTheDocument();

    const links = screen.getAllByRole('link', { name: /View .* full session/u });
    // Six turns in three rounds, each with its own session.
    expect(links).toHaveLength(6);
    expect(links[0]).toHaveAttribute('href', '/sessions/ses_1a');
    expect(links[5]).toHaveAttribute('href', '/sessions/ses_3b');
  });

  it('inlines the question card at the point it was asked, with its stances as words', async () => {
    mountAssignment(serving({}));
    await heading();

    const card = document.querySelector('.inline-question');
    expect(card).not.toBeNull();
    expect(
      within(card as HTMLElement).getByText(/Store transcripts in the DB/u),
    ).toBeInTheDocument();
    // The word, never a number (§11.2), here as in the inbox.
    expect(within(card as HTMLElement).getByText('BLOCKING')).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/Answered: On disk/u)).toBeInTheDocument();
    // Server-computed flags, read.
    expect(within(card as HTMLElement).getByText('The team disagrees')).toBeInTheDocument();
  });
});

describe('message entries show inlined, read and undelivered distinctly (§10.2)', () => {
  it('labels the undelivered one as never seen by the recipient', async () => {
    // The fixture assignment is closed, which is what makes "never" true.
    mountAssignment(serving({}));
    await heading();

    const messages = [...document.querySelectorAll('.message')];
    expect(messages.map((message) => message.getAttribute('data-delivery'))).toEqual([
      'inlined',
      'read',
      'undelivered',
    ]);

    const words = messages.map(
      (message) => message.querySelector('.message__delivery')?.textContent ?? '',
    );
    expect(new Set(words).size).toBe(3);
    expect(words[2]).toContain('never seen by the recipient');
    // And it is marked, not merely coloured (§15: colour is never the only signal).
    expect(messages[2]?.querySelector('.message__delivery')?.getAttribute('data-unseen')).toBe(
      'true',
    );
    expect(messages[1]?.querySelector('.message__delivery')?.getAttribute('data-unseen')).toBe(
      'false',
    );
  });

  it('says an undelivered message is still coming while the assignment is open', async () => {
    // The same fixture message, on an assignment that has not closed: there is
    // still a launch to inline it into (orchestrator §5.1), so the label names
    // whose turn it is waiting on instead of declaring it lost.
    mountAssignment(
      serving({
        assignment: anAssignment({ status: 'open', phase: 'running', closeReason: null }),
      }),
    );
    await heading();

    const messages = [...document.querySelectorAll('.message')];
    const pending = messages[2]?.querySelector('.message__delivery');
    expect(pending?.textContent).toBe('waiting — delivered at Sam’s next turn');
    expect(pending?.getAttribute('data-unseen')).toBe('false');
  });

  it('names both ends of every message', async () => {
    mountAssignment(serving({}));
    await heading();
    expect(screen.getByText('Sam → Ada')).toBeInTheDocument();
    expect(screen.getAllByText('Ada → Sam')).toHaveLength(2);
  });
});

describe('phase, rounds and tokens are visible without scrolling (§10.2)', () => {
  it('keeps all three inside the sticky header, which is the first thing on the page', async () => {
    mountAssignment(serving({}));
    await heading();

    const header = document.querySelector('.assignment__header');
    expect(header).not.toBeNull();
    // The header is the first child of the screen — "above the fold on phone"
    // is a claim about document order before it is a claim about pixels.
    expect(header?.parentElement?.firstElementChild).toBe(header);

    const inside = within(header as HTMLElement);
    expect(inside.getByText('converged')).toBeInTheDocument();
    expect(
      inside.getByText('Round 3 of 3', { selector: '[aria-hidden="true"]' }),
    ).toBeInTheDocument();
    expect(inside.getByText(/120,000 of 400,000 tokens/u)).toBeInTheDocument();

    // Three pips, all done.
    const pips = header?.querySelectorAll('.assignment__pip') ?? [];
    expect(pips).toHaveLength(3);
    expect([...pips].every((pip) => pip.getAttribute('data-done') === 'true')).toBe(true);
  });

  /**
   * The observed pair run showed `Round 0 of 3` for the whole of round 1: the
   * server increments `rounds_used` when the critic reports, and the header
   * printed it raw. Two assertions, one per side of the transition.
   */
  it('reads Round 1 of 3 with pip 1 in progress while round 1 is still running', async () => {
    mountAssignment(
      serving({
        assignment: anAssignment({
          status: 'open',
          phase: 'running',
          roundsUsed: 0,
          closeReason: null,
        }),
        conversation: aConversation({
          phase: 'running',
          status: 'open',
          roundsUsed: 0,
          closeReason: null,
          rounds: [
            {
              round: 1,
              entries: [
                {
                  type: 'turn',
                  turnId: 't1a',
                  seat: 'drafter',
                  agentId: 'ada',
                  role: 'architect',
                  sessionId: 'ses_1a',
                  status: 'running',
                  report: null,
                  excerpt: null,
                  startedAt: '2026-08-17T09:05:00.000Z',
                  endedAt: null,
                  exitReason: null,
                  retryOfTurnId: null,
                },
              ],
            },
          ],
        }),
      }),
    );
    await heading();

    const header = document.querySelector('.assignment__header') as HTMLElement;
    await waitFor(() => {
      expect(
        within(header).getByText('Round 1 of 3', { selector: '[aria-hidden="true"]' }),
      ).toBeInTheDocument();
    });

    const pips = [...header.querySelectorAll('.assignment__pip')];
    expect(pips).toHaveLength(3);
    // Neither empty nor filled: the round is being worked.
    expect(pips[0]?.getAttribute('data-in-progress')).toBe('true');
    expect(pips[0]?.getAttribute('data-done')).toBe('false');
    expect(pips.slice(1).every((pip) => pip.getAttribute('data-in-progress') === 'false')).toBe(
      true,
    );
  });

  it('reads the same Round 1 of 3 once the critic reported, with pip 1 done', async () => {
    mountAssignment(
      serving({
        assignment: anAssignment({
          status: 'open',
          phase: 'awaiting_user',
          roundsUsed: 1,
          closeReason: null,
        }),
        conversation: aConversation({
          phase: 'awaiting_user',
          status: 'open',
          roundsUsed: 1,
          closeReason: null,
          rounds: [aConversation().rounds[0]!],
        }),
      }),
    );
    await heading();

    const header = document.querySelector('.assignment__header') as HTMLElement;
    await waitFor(() => {
      expect(
        within(header).getByText('Round 1 of 3', { selector: '[aria-hidden="true"]' }),
      ).toBeInTheDocument();
    });

    const pips = [...header.querySelectorAll('.assignment__pip')];
    expect(pips[0]?.getAttribute('data-done')).toBe('true');
    expect(pips.every((pip) => pip.getAttribute('data-in-progress') === 'false')).toBe(true);
  });

  it('pins the header in the stylesheet rather than by hope', () => {
    const css = readFileSync(resolve(process.cwd(), 'web', 'src', 'collaboration.css'), 'utf8');
    const block = css.slice(css.indexOf('.assignment__header {'));
    expect(block.slice(0, block.indexOf('}'))).toContain('position: sticky');
  });
});

describe('the budget is shown in tokens; no currency figure appears (§10.2, §16.8)', () => {
  it('has no dollar figure, no cost column and no spend anywhere in the view', async () => {
    mountAssignment(serving({}));
    await heading();

    const rendered = document.body.textContent ?? '';
    expect(rendered).toContain('tokens');
    for (const forbidden of ['$', '£', '€', 'USD', 'cost', 'spend', 'dollar']) {
      expect(rendered.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('halted and converged (§10.2)', () => {
  it('names the halt reason and links to the card that resolves it', async () => {
    mountAssignment(
      serving({
        assignment: anAssignment({
          status: 'open',
          phase: 'halted',
          haltReason: 'question_expired',
          closeReason: null,
        }),
      }),
    );
    await heading();

    const banner = document.querySelector('[data-banner="halted"]');
    expect(banner?.textContent).toContain('a question expired unanswered');
    expect(
      within(banner as HTMLElement).getByRole('link', { name: 'Open the inbox' }),
    ).toHaveAttribute('href', '/questions');
  });

  it('shows the completion summary and the artifact when it converged', async () => {
    mountAssignment(serving({}));
    await heading();
    const banner = document.querySelector('[data-banner="converged"]');
    expect(banner?.textContent).toContain('Converged');
    expect(banner?.textContent).toContain('docs/decision.md');
  });
});

describe('a turn that failed to launch is visible, with its reason (orchestrator WO1)', () => {
  it('renders the failed row and says the session could never be started', async () => {
    const conversation = aConversation({
      phase: 'running',
      status: 'open',
      closeReason: null,
      rounds: [
        {
          round: 1,
          entries: [
            {
              type: 'turn',
              turnId: 't1a',
              seat: 'drafter',
              agentId: 'ada',
              role: 'architect',
              // The whole point of the case: there is no session to click
              // through to, so the turn row is the only place this can be read.
              sessionId: null,
              status: 'failed',
              report: null,
              excerpt: null,
              startedAt: '2026-08-17T09:05:00.000Z',
              endedAt: '2026-08-17T09:05:01.000Z',
              exitReason: 'launch_failed',
              retryOfTurnId: null,
            },
          ],
        },
      ],
    });
    mountAssignment(
      serving({
        assignment: anAssignment({ status: 'open', phase: 'running', closeReason: null }),
        conversation,
      }),
    );
    await heading();

    const failed = document.querySelector('[data-status="failed"]');
    expect(failed).not.toBeNull();
    expect(failed?.textContent).toContain('Ada · architect');
    expect(failed?.textContent).toContain('failed — the session could not be started');
    expect(failed?.textContent).toContain('This turn never reached a session.');
  });
});

describe('members and pattern are not editable anywhere (§10.2, §18-5)', () => {
  it('offers exactly three editable fields, and PATCHes only those three', async () => {
    const calls: Recorded[] = [];
    mountAssignment(
      serving({ assignment: anAssignment({ status: 'open', phase: 'running' }), calls }),
    );
    await heading();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit budget & round cap' }));

    const form = document.querySelector('.assignment__edit');
    const fields = [...(form?.querySelectorAll('input') ?? [])].map(
      (input) => input.previousElementSibling?.textContent ?? '',
    );
    expect(fields).toEqual(['Token budget', 'Round cap', 'Goal']);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe('PATCH');
    expect(Object.keys(calls[0]?.body as Record<string, unknown>).sort()).toEqual([
      'goal',
      'roundCap',
      'tokenBudget',
    ]);

    // There is no control for a member or for the pattern, anywhere on the page.
    expect(screen.queryByRole('button', { name: /member/iu })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /pattern|member|seat/iu })).toBeNull();
  });

  it('advances and closes through the routes orchestrator declares', async () => {
    const calls: Recorded[] = [];
    mountAssignment(
      serving({ assignment: anAssignment({ status: 'open', phase: 'running' }), calls }),
    );
    await heading();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Advance' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe('/api/assignments/asg_1/advance');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.url).toBe('/api/assignments/asg_1/close');
    expect(calls[1]?.body).toEqual({ reason: 'user_closed' });
  });
});

describe('on a 390px viewport the two seats stack and identity is unambiguous (§2.3)', () => {
  it('carries name and seat on every entry, so nothing depends on the column', async () => {
    mountAssignment(serving({}));
    await heading();

    const turns = [...document.querySelectorAll('.turn')];
    expect(turns).toHaveLength(6);
    for (const turn of turns) {
      const who = turn.querySelector('.turn__name')?.textContent ?? '';
      expect(who).toMatch(/^(Ada|Sam) · (architect|skeptic)$/u);
    }
    // Both columns are used on desktop — and both are decided by seat, so the
    // same seat is always on the same side.
    const bySeat = new Map(
      turns.map((turn) => [turn.getAttribute('data-seat'), turn.getAttribute('data-column')]),
    );
    expect(bySeat.get('drafter')).not.toBe(bySeat.get('critic'));
  });

  it('confines the column rule to desktop, so a phone has one column', () => {
    const css = readFileSync(resolve(process.cwd(), 'web', 'src', 'collaboration.css'), 'utf8');
    const query = css.slice(css.indexOf('@media (min-width: 900px)'));
    expect(query).toContain(".turn[data-column='right']");
    // Nothing outside the query moves a turn sideways.
    const beforeQuery = css.slice(0, css.indexOf('@media (min-width: 900px)'));
    expect(beforeQuery).not.toContain("data-column='right'");
  });
});

describe('a solo assignment renders through the same view (§10.3)', () => {
  it('shows one seat, no round strip, and says why the conversation is empty', async () => {
    mountAssignment(
      serving({
        assignment: aSoloAssignment(),
        conversation: aConversation({
          assignmentId: 'asg_solo',
          pattern: 'solo',
          phase: 'running',
          status: 'open',
          roundCap: null,
          roundsUsed: 0,
          tokenBudget: null,
          rounds: [],
        }),
      }),
      'asg_solo',
    );
    await heading();

    expect(document.querySelectorAll('.assignment__seats li')).toHaveLength(1);
    expect(document.querySelectorAll('.assignment__pip')).toHaveLength(0);
    expect(screen.getByText('One seat, no rounds')).toBeInTheDocument();
    expect(screen.getByText(/does its work in its session/u)).toBeInTheDocument();
    // Still tokens, still no money.
    expect(screen.getByText(/120,000 tokens used · no budget set/u)).toBeInTheDocument();
  });
});

describe('denials are visible where the work is judged (WO4 addendum §5)', () => {
  /** One round whose drafter reported success with N of its calls refused. */
  function conversationWithDenials(
    permissionDenials: number,
    permissionDeniedTools: readonly string[] | null,
  ): ReturnType<typeof aConversation> {
    const base = aConversation();
    const first = base.rounds[0];
    if (first === undefined) throw new Error('the fixture lost its first round');
    return aConversation({
      rounds: [
        {
          round: 1,
          entries: first.entries.map((entry) =>
            entry.type === 'turn' && entry.seat === 'drafter'
              ? { ...entry, permissionDenials, permissionDeniedTools }
              : entry,
          ),
        },
        ...base.rounds.slice(1),
      ],
    });
  }

  it('renders the chip, with the denied tools, on a turn that lost calls', async () => {
    mountAssignment(
      serving({ conversation: conversationWithDenials(2, ['Write', 'Write', 'Bash']) }),
    );
    await heading();

    const chip = document.querySelector('[data-denials="2"]');
    // The names, deduplicated — three refused `Write` calls are one fact about
    // `Write`, and the count already carries "three".
    expect(chip?.textContent).toBe('2 tool calls denied — Write, Bash');
  });

  it('falls back to the count on a row that predates the names', async () => {
    mountAssignment(serving({ conversation: conversationWithDenials(1, null) }));
    await heading();

    expect(document.querySelector('[data-denials="1"]')?.textContent).toBe('1 tool call denied');
  });

  it('renders nothing at all when nothing was denied', async () => {
    mountAssignment(serving({ conversation: conversationWithDenials(0, []) }));
    await heading();

    // A chip on every clean turn is noise that hides the one turn that is not.
    expect(document.querySelector('.turn__denials')).toBeNull();
  });

  it('carries the assignment’s total onto the completion banner', async () => {
    mountAssignment(serving({ assignment: anAssignment({ permissionDenials: 3 }) }));
    await heading();

    const banner = document.querySelector('[data-banner="converged"]');
    expect(banner?.textContent).toContain('3 tool calls were denied while this ran.');
  });

  it('says nothing on the banner when the total is zero', async () => {
    mountAssignment(serving({ assignment: anAssignment({ permissionDenials: 0 }) }));
    await heading();

    expect(document.querySelector('[data-banner="converged"]')?.textContent).not.toContain(
      'denied',
    );
  });
});
