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

import type { PermissionCatalogue } from '../api/types';

import { AgentEditor } from './AgentEditor';
import { EMPTY_MODEL, toCreateBody, type EditorModel } from './editorModel';
import { EMPTY_INTEGRATION } from './integrationsModel';

/**
 * A slice of roster's own catalogue, verbatim (`permissionCatalogue.ts`).
 *
 * Copied rather than reduced to placeholders because two of the assertions below
 * are about the *words* — the description an owner reads and the "usually deny"
 * hint — and a fixture saying `rule-one` would prove the wiring while hiding the
 * only thing WO2 was asked for.
 */
const CATALOGUE: PermissionCatalogue = {
  rules: [
    {
      rule: 'Read',
      description: 'read any file in the workspace',
      group: 'read',
      suggest: 'allow',
    },
    { rule: 'Grep', description: 'search file contents', group: 'read', suggest: 'allow' },
    {
      rule: 'Bash(npm install*)',
      description: 'install dependencies — usually deny',
      group: 'shell',
      suggest: 'deny',
    },
  ],
  tools: ['Bash', 'Edit', 'Write', 'Read'],
};

function open(initial: Partial<EditorModel> = {}, catalogue?: PermissionCatalogue) {
  const held = { model: { ...EMPTY_MODEL, name: 'Priya', ...initial } };

  function Editing(): ReactElement {
    const [model, setModel] = useState<EditorModel>(held.model);
    held.model = model;
    return (
      <AgentEditor
        model={model}
        onChange={(patch) => setModel({ ...model, ...patch })}
        catalogue={catalogue}
      />
    );
  }

  render(<Editing />);
  return { body: (): Record<string, unknown> => toCreateBody(held.model) };
}

function addenda(): HTMLElement {
  return screen.getByRole('group', { name: 'Role addenda' });
}

function bucket(name: 'allow' | 'deny' | 'ask'): HTMLElement {
  return screen.getByRole('group', { name });
}

/** The chips a bucket currently holds, in order, minus the ✕ each carries. */
function chips(name: 'allow' | 'deny' | 'ask'): string[] {
  return within(screen.getByRole('list', { name: `${name} rules` }))
    .getAllByRole('listitem')
    .map((chip) => (chip.textContent ?? '').replace('✕', ''));
}

/** Opens the shared picker under one bucket. */
async function picker(
  user: ReturnType<typeof userEvent.setup>,
  name: 'allow' | 'deny' | 'ask',
): Promise<HTMLElement> {
  await user.click(within(bucket(name)).getByRole('button', { name: `Add rule to ${name}` }));
  return screen.getByRole('group', { name: `Add a rule to ${name}` });
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

describe('permission rules as chips and a picker (§7.1, WO2)', () => {
  it('renders a loaded agent’s rules as chips, and removal posts the shortened list', async () => {
    const view = open({ allow: 'Read\nGrep\nBash(git status)', deny: 'Bash(rm *)' });
    const user = userEvent.setup();

    expect(chips('allow')).toEqual(['Read', 'Grep', 'Bash(git status)']);

    await user.click(screen.getByRole('button', { name: 'Remove Grep from allow' }));

    expect(view.body()['permissions']).toEqual({
      allow: ['Read', 'Bash(git status)'],
      deny: ['Bash(rm *)'],
    });
  });

  it('says what each bucket does, not only that deny wins', () => {
    open();

    expect(bucket('allow').textContent).toContain('Auto-approved');
    expect(bucket('deny').textContent).toContain('deny wins over every allow');
    expect(bucket('ask').textContent).toContain('a human answers a card');
  });

  it('adds a catalogue entry to the bucket whose picker is open', async () => {
    const view = open({}, CATALOGUE);
    const user = userEvent.setup();

    const open_ = await picker(user, 'allow');
    await user.click(
      within(open_).getByRole('button', { name: 'Read — read any file in the workspace' }),
    );

    expect(view.body()['permissions']).toEqual({ allow: ['Read'] });
    // The chip appears without closing the picker, so a second rule is one
    // click away rather than two.
    expect(chips('allow')).toEqual(['Read']);
  });

  it('hints when an entry’s suggestion differs from the open bucket, and adds anyway', async () => {
    const view = open({}, CATALOGUE);
    const user = userEvent.setup();

    const open_ = await picker(user, 'allow');
    const entry = within(open_).getByRole('button', {
      name: 'Bash(npm install*) — install dependencies — usually deny (usually deny)',
    });
    await user.click(entry);

    // A hint and never a refusal (WO2 §2): the rule lands in allow regardless.
    expect(view.body()['permissions']).toEqual({ allow: ['Bash(npm install*)'] });
  });

  it('composes Tool(pattern) from the select and the pattern box', async () => {
    const view = open({}, CATALOGUE);
    const user = userEvent.setup();

    const open_ = await picker(user, 'allow');
    await user.selectOptions(within(open_).getByLabelText('Tool'), 'Bash');
    await user.type(within(open_).getByLabelText('Pattern (optional)'), 'npm run test:*');
    await user.click(within(open_).getByRole('button', { name: 'Add Bash(npm run test:*)' }));

    expect(view.body()['permissions']).toEqual({ allow: ['Bash(npm run test:*)'] });
  });

  it('takes a raw rule the catalogue could never have held', async () => {
    const view = open({}, CATALOGUE);
    const user = userEvent.setup();

    const open_ = await picker(user, 'ask');
    await user.type(within(open_).getByLabelText('Raw rule'), 'Bash(gh pr merge*)');
    await user.click(within(open_).getByRole('button', { name: 'Add rule' }));

    expect(view.body()['permissions']).toEqual({ ask: ['Bash(gh pr merge*)'] });
  });

  it('offers mcp__gmail__* in Compose for a server that is only in the form', async () => {
    // Derived from the form rather than from a route, so a connector the owner
    // is adding right now is already spendable as a rule.
    open(
      { integrations: [{ ...EMPTY_INTEGRATION, name: 'gmail', command: 'gmail-mcp' }] },
      CATALOGUE,
    );
    const user = userEvent.setup();

    const open_ = await picker(user, 'allow');
    expect(
      within(within(open_).getByLabelText('Tool'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Bash', 'Edit', 'Write', 'Read', 'mcp__gmail__*']);
  });

  it('degrades to Compose and Raw when the catalogue never arrived', async () => {
    const view = open();
    const user = userEvent.setup();

    const open_ = await picker(user, 'deny');
    expect(open_.textContent).toContain('couldn’t be loaded');
    expect(within(open_).queryByRole('heading', { name: 'read' })).toBeNull();

    // Both remaining ways in still work — the form is never unusable for want
    // of a suggestion.
    await user.selectOptions(within(open_).getByLabelText('Tool'), 'Bash');
    await user.type(within(open_).getByLabelText('Pattern (optional)'), 'rm *');
    await user.click(within(open_).getByRole('button', { name: 'Add Bash(rm *)' }));
    await user.type(within(open_).getByLabelText('Raw rule'), 'WebFetch');
    await user.click(within(open_).getByRole('button', { name: 'Add rule' }));

    expect(view.body()['permissions']).toEqual({ deny: ['Bash(rm *)', 'WebFetch'] });
  });

  it('warns that a Write(path) rule is stored as Edit(path), and still posts it', () => {
    const view = open({ allow: 'Write(./docs/**)' });

    const warning = bucket('allow').querySelector('[data-rule-warning="inert-file-rule"]');
    expect(warning?.textContent).toContain('only Edit(path) rules are');
    // Never a gate: roster stays the authority and the rule goes as typed.
    expect(view.body()['permissions']).toEqual({ allow: ['Write(./docs/**)'] });
  });

  it('warns that an allow on AskUserQuestion will be lifted into ask', () => {
    open({ allow: 'AskUserQuestion' });

    const warning = bucket('allow').querySelector('[data-rule-warning="ask-user-question"]');
    expect(warning?.textContent).toContain('moved from allow into ask');
    // …and says nothing about denying it, which is a legitimate configuration.
    expect(bucket('deny').querySelector('[data-rule-warning]')).toBeNull();
  });

  it('warns about Edit(*) and about a duplicate, without refusing either', () => {
    open({ allow: 'Edit(*)\nRead\nRead' });

    expect(
      [...bucket('allow').querySelectorAll('[data-rule-warning]')].map((node) =>
        node.getAttribute('data-rule-warning'),
      ),
    ).toEqual(['wildcard-file-scope', 'duplicate']);
  });

  it('keeps the mode picker and posts an unchanged permissions block', async () => {
    const view = open({ allow: 'Read' });
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText('Permission mode'), 'acceptEdits');

    expect(view.body()['permissions']).toEqual({ mode: 'acceptEdits', allow: ['Read'] });
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
