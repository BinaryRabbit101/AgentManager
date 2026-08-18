/**
 * The board's gesture, driven for real (DESIGN §5.3, §5.4; IMPLEMENTATION §3).
 *
 * These mount the whole app and drive dnd-kit's **actual** `KeyboardSensor`, so
 * the keyboard criterion is proved through the production code path rather than
 * through a hand-called drop handler:
 *
 * > "Keyboard-only: Tab to a card, `Space`, arrows, `Space` reaches the launch
 * > flow for the intended project, with each target change announced in a live
 * > region."
 *
 * That is possible because the arrow keys walk `dnd.ts`'s declared ring rather
 * than a geometric search (see that file) — jsdom has no layout, and a
 * geometry-driven sensor would be untestable here *and* fragile at 200% zoom in a
 * real browser.
 *
 * The pointer and touch halves are the same `onDragEnd`; what is specific to them
 * — a real 250ms long-press, a real pixel drag — is on the manual-check list.
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';

import { anAgent, aProject, json, mount, type Responder } from '../../test/harness';
import { App } from '../App';
import type { AgentView, Project } from '../api/types';

beforeAll(() => {
  // dnd-kit scrolls the lifted card into view. jsdom implements no scrolling, and
  // a missing method would fail the drag rather than the assertion.
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = (): void => undefined;
  }
});

interface Fixture {
  readonly respond: Responder;
  readonly puts: { url: string; body: unknown }[];
  set(next: { agents?: readonly AgentView[]; projects?: readonly Project[] }): void;
}

function serving(initial: {
  agents?: readonly AgentView[];
  projects?: readonly Project[];
  boardOrderStatus?: number;
  boardOrderBody?: unknown;
}): Fixture {
  let agents = initial.agents ?? [];
  let projects = initial.projects ?? [];
  const puts: { url: string; body: unknown }[] = [];

  const respond: Responder = (url, init) => {
    const path = url.split('?')[0] ?? url;
    if (path === '/api/roster/board-order') {
      const body: unknown =
        typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      puts.push({ url: path, body });
      if (initial.boardOrderStatus !== undefined) {
        return json(initial.boardOrderBody ?? {}, initial.boardOrderStatus);
      }
      const order = (body as { order?: string[] } | undefined)?.order ?? [];
      agents = order
        .map((id, index) => {
          const found = agents.find((agent) => agent.definition.id === id);
          return found === undefined
            ? undefined
            : { ...found, uiState: { ...found.uiState, boardOrder: index } };
        })
        .filter((agent): agent is AgentView => agent !== undefined);
      return json({ agents, diagnostics: [] });
    }
    if (path === '/api/roster/agents') return json({ agents, diagnostics: [] });
    if (path === '/api/projects') return json({ projects });
    if (path.startsWith('/api/projects/')) {
      const id = path.slice('/api/projects/'.length);
      const project = projects.find((one) => one.id === id);
      return project === undefined
        ? json({ error: 'not_found', message: 'no such project' }, 404)
        : json({ ...project, defaults: { agentIds: [] } });
    }
    if (path.endsWith('/avatar')) {
      return new Response(new Blob(['png']), { status: 200 });
    }
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };

  return {
    respond,
    puts,
    set: (next) => {
      if (next.agents !== undefined) agents = next.agents;
      if (next.projects !== undefined) projects = next.projects;
    },
  };
}

/** dnd-kit's own live region — the one it announces drag events into (§15). */
function announcement(): string {
  const regions = [...document.querySelectorAll('[aria-live="assertive"]')];
  return regions.map((region) => region.textContent ?? '').join(' ');
}

function grip(name: string): HTMLElement {
  return screen.getByRole('button', { name: `Move or launch ${name}` });
}

function cardNames(): string[] {
  return [...document.querySelectorAll('.card-grid > li')].map(
    (card) => card.getAttribute('data-agent-id') ?? '',
  );
}

const PRIYA = anAgent({ id: 'priya', name: 'Priya', boardOrder: 0 });
const SAM = anAgent({ id: 'sam', name: 'Sam', boardOrder: 1 });
const LPM = aProject({ id: 'lpm', name: 'littlepocketmuseum' });

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('link', { name: 'Priya' })).toBeInTheDocument());
}

/**
 * The board's ring is agents only now.
 *
 * Project cards moved to `/projects` (§2.1), and §5.3 row 1 went with them —
 * `ProjectsPage.test.tsx` drives that drop, chips and all. What the board still
 * owns is the lift itself, the wrap, and Escape.
 */
describe('the keyboard drag on the board (§5.4, IMPLEMENTATION §3)', () => {
  it('lifts with Space and announces each target the arrows reach', async () => {
    const fixture = serving({ agents: [PRIYA, SAM], projects: [LPM] });
    mount(<App />, { respond: fixture.respond });
    await ready();

    const user = userEvent.setup();
    grip('Priya').focus();
    await user.keyboard(' ');
    expect(announcement()).toContain('Picked up Priya');

    // Ring: [Priya, Sam]. Outside Reorder mode, passing over another card is
    // the pair gesture.
    await user.keyboard('{ArrowDown}');
    expect(announcement()).toContain('Start a pair: Priya drafting, Sam reviewing.');
  });

  it('wraps the ring, so the last arrow press does not strand the drag', async () => {
    const fixture = serving({ agents: [PRIYA, SAM], projects: [LPM] });
    mount(<App />, { respond: fixture.respond });
    await ready();

    const user = userEvent.setup();
    grip('Priya').focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowUp}');
    // One step back from Priya's own slot is the last entry: Sam.
    expect(announcement()).toContain('Start a pair: Priya drafting, Sam reviewing.');
  });

  it('cancels on Escape and starts nothing', async () => {
    const fixture = serving({ agents: [PRIYA, SAM], projects: [LPM] });
    mount(<App />, { respond: fixture.respond });
    await ready();

    const user = userEvent.setup();
    grip('Priya').focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Escape}');

    expect(announcement()).toContain('stayed where it was');
    expect(screen.queryByRole('dialog', { name: 'Launch' })).toBeNull();
  });
});

/**
 * The two meanings of an agent→agent drop (§5.3 rows 3 and 4).
 *
 * Both are live from M9: outside Reorder mode the drop opens §10.4's pair
 * dialog, inside it the drop reorders the board. Each keeps its own keyboard
 * path, which is what IMPLEMENTATION §11 then requires of both.
 */
describe('agent → agent: the pair gesture (§5.3 row 3, §10.4)', () => {
  it('opens the pair dialog with both seats pre-filled, and starts nothing', async () => {
    const fixture = serving({ agents: [PRIYA, SAM], projects: [LPM] });
    mount(<App />, { respond: fixture.respond });
    await ready();

    const user = userEvent.setup();
    grip('Priya').focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    // The live region says what the drop will do, not what it used to do.
    expect(announcement()).toContain('Start a pair: Priya drafting, Sam reviewing.');
    await user.keyboard(' ');

    await screen.findByRole('dialog', { name: 'Start a pair' });
    expect(announcement()).toContain('Nothing has started yet');
    // Nothing was written: this gesture is not a reorder any more.
    expect(fixture.puts).toEqual([]);
    expect(cardNames()).toEqual(['priya', 'sam']);
  });

  it('has a pointer-free equivalent on the card menu (§5.4)', async () => {
    const fixture = serving({ agents: [PRIYA, SAM], projects: [LPM] });
    mount(<App />, { respond: fixture.respond });
    await ready();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Priya' }));
    await user.click(screen.getByRole('menuitem', { name: 'Start a pair…' }));
    await screen.findByRole('dialog', { name: 'Start a pair' });
  });
});

describe('board reorder by keyboard, persisted as one whole-list write (§5.3)', () => {
  /** §5.4's Reorder mode is what makes a drag mean "reorder" (see `dnd.ts`). */
  async function enterReorderMode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Reorder' }));
  }

  it('drops onto another card, moves it, and PUTs the whole order once', async () => {
    const fixture = serving({ agents: [PRIYA, SAM], projects: [LPM] });
    mount(<App />, { respond: fixture.respond });
    await ready();
    expect(cardNames()).toEqual(['priya', 'sam']);

    const user = userEvent.setup();
    await enterReorderMode(user);
    grip('Priya').focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    expect(announcement()).toContain("Move Priya to Sam's place.");
    await user.keyboard(' ');

    await waitFor(() => expect(fixture.puts).toHaveLength(1));
    expect(fixture.puts[0]?.body).toEqual({ order: ['sam', 'priya'] });
    await waitFor(() => expect(cardNames()).toEqual(['sam', 'priya']));
  });

  it('rolls back with a toast when the server refuses the order', async () => {
    const message =
      'Board order names 1 agent the roster does not know: ghost. The previous order stands.';
    const fixture = serving({
      agents: [PRIYA, SAM],
      projects: [LPM],
      boardOrderStatus: 400,
      boardOrderBody: { error: 'unknown_board_order_id', message },
    });
    mount(<App />, { respond: fixture.respond });
    await ready();

    const user = userEvent.setup();
    await enterReorderMode(user);
    grip('Priya').focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    await user.keyboard(' ');

    // The previous order stands, and the server's own words are the toast.
    await waitFor(() =>
      expect(
        within(screen.getByRole('status', { name: 'Notifications' })).getByText(message),
      ).toBeInTheDocument(),
    );
    expect(cardNames()).toEqual(['priya', 'sam']);
  });
});

describe('Reorder mode — the pointer-free path to board order (§5.4)', () => {
  it('gives every card ▲▼ and a position readout, and persists once on leaving', async () => {
    const fixture = serving({ agents: [PRIYA, SAM], projects: [LPM] });
    mount(<App />, { respond: fixture.respond });
    await ready();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reorder' }));

    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move Priya up' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Move Priya down' }));
    await waitFor(() => expect(cardNames()).toEqual(['sam', 'priya']));
    // Nothing has been written yet: "leaving the mode persists once".
    expect(fixture.puts).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Done reordering' }));
    await waitFor(() => expect(fixture.puts).toHaveLength(1));
    expect(fixture.puts[0]?.body).toEqual({ order: ['sam', 'priya'] });
    expect(screen.queryByText('1 of 2')).toBeNull();
  });
});

describe('the card menu — the non-drag path to the launch flow (§5.4)', () => {
  it('opens the launch flow with the agent pre-filled and the project to pick', async () => {
    const fixture = serving({ agents: [PRIYA], projects: [LPM] });
    mount(<App />, { respond: fixture.respond });
    await ready();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Priya' }));
    await user.click(screen.getByRole('menuitem', { name: 'Launch on…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Launch' });
    expect(within(dialog).getByLabelText('Agent')).toHaveValue('priya');
    expect(within(dialog).getByLabelText('Project')).toHaveValue('');
  });

  it('closes on Escape and returns focus to the trigger (§15)', async () => {
    const fixture = serving({ agents: [PRIYA], projects: [LPM] });
    mount(<App />, { respond: fixture.respond });
    await ready();

    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'Actions for Priya' });
    await user.click(trigger);
    await act(async () => {
      await user.keyboard('{Escape}');
    });
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe('an archived agent is not draggable (§5.2)', () => {
  it('has no grip and no launch action', async () => {
    const fixture = serving({
      agents: [
        PRIYA,
        anAgent({ id: 'old', name: 'Old Hand', archivedAt: '2026-07-01T00:00:00.000Z' }),
      ],
      projects: [LPM],
    });
    mount(<App />, { respond: fixture.respond });
    await ready();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Archived' }));
    expect(screen.queryByRole('button', { name: 'Move or launch Old Hand' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Actions for Old Hand' }));
    expect(screen.getByRole('menuitem', { name: 'Launch on…' })).toBeDisabled();
  });
});
