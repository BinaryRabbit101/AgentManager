/**
 * The four drag gestures, twice each (IMPLEMENTATION §11).
 *
 * > "**Every drag gesture has a working keyboard path and a working
 * > pointer-free path**, each covered by its own test: agent→project,
 * > agent→work item, agent→agent, and board reorder."
 *
 * Eight tests, named after the eight cells of that sentence. They drive
 * dnd-kit's **real** `KeyboardSensor` for the keyboard half and the real menus
 * for the pointer-free half — never a hand-called drop handler — because the
 * criterion is that the *paths* work, and a handler called directly proves only
 * that the handler exists.
 *
 * `board reorder` is the one that needs saying twice: §5.4 gives it a keyboard
 * path (lift, arrows, drop, **inside Reorder mode**) and a pointer-free one (the
 * ▲▼ controls of that same mode). Reorder mode is also what distinguishes an
 * agent→agent *reorder* from an agent→agent *pair* (see `board/dnd.ts`), so the
 * two gestures cannot be conflated by accident.
 */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { useAppStore } from '../state/store';

import { mountAt } from '../../test/routes';

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = (): void => undefined;
  }
});

afterEach(() => {
  cleanup();
  useAppStore.getState().reset();
});

/** dnd-kit's own live region — every gesture below is announced into it. */
function announcement(): string {
  return [...document.querySelectorAll('[aria-live="assertive"]')]
    .map((region) => region.textContent ?? '')
    .join(' ');
}

function grip(name: string): HTMLElement {
  return screen.getByRole('button', { name: `Move or launch ${name}` });
}

async function board(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('link', { name: 'Ada' })).toBeInTheDocument());
}

/**
 * This gesture lives on `/projects` now, not on the board.
 *
 * The project cards moved to their own route, and a drop target needs a drag
 * source on the same screen — so the agent chips moved with them, the same way
 * the project page carries chips for its work-item rows. The criterion is
 * unchanged: the keyboard path and the pointer-free path both reach §6's Start
 * work, and neither starts anything.
 */
describe('agent → project', () => {
  it('keyboard: lift an agent chip, arrow to the project, drop into Start work', async () => {
    mountAt('/projects');
    const user = userEvent.setup();

    const chip = await screen.findByRole('button', { name: 'Launch Ada on a project' });
    chip.focus();
    await user.keyboard(' ');
    expect(announcement()).toContain('Picked up Ada');
    // Ring: [littlepocketmuseum] — the chips are a source and not a target.
    await user.keyboard('{ArrowDown}');
    expect(announcement()).toContain('Launch Ada on littlepocketmuseum.');
    await user.keyboard(' ');

    const dialog = await screen.findByRole('dialog', { name: 'Start work' });
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: /^Ada/u })).toBeChecked(),
    );
    // The project the drop named is answered, so the picker is not asked again.
    expect(within(dialog).getByText('littlepocketmuseum')).toBeInTheDocument();
    expect(announcement()).toContain('Nothing has started yet');
  }, 20_000);

  it('pointer-free: the card menu’s Start work…, and the project card’s', async () => {
    mountAt('/agents');
    await board();
    let user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Actions for Ada' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Start work…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start work' });
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: /^Ada/u })).toBeChecked(),
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start work' })).toBeNull());
    cleanup();

    // The project-first half of the same pair, on the screen that now owns it.
    mountAt('/projects');
    user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start work…' }));
    const projectFirst = await screen.findByRole('dialog', { name: 'Start work' });
    await waitFor(() =>
      expect(within(projectFirst).getByText('littlepocketmuseum')).toBeInTheDocument(),
    );
  }, 20_000);
});

describe('agent → work item', () => {
  it('keyboard: lift the project page’s agent chip and drop it on the row', async () => {
    mountAt('/projects/lpm');
    await waitFor(() =>
      expect(screen.getByText('The importer drops trailing commas')).toBeInTheDocument(),
    );
    const user = userEvent.setup();

    const chip = screen.getByRole('button', { name: /Launch Ada on a work item/u });
    chip.focus();
    await user.keyboard(' ');
    expect(announcement()).toContain('Picked up Ada');
    await user.keyboard('{ArrowDown}');
    expect(announcement()).toContain('The importer drops trailing commas');
    await user.keyboard(' ');

    const dialog = await screen.findByRole('dialog', { name: 'Start work' });
    // The item rides along: its title seeds the task and its scope shows.
    await waitFor(() =>
      expect(within(dialog).getByText(/Scoped to src\/import/u)).toBeInTheDocument(),
    );
  }, 20_000);

  it('pointer-free: the row’s Assign an agent…', async () => {
    mountAt('/projects/lpm');
    await waitFor(() =>
      expect(screen.getByText('The importer drops trailing commas')).toBeInTheDocument(),
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Assign an agent/u }));
    const dialog = await screen.findByRole('dialog', { name: 'Start work' });
    await waitFor(() =>
      expect(within(dialog).getByText(/Scoped to src\/import/u)).toBeInTheDocument(),
    );
  }, 20_000);
});

/**
 * The gesture still means "these two, adversarially" — it just no longer picks
 * a dialog to mean it in. Both cards arrive ticked in §6's one flow and the
 * **Adversarial pair** radio is the one two agents open on, which is the same
 * outcome expressed as a selection the user can still change.
 */
describe('agent → agent (the pair)', () => {
  it('keyboard: lift one card, arrow to another, drop into Start work with both ticked', async () => {
    mountAt('/agents');
    await board();
    const user = userEvent.setup();

    grip('Ada').focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    expect(announcement()).toContain('Start a pair: Ada drafting, Sam reviewing.');
    await user.keyboard(' ');

    const dialog = await screen.findByRole('dialog', { name: 'Start work' });
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: /^Ada/u })).toBeChecked(),
    );
    expect(within(dialog).getByRole('checkbox', { name: /^Sam/u })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /adversarial pair/iu })).toBeChecked();
    expect(within(dialog).getByText(/Ada drafts · Sam reviews\./u)).toBeInTheDocument();
    expect(announcement()).toContain('Nothing has started yet');
  }, 20_000);

  it('pointer-free: the card menu’s Start work…, plus one more tick', async () => {
    mountAt('/agents');
    await board();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Actions for Ada' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Start work…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start work' });
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: /^Ada/u })).toBeChecked(),
    );
    // The second agent is left to pick — the menu names one, not two — and
    // ticking them is what turns a solo into a pair (§6).
    expect(within(dialog).getByRole('checkbox', { name: /^Sam/u })).not.toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: /^Sam/u }));
    expect(within(dialog).getByRole('radio', { name: /adversarial pair/iu })).toBeChecked();
  }, 20_000);
});

describe('board reorder', () => {
  it('keyboard: Reorder mode, lift, arrow, drop — and the order is written once', async () => {
    const mounted = mountAt('/agents');
    await board();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Reorder' }));
    grip('Ada').focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    // In Reorder mode the same target means "move", and says so.
    expect(announcement()).toContain("Move Ada to Sam's place.");
    await user.keyboard(' ');

    await waitFor(() =>
      expect(mounted.calls.filter((call) => call === '/api/roster/board-order')).toHaveLength(1),
    );
    expect(announcement()).toContain('Moved Ada');
    // …and no flow opened: the two agent→agent gestures stay apart.
    expect(screen.queryByRole('dialog', { name: 'Start work' })).toBeNull();
  }, 20_000);

  it('pointer-free: the ▲▼ controls, persisted once on leaving the mode', async () => {
    const mounted = mountAt('/agents');
    await board();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Reorder' }));
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move Ada down' }));
    // Nothing written yet — "leaving the mode persists once" (§5.4).
    expect(mounted.calls.filter((call) => call === '/api/roster/board-order')).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Done reordering' }));
    await waitFor(() =>
      expect(mounted.calls.filter((call) => call === '/api/roster/board-order')).toHaveLength(1),
    );
  }, 20_000);
});

describe('every gesture is announced, and Escape cancels every one of them', () => {
  it('says what will happen, then that nothing happened', async () => {
    mountAt('/agents');
    await board();
    const user = userEvent.setup();

    grip('Ada').focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.keyboard('{Escape}');

    expect(announcement()).toContain('stayed where it was');
    expect(screen.queryByRole('dialog', { name: 'Start work' })).toBeNull();
  }, 20_000);
});
