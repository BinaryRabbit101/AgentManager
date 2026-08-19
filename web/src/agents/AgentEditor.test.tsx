/**
 * The agent editor's controls (ui DESIGN §7.1).
 *
 * `editorModel.test.ts` owns what the form *posts*; this file owns what the form
 * *is* — and the two meet at {@link toCreateBody}, which every case here calls on
 * the model the controls produced. That is the point: WO1 changed three inputs
 * into pickers and hid four textareas, and the only claim worth testing is that
 * none of that moved a byte of the wire format.
 *
 * The editor takes its model as a prop and reports edits through `onChange`, so
 * these mount it under a tiny stateful wrapper rather than through `App` — the
 * page-level paths (save, PATCH bodies) are already covered in
 * `AgentDetail.test.tsx` and do not need repeating per control.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { AgentEditor } from './AgentEditor';
import { EMPTY_MODEL, toCreateBody, type EditorModel } from './editorModel';

function open(initial: Partial<EditorModel> = {}) {
  const held = { model: { ...EMPTY_MODEL, name: 'Priya', ...initial } };

  function Editing(): ReactElement {
    const [model, setModel] = useState<EditorModel>(held.model);
    held.model = model;
    return <AgentEditor model={model} onChange={(patch) => setModel({ ...model, ...patch })} />;
  }

  render(<Editing />);
  return { body: (): Record<string, unknown> => toCreateBody(held.model) };
}

function addenda(): HTMLElement {
  return screen.getByRole('group', { name: 'Role addenda' });
}

describe('model pickers (§7.1, roster §8)', () => {
  it('offers the aliases as a dropdown and posts the chosen one verbatim', async () => {
    const view = open();
    const user = userEvent.setup();

    const primary = screen.getByLabelText('Alias or id');
    await user.selectOptions(primary, 'opus');
    await user.selectOptions(screen.getByLabelText('Fallback'), 'sonnet');

    expect(view.body()['model']).toEqual({ primary: 'opus', fallback: 'sonnet' });
  });

  it('keeps the empty choice, which means roster’s own default rather than a value', () => {
    const view = open();

    expect(screen.getByLabelText('Alias or id')).toHaveDisplayValue('roster’s default');
    expect(screen.getByLabelText('Fallback')).toHaveDisplayValue('none');
    expect(view.body()).not.toHaveProperty('model');
  });

  it('loads a full model id into the custom input and posts it back unchanged', async () => {
    // roster validates aliases warn-not-block precisely so an id newer than this
    // build stays usable (§8). A picker that swallowed it would break that.
    const view = open({ modelPrimary: 'claude-opus-5' });
    const user = userEvent.setup();

    expect(screen.getByLabelText('Alias or id')).toHaveDisplayValue('Custom model id…');
    expect(screen.getByLabelText('Custom model id')).toHaveValue('claude-opus-5');

    await user.type(screen.getByLabelText('Custom model id'), '-20260819');
    expect(view.body()['model']).toEqual({ primary: 'claude-opus-5-20260819' });
  });

  it('reveals the text input when the custom option is picked, and hides it again', async () => {
    const view = open();
    const user = userEvent.setup();
    const primary = screen.getByLabelText('Alias or id');

    expect(screen.queryByLabelText('Custom model id')).toBeNull();
    await user.selectOptions(
      primary,
      within(primary).getByRole('option', { name: 'Custom model id…' }),
    );
    await user.type(screen.getByLabelText('Custom model id'), 'claude-haiku-9');
    expect(view.body()['model']).toEqual({ primary: 'claude-haiku-9' });

    await user.selectOptions(primary, 'haiku');
    expect(screen.queryByLabelText('Custom model id')).toBeNull();
    expect(view.body()['model']).toEqual({ primary: 'haiku' });
  });

  it('closes the effort enum entirely — no custom escape, because a typo is a 400', async () => {
    const view = open({ modelPrimary: 'opus' });
    const user = userEvent.setup();

    const effort = screen.getByLabelText('Effort');
    expect(within(effort).queryByRole('option', { name: 'Custom model id…' })).toBeNull();
    expect(
      within(effort)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);

    expect(view.body()['model']).toEqual({ primary: 'opus' });
    await user.selectOptions(effort, 'xhigh');
    expect(view.body()['model']).toEqual({ primary: 'opus', effort: 'xhigh' });
  });
});

describe('emoji avatar picker (§7.1)', () => {
  it('clicks an emoji into the avatar field', async () => {
    const view = open();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Use 🦊' }));

    expect(screen.getByLabelText('Avatar emoji')).toHaveValue('🦊');
    expect(view.body()['avatar']).toEqual({ kind: 'emoji', value: '🦊' });
    expect(screen.getByRole('button', { name: 'Use 🦊' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('is a shortcut, not the set of legal answers — the field still takes anything', async () => {
    const view = open();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Avatar emoji'), '🫥');

    expect(view.body()['avatar']).toEqual({ kind: 'emoji', value: '🫥' });
  });
});

describe('role addenda are optional and say so (§7.1, roster §4)', () => {
  it('starts closed and empty when the agent has neither addenda nor roles', () => {
    open();

    const group = addenda();
    expect(group.querySelector('details')).not.toHaveAttribute('open');
    expect(within(group).queryAllByRole('textbox')).toHaveLength(0);
    expect(group.textContent).toContain('Solo runs never read these');
  });

  it('opens on load when the agent already has one, and shows only that box', () => {
    open({ roleAddenda: { skeptic: 'Argue against.' } });

    const group = addenda();
    expect(group.querySelector('details')).toHaveAttribute('open');
    expect(within(group).getAllByRole('textbox')).toHaveLength(1);
    expect(within(group).getByLabelText(/^skeptic/u)).toHaveValue('Argue against.');
  });

  it('reveals a box when the role is checked in Roles above', async () => {
    open();
    const user = userEvent.setup();

    expect(within(addenda()).queryByLabelText(/^reviewer/u)).toBeNull();
    await user.click(
      within(screen.getByRole('group', { name: 'Roles' })).getByRole('checkbox', {
        name: 'reviewer',
      }),
    );

    expect(within(addenda()).getByLabelText('reviewer')).toBeInTheDocument();
  });

  it('reaches an unlisted role through the picker, and still posts it verbatim', async () => {
    // §4 keeps the seat list and the addenda independent, so every role has to
    // stay reachable — the disclosure hides them, it does not remove them.
    const view = open();
    const user = userEvent.setup();

    await user.click(screen.getByText('Role addenda — optional, for team seats'));
    await user.selectOptions(screen.getByLabelText('Add addendum for…'), 'architect');

    const box = within(addenda()).getByLabelText('architect (not a listed role)');
    await user.type(box, 'Draw the seams first.');

    expect(view.body()['roleAddenda']).toEqual({ architect: 'Draw the seams first.' });
    // …and the picker stops offering what it has already revealed.
    expect(within(addenda()).queryByRole('option', { name: 'architect' })).toBeNull();
  });

  it('writes nothing for a role whose box was revealed and never typed in', async () => {
    const view = open();
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText('Add addendum for…'), 'overseer');

    expect(within(addenda()).getByLabelText('overseer (not a listed role)')).toBeInTheDocument();
    expect(view.body()).not.toHaveProperty('roleAddenda');
  });
});
