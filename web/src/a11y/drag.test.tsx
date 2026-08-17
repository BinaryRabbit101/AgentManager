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

describe('agent → project', () => {
  it('keyboard: lift, arrow to the project, drop into the launch flow', async () => {
    mountAt('/');
    await board();
    const user = userEvent.setup();

    grip('Ada').focus();
    await user.keyboard(' ');
    expect(announcement()).toContain('Picked up Ada');
    // Ring: [Ada, Sam, littlepocketmuseum].
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(announcement()).toContain('Launch Ada on littlepocketmuseum.');
    await user.keyboard(' ');

    const dialog = await screen.findByRole('dialog', { name: 'Launch' });
    await waitFor(() => expect(within(dialog).getByLabelText('Agent')).toHaveValue('ada'));
    expect(within(dialog).getByLabelText('Project')).toHaveValue('lpm');
    expect(announcement()).toContain('Nothing has started yet');
  }, 20_000);

  it('pointer-free: the card menu’s Launch on…, and the project’s Launch an agent…', async () => {
    mountAt('/');
    await board();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Actions for Ada' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Launch on…' }));
    let dialog = await screen.findByRole('dialog', { name: 'Launch' });
    expect(within(dialog).getByLabelText('Agent')).toHaveValue('ada');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Launch' })).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Launch an agent…' }));
    dialog = await screen.findByRole('dialog', { name: 'Launch' });
    expect(within(dialog).getByLabelText('Project')).toHaveValue('lpm');
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

    const dialog = await screen.findByRole('dialog', { name: 'Launch' });
    // The item rides along: its title seeds the prompt and its scope shows.
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
    const dialog = await screen.findByRole('dialog', { name: 'Launch' });
    await waitFor(() =>
      expect(within(dialog).getByText(/Scoped to src\/import/u)).toBeInTheDocument(),
    );
  }, 20_000);
});

describe('agent → agent (the pair)', () => {
  it('keyboard: lift one card, arrow to another, drop into the pair dialog', async () => {
    mountAt('/');
    await board();
    const user = userEvent.setup();

    grip('Ada').focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    expect(announcement()).toContain('Start a pair: Ada drafting, Sam reviewing.');
    await user.keyboard(' ');

    const dialog = await screen.findByRole('dialog', { name: 'Start a pair' });
    await waitFor(() => expect(within(dialog).getByLabelText('drafter agent')).toHaveValue('ada'));
    expect(within(dialog).getByLabelText('critic agent')).toHaveValue('sam');
    expect(announcement()).toContain('Nothing has started yet');
  }, 20_000);

  it('pointer-free: the card menu’s Start a pair…', async () => {
    mountAt('/');
    await board();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Actions for Ada' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Start a pair…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start a pair' });
    await waitFor(() => expect(within(dialog).getByLabelText('drafter agent')).toHaveValue('ada'));
    // The critic seat is left to pick — the menu names one agent, not two.
    expect(within(dialog).getByLabelText('critic agent')).toHaveValue('');
  }, 20_000);
});

describe('board reorder', () => {
  it('keyboard: Reorder mode, lift, arrow, drop — and the order is written once', async () => {
    const mounted = mountAt('/');
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
    // …and no pair dialog: the two agent→agent gestures stay apart.
    expect(screen.queryByRole('dialog', { name: 'Start a pair' })).toBeNull();
  }, 20_000);

  it('pointer-free: the ▲▼ controls, persisted once on leaving the mode', async () => {
    const mounted = mountAt('/');
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
    mountAt('/');
    await board();
    const user = userEvent.setup();

    grip('Ada').focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.keyboard('{Escape}');

    expect(announcement()).toContain('stayed where it was');
    expect(screen.queryByRole('dialog', { name: 'Launch' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Start a pair' })).toBeNull();
  }, 20_000);
});
