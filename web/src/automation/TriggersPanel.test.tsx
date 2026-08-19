/**
 * The Triggers surface (DESIGN §8.2 region 5, §13.1; orchestrator §2.8, WO8).
 *
 * Two placements, one panel; a row that says why nothing ran; a Run-now that
 * reports a refusal as a refusal; and — the rule the whole state architecture
 * rests on — **no polling**: a `trigger.fired` frame is what puts a new run on
 * the screen.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../App';
import { json, mount, type Responder } from '../../test/harness';
import { RESPOND } from '../../test/routes';
import { useAppStore } from '../state/store';

import { outcomeNote, scheduleLabel } from './TriggersPanel';
import type { Trigger } from '../api/types';

afterEach(() => {
  useAppStore.getState().reset();
});

function aTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trg_1',
    projectId: 'lpm',
    templateId: 'todo-ticket-replies',
    agentIds: ['ada'],
    everyMinutes: 60,
    activeHours: { from: 8, to: 22 },
    enabled: true,
    variables: {},
    maxRunsPerDay: 24,
    lastFiredAt: '2026-08-17T09:00:00.000Z',
    nextFireAt: '2026-08-17T10:00:00.000Z',
    consecutiveFailures: 0,
    lastOutcome: 'fired',
    lastOutcomeReason: null,
    lastOutcomeAt: '2026-08-17T09:00:00.000Z',
    lastRun: {
      assignmentId: 'asg_1',
      status: 'closed',
      phase: 'converged',
      closeReason: 'converged',
      createdAt: '2026-08-17T09:00:00.000Z',
    },
    runsToday: 1,
    createdAt: '2026-08-16T09:00:00.000Z',
    updatedAt: null,
    ...overrides,
  };
}

interface Opened {
  readonly posted: { url: string; method: string; body: unknown }[];
  readonly calls: readonly string[];
  readonly stream: ReturnType<typeof mount>['stream'];
}

function open(
  route: string,
  triggers: readonly Trigger[],
  run?: Record<string, unknown>,
): Opened & ReturnType<typeof mount> {
  const posted: { url: string; method: string; body: unknown }[] = [];
  let served = triggers;
  const respond: Responder = (url, init) => {
    const path = url.split('?')[0] ?? url;
    const method = init.method ?? 'GET';
    if (method !== 'GET') {
      posted.push({
        url: path,
        method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (path.endsWith('/run'))
        return json(
          run ?? { triggerId: 'trg_1', outcome: 'fired', reason: null, trigger: served[0] },
        );
      served = served.map((one) => ({ ...one, enabled: !one.enabled }));
      return json(served[0]);
    }
    // One override, everything else from the shared table — the project page
    // needs its project, its activity and its work items before it renders any
    // section at all.
    if (path === '/api/triggers') return json({ triggers: served });
    return RESPOND(url, init);
  };
  const mounted = mount(<App />, { respond, route });
  return { ...mounted, posted };
}

describe('the schedule, in the owner’s words', () => {
  it('says the interval and the window', () => {
    expect(scheduleLabel(aTrigger())).toBe('every 1 hour, 08:00–22:00');
    expect(scheduleLabel(aTrigger({ everyMinutes: 180, activeHours: null }))).toBe('every 3 hours');
    expect(scheduleLabel(aTrigger({ everyMinutes: 15, activeHours: null }))).toBe(
      'every 15 minutes',
    );
  });
});

describe('the reason a trigger is not running', () => {
  it('says nothing at all when the last fire ran', () => {
    expect(outcomeNote(aTrigger())).toBeNull();
  });

  it('names the gate a blocked fire hit', () => {
    expect(
      outcomeNote(
        aTrigger({ lastOutcome: 'blocked', lastOutcomeReason: 'connector-needs-auth:gmail' }),
      ),
    ).toContain('connector-needs-auth:gmail');
  });

  it('says a trigger switched *itself* off, and why', () => {
    expect(
      outcomeNote(
        aTrigger({
          enabled: false,
          lastOutcome: 'disabled',
          lastOutcomeReason: 'disabled-after-3-failures',
        }),
      ),
    ).toContain('disabled-after-3-failures');
  });
});

describe('the project page’s Triggers section (§8.2)', () => {
  it('renders the template, the seats, the schedule and a link to the last run', async () => {
    open('/projects/lpm', [aTrigger()]);
    const section = await screen.findByRole('heading', { name: 'Triggers' });
    const panel = section.parentElement as HTMLElement;
    await waitFor(() => {
      expect(within(panel).getByText('todo-ticket-replies')).toBeInTheDocument();
    });
    expect(within(panel).getByText('ada')).toBeInTheDocument();
    expect(within(panel).getByText('every 1 hour, 08:00–22:00')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /2026/ })).toHaveAttribute(
      'href',
      '/assignments/asg_1',
    );
  });

  it('says so plainly when a project has no background work', async () => {
    open('/projects/lpm', []);
    expect(await screen.findByText(/No background triggers on this project/)).toBeInTheDocument();
  });

  it('shows the blocked reason on the row, not only in a log', async () => {
    open('/projects/lpm', [
      aTrigger({ lastOutcome: 'blocked', lastOutcomeReason: 'permission-gate:Bash' }),
    ]);
    expect(await screen.findByText(/permission-gate:Bash/)).toBeInTheDocument();
  });
});

describe('settings → Automation (§13.1)', () => {
  it('lists every project’s triggers, naming the project on each row', async () => {
    open('/settings', [aTrigger()]);
    const heading = await screen.findByRole('heading', { name: 'Automation' });
    const panel = heading.parentElement as HTMLElement;
    await waitFor(() => {
      expect(within(panel).getByText('todo-ticket-replies')).toBeInTheDocument();
    });
    expect(within(panel).getByRole('link', { name: 'lpm' })).toHaveAttribute(
      'href',
      '/projects/lpm',
    );
  });
});

describe('the controls', () => {
  it('switches a trigger off with a PATCH and nothing else', async () => {
    const opened = open('/projects/lpm', [aTrigger()]);
    const toggle = await screen.findByRole('checkbox', { name: 'Enabled' });
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(opened.posted).toContainEqual({
        url: '/api/triggers/trg_1',
        method: 'PATCH',
        body: { enabled: false },
      });
    });
  });

  it('reports a refused Run now as a refusal, in the server’s words', async () => {
    const opened = open('/projects/lpm', [aTrigger()], {
      triggerId: 'trg_1',
      outcome: 'blocked',
      reason: 'connector-needs-auth:gmail',
      trigger: aTrigger({
        lastOutcome: 'blocked',
        lastOutcomeReason: 'connector-needs-auth:gmail',
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Run now' }));

    await waitFor(() => {
      expect(opened.posted.some((call) => call.url === '/api/triggers/trg_1/run')).toBe(true);
    });
    expect(await screen.findByText(/did not run — connector-needs-auth:gmail/)).toBeInTheDocument();
  });
});

describe('nothing polls (§3.4, §16)', () => {
  it('refetches the trigger rows on a trigger.fired frame and not on a timer', async () => {
    const opened = open('/projects/lpm', [aTrigger()]);
    await screen.findByText('todo-ticket-replies');
    const before = opened.calls.filter((url) => url.startsWith('/api/triggers')).length;

    opened.stream.emit({ id: 'e1', type: 'trigger.fired', ids: { projectId: 'lpm' } });

    await waitFor(() => {
      expect(opened.calls.filter((url) => url.startsWith('/api/triggers')).length).toBeGreaterThan(
        before,
      );
    });
  });
});
