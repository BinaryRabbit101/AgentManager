/**
 * Every way in reaches the **one** flow (DESIGN §5.4, §6).
 *
 * > "Both paths call the same code. There is no 'mobile launch' and 'desktop
 * > launch' — one launch flow, reached several ways."
 *
 * That was true of the launch flow and false of the app: a second dialog sat
 * beside it, reached from different buttons on the same screens, and which one
 * you got decided what you were allowed to do. This file is the guard against
 * that coming back — it opens the flow from every entry point the app has and
 * finds the same dialog each time, pre-filled with whatever the gesture knew.
 *
 * The drag entries are asserted in `a11y/drag.test.tsx`, beside the keyboard
 * paths they have to keep, so the four gestures stay in one place.
 */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { mountAt } from '../../test/routes';
import { useAppStore } from '../state/store';

afterEach(() => {
  cleanup();
  useAppStore.getState().reset();
});

async function flow(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: 'Start work' });
}

describe('every entry point opens Start work (§5.4, §6)', () => {
  it('home’s Start work, with nothing pre-filled — home knows neither', async () => {
    mountAt('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start work' }));

    const sheet = await flow();
    // Both questions still open, which is what the button promised.
    expect(within(sheet).getByLabelText('Project')).toHaveValue('');
    for (const box of within(sheet).getAllByRole('checkbox')) expect(box).not.toBeChecked();
  }, 20_000);

  it('the board card’s ⋯ → Start work…, with that agent already ticked', async () => {
    mountAt('/agents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Ada' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Start work…' }));

    const sheet = await flow();
    await waitFor(() =>
      expect(within(sheet).getByRole('checkbox', { name: /^Ada/u })).toBeChecked(),
    );
    // Sam is one tick away — which is what makes this the pointer-free
    // equivalent of the agent→agent drag as well as the agent→project one.
    expect(within(sheet).getByRole('checkbox', { name: /^Sam/u })).not.toBeChecked();
  }, 20_000);

  it('the board card menu no longer offers a second dialog to choose between', async () => {
    mountAt('/agents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Ada' }));
    expect(screen.queryByRole('menuitem', { name: 'Launch on…' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Start a pair…' })).toBeNull();
  }, 20_000);

  it('a project card’s Start work…, with the project answered', async () => {
    mountAt('/projects');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start work…' }));

    const sheet = await flow();
    // §6: the project step is skipped when the gesture carried one.
    await waitFor(() => expect(within(sheet).getByText('littlepocketmuseum')).toBeInTheDocument());
    expect(within(sheet).queryByLabelText('Project')).toBeNull();
    // And the card offers one button, not a choice of dialogs.
    expect(screen.queryByRole('button', { name: 'Start a pair…' })).toBeNull();
  }, 20_000);

  it('the project page header’s Start work…', async () => {
    mountAt('/projects/lpm');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start work…' }));

    const sheet = await flow();
    await waitFor(() => expect(within(sheet).getByText('littlepocketmuseum')).toBeInTheDocument());
    // The project's own `defaults.agentIds` pre-tick (projects §1.2).
    await waitFor(() =>
      expect(within(sheet).getByRole('checkbox', { name: /^Ada/u })).toBeChecked(),
    );
  }, 20_000);

  it('a work-item row’s Assign an agent…, with the item attached', async () => {
    mountAt('/projects/lpm');
    await waitFor(() =>
      expect(screen.getByText('The importer drops trailing commas')).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Assign an agent/u }));

    const sheet = await flow();
    // §5.3: the item's `scopePaths` are shown, outside the collapsed options.
    await waitFor(() =>
      expect(within(sheet).getByText(/Scoped to src\/import/u)).toBeInTheDocument(),
    );
    // …and its title seeded the task, so the fast path is one keystroke away.
    expect(within(sheet).getByLabelText(/What should/u)).toHaveValue(
      'The importer drops trailing commas',
    );
  }, 20_000);
});
