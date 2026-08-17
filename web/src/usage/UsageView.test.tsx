/**
 * The usage view (IMPLEMENTATION §10's first three criteria).
 *
 * - "The usage screen contains **no percentage, no gauge**, and none of the
 *   strings 'remaining', '% of plan', or 'quota' — a literal assertion over the
 *   rendered output."
 * - "A rate-limit cool-down renders prominently with its `until` and `source`;
 *   the queue panel shows blocked entries with their `blocked_reason`."
 * - "Capacity can be lowered from the tailnet and the raise control is
 *   **disabled with the reason**; locally both work."
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { json, mount, type Responder } from '../../test/harness';
import { App } from '../App';
import { anAssignment } from '../assignments/fixtures';

interface Put {
  readonly url: string;
  readonly body: unknown;
}

const QUEUE = {
  running: 1,
  queued: 2,
  blocked: 1,
  capacity: 3,
  usedWeight: 1,
  cooling: false,
  coolingUntil: null,
  entries: [
    {
      sessionId: 'ses_run',
      assignmentId: 'asg_1',
      agentId: 'ada',
      projectId: 'lpm',
      status: 'running',
      priority: 'interactive',
      weight: 1,
      queuedAt: null,
      blockedReason: null,
      position: null,
    },
    {
      sessionId: 'ses_wait',
      assignmentId: 'asg_2',
      agentId: 'sam',
      projectId: 'lpm',
      status: 'queued',
      priority: 'normal',
      weight: 1,
      queuedAt: '2026-08-17T11:00:00.000Z',
      blockedReason: null,
      position: 1,
    },
    {
      sessionId: 'ses_blocked',
      assignmentId: 'asg_3',
      agentId: 'priya',
      projectId: 'lpm',
      status: 'queued',
      priority: 'normal',
      weight: 1,
      queuedAt: '2026-08-17T11:05:00.000Z',
      blockedReason: 'the project workspace is held by another session',
      position: 2,
    },
  ],
};

const USAGE = {
  own: {
    window5h: {
      since: '2026-08-17T07:00:00.000Z',
      inputTokens: 120_000,
      outputTokens: 40_000,
      sessions: 6,
    },
    window7d: {
      since: '2026-08-10T12:00:00.000Z',
      inputTokens: 2_400_000,
      outputTokens: 800_000,
      sessions: 91,
    },
    source: 'local-estimate',
  },
  rateLimit: { state: 'ok', lastHitAt: null, resetsAt: null, source: 'observed' },
  disclaimer:
    'Counts AgentManager sessions only. Your interactive Claude usage shares the same plan windows and is not visible here.',
};

function serving(options: { usageStatus?: number; puts?: Put[] } = {}): Responder {
  return (url, init) => {
    const path = url.split('?')[0] ?? url;
    if (init.method === 'PUT') {
      options.puts?.push({ url: path, body: JSON.parse(init.body as string) as unknown });
      const body = JSON.parse(init.body as string) as { maxConcurrent: number };
      return json({ maxConcurrent: body.maxConcurrent });
    }
    if (path === '/api/runner/usage') {
      return options.usageStatus === undefined
        ? json(USAGE)
        : json({ error: 'not_found', message: 'No route matches GET /api/runner/usage.' }, 404);
    }
    if (path === '/api/runner/queue') return json(QUEUE);
    if (path === '/api/assignments') {
      return json({ assignments: [anAssignment({ status: 'open', phase: 'running' })] });
    }
    if (path === '/api/roster/agents') return json({ agents: [], diagnostics: [] });
    if (path === '/api/projects') return json({ projects: [] });
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
}

function mountUsage(respond: Responder): ReturnType<typeof mount> {
  return mount(<App />, { respond, route: '/usage' });
}

describe('the honesty contract, as a literal scan (§12, §18-11)', () => {
  it('has no percentage, no gauge, and none of the forbidden words', async () => {
    mountUsage(serving());
    await screen.findByRole('heading', { name: 'Usage' });
    await screen.findByText(/Counts AgentManager sessions only/u);

    const rendered = document.body.textContent ?? '';
    for (const forbidden of ['remaining', '% of plan', 'quota', 'plan limit']) {
      expect(rendered.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // No percentage anywhere, and no progress element to read as one.
    expect(rendered).not.toMatch(/\d\s*%/u);
    expect(document.querySelector('progress, meter')).toBeNull();
  });

  it('shows the API’s own disclaimer in full, and its provenance label', async () => {
    mountUsage(serving());
    expect(await screen.findByText(USAGE.disclaimer)).toBeInTheDocument();
    expect(document.querySelector('[data-source="local-estimate"]')).not.toBeNull();
    expect(screen.getByText(/120,000 in · 40,000 out/u)).toBeInTheDocument();
  });

  it('says the windows are not kept rather than drawing zeros, when the route is absent', async () => {
    // `GET /api/runner/usage` is runner's own M11 and is not served yet.
    mountUsage(serving({ usageStatus: 404 }));
    const panel = await screen.findByText(/not keeping rolling usage windows yet/u);
    expect(panel).toHaveAttribute('data-panel-state', 'unavailable');
    expect(document.body.textContent).not.toMatch(/0 in · 0 out/u);
  });
});

describe('the queue panel (§12 panel 2)', () => {
  it('shows blocked entries with their blocked reason, and their position', async () => {
    mountUsage(serving());
    const blocked = await waitFor(() => {
      const found = document.querySelector('[data-session-id="ses_blocked"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(blocked).toHaveAttribute('data-blocked', 'true');
    expect(within(blocked).getByText(/workspace is held/u)).toBeInTheDocument();
    expect(
      document.querySelector('[data-session-id="ses_run"]')?.getAttribute('data-blocked'),
    ).toBe('false');
    expect(screen.getByText(/1 running · 2 queued · 1 blocked · cap 3/u)).toBeInTheDocument();
  });

  it('raises the cool-down strip from the event, with its until and its source', async () => {
    const mounted = mountUsage(serving());
    await screen.findByRole('heading', { name: 'Queue and rate limits' });
    expect(document.querySelector('[data-cooldown="true"]')).toBeNull();

    mounted.stream.emit({
      type: 'runner.ratelimited',
      id: 'evt_1',
      payload: {
        until: '2026-08-17T13:30:00.000Z',
        source: 'terminal-reason',
        hint: 'Rate limiting was observed.',
      },
    });

    const strip = await waitFor(() => {
      const found = document.querySelector('[data-cooldown="true"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(strip.textContent).toContain('Cooling until');
    expect(strip.querySelector('[data-cooldown-source="terminal-reason"]')).not.toBeNull();

    // And it clears when the scheduler says admissions resumed.
    mounted.stream.emit({ type: 'runner.queue.changed', payload: { cooling: false } });
    await waitFor(() => expect(document.querySelector('[data-cooldown="true"]')).toBeNull());
  });
});

describe('the capacity control (§12, runner §15.3 #17)', () => {
  it('lets a local client both lower and raise', async () => {
    const puts: Put[] = [];
    mountUsage(serving({ puts }));
    await screen.findByLabelText('Concurrent sessions');

    const user = userEvent.setup();
    const field = screen.getByLabelText('Concurrent sessions');
    await user.clear(field);
    await user.type(field, '5');
    await user.click(screen.getByRole('button', { name: 'Raise' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ url: '/api/runner/capacity', body: { maxConcurrent: 5 } });
  });

  it('disables the raise over the tailnet, with the reason, and still allows a lower', async () => {
    const puts: Put[] = [];
    // A held bearer *is* what "remote" means to the client (§3.1).
    mount(<App />, { respond: serving({ puts }), route: '/usage', token: 'a-device-token' });
    await screen.findByLabelText('Concurrent sessions');

    const user = userEvent.setup();
    const field = screen.getByLabelText('Concurrent sessions');
    await user.clear(field);
    await user.type(field, '6');
    const raise = screen.getByRole('button', { name: 'Raise' });
    expect(raise).toBeDisabled();
    expect(raise).toHaveAttribute('title', expect.stringContaining('may lower the cap'));
    // The reason is on the screen, not only in a tooltip (§13.4).
    expect(document.querySelector('[data-reason="capacity-raise"]')?.textContent).toContain(
      'may lower the cap but not raise it',
    );

    await user.clear(field);
    await user.type(field, '2');
    await user.click(screen.getByRole('button', { name: 'Lower' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.body).toEqual({ maxConcurrent: 2 });
  });
});

describe('per-assignment spend is tokens (§12 panel 3, §16.8)', () => {
  it('renders the budget in tokens and links to the assignment', async () => {
    mountUsage(serving());
    const row = await waitFor(() => {
      const found = document.querySelector('[data-assignment-id="asg_1"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(row.textContent).toContain('120,000 of 400,000 tokens');
    expect(within(row).getByRole('link')).toHaveAttribute('href', '/assignments/asg_1');
  });
});
