/**
 * The projects screen, rendered (DESIGN §2.1, §5.1, §5.3).
 *
 * These used to live in `Board.test.tsx`, because the projects list used to be
 * the board's right-hand rail. It is its own route now, so they mount the whole
 * app at `/projects` — still the production path, still `fetch` and the SSE
 * transport as the only substituted seams.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { anAgent, aProject, json, mount, type Responder } from '../../test/harness';
import { App } from '../App';
import type { AgentView, Project } from '../api/types';

function serving(initial: {
  agents?: readonly AgentView[];
  projects?: readonly Project[];
}): Responder {
  return (url) => {
    const path = url.split('?')[0] ?? url;
    if (path === '/api/roster/agents') {
      return json({ agents: initial.agents ?? [], diagnostics: [] });
    }
    if (path === '/api/projects') return json({ projects: initial.projects ?? [] });
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
}

function open(initial: Parameters<typeof serving>[0]): void {
  mount(<App />, { respond: serving(initial), route: '/projects' });
}

describe('the projects list (§5.1, on its own route)', () => {
  it('lists projects with their server-computed status and health chips', async () => {
    open({
      projects: [
        aProject({ id: 'lpm', name: 'littlepocketmuseum' }),
        aProject({
          id: 'nav',
          name: 'navigation',
          status: 'provisioning',
          health: [{ code: 'missing', level: 'error', message: 'C:\\Code\\navigation is gone.' }],
        }),
      ],
    });

    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'littlepocketmuseum' })).toBeInTheDocument(),
    );
    const list = screen.getByRole('region', { name: 'Projects' });
    expect(within(list).getByText('active')).toBeInTheDocument();
    expect(within(list).getByText('provisioning')).toBeInTheDocument();
    // Health is read, never derived (§4).
    const chip = within(list).getByText('missing');
    expect(chip).toHaveAttribute('title', 'C:\\Code\\navigation is gone.');
    expect(chip).toHaveAttribute('data-tone', 'danger');
  });

  it('has an empty state and an Add project button', async () => {
    open({});
    await waitFor(() =>
      expect(
        screen.getByText('No projects yet — point the app at a folder you already work in.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Add project/u })).toBeInTheDocument();
  });

  it('is reachable from the frame’s main navigation', async () => {
    mount(<App />, { respond: serving({ projects: [aProject({ id: 'lpm', name: 'lpm' })] }) });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    await userEvent.click(within(nav).getByRole('link', { name: 'Projects' }));
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
  });
});

/**
 * §5.3 row 1 followed the project cards off the board.
 *
 * The board has no project drop target any more, so the gesture would have died
 * with the rail. It lives here instead, on the same chips-plus-cards shape the
 * project page already uses for its work-item rows (§8.2 region 4).
 */
describe('agent → project, after the move (§5.3 row 1, §5.4)', () => {
  const PRIYA = anAgent({ id: 'priya', name: 'Priya', boardOrder: 0 });
  const LPM = aProject({ id: 'lpm', name: 'littlepocketmuseum' });

  const live = (): string =>
    [...document.querySelectorAll('[aria-live="assertive"]')]
      .map((region) => region.textContent ?? '')
      .join(' ');

  it('takes a keyboard drag from an agent chip onto a project card', async () => {
    open({ agents: [PRIYA], projects: [LPM] });
    const user = userEvent.setup();

    // The ring here is [littlepocketmuseum] — the chip is a source and not a
    // target — so one press reaches the project.
    const chip = await screen.findByRole('button', { name: 'Launch Priya on a project' });
    chip.focus();
    await user.keyboard(' ');
    expect(live()).toContain('Picked up Priya');

    await user.keyboard('{ArrowDown}');
    expect(live()).toContain('Launch Priya on littlepocketmuseum.');

    await user.keyboard(' ');

    // "Nothing is started by the drop itself" (§5.3).
    const dialog = await screen.findByRole('dialog', { name: 'Launch' });
    await waitFor(() => expect(within(dialog).getByLabelText('Agent')).toHaveValue('priya'));
    expect(within(dialog).getByLabelText('Project')).toHaveValue('lpm');
    expect(live()).toContain('Nothing has started yet');
  });

  it('still refuses a project that cannot be launched against, and says why', async () => {
    open({
      agents: [PRIYA],
      projects: [
        aProject({
          id: 'gone',
          name: 'navigation',
          health: [{ code: 'missing', level: 'error', message: 'C:\\Code\\navigation is gone.' }],
        }),
      ],
    });
    await screen.findByRole('link', { name: 'navigation' });

    const card = document.querySelector('[data-project-id="gone"]');
    expect(card?.getAttribute('data-drop-refused')).toBe('true');
    expect(card?.getAttribute('title')).toContain('folder is missing');
    // The non-drag path is refused for the same reason, in the same words.
    expect(within(card as HTMLElement).getByText(/Can’t launch/u).textContent).toContain(
      'folder is missing',
    );
    expect(
      within(card as HTMLElement).queryByRole('button', { name: 'Launch an agent…' }),
    ).toBeNull();

    // And the drop itself is refused out loud rather than swallowed.
    const user = userEvent.setup();
    const chip = screen.getByRole('button', { name: 'Launch Priya on a project' });
    chip.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    expect(live()).toContain("can't be launched on");
    await user.keyboard(' ');

    expect(screen.queryByRole('dialog', { name: 'Launch' })).toBeNull();
    await waitFor(() =>
      expect(
        within(screen.getByRole('status', { name: 'Notifications' })).getByText(
          /Nothing was started/u,
        ),
      ).toBeInTheDocument(),
    );
  });

  it('offers the project-first launch button, which is §5.4’s pointer-free path', async () => {
    open({ agents: [PRIYA], projects: [LPM] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Launch an agent…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Launch' });
    await waitFor(() => expect(within(dialog).getByLabelText('Project')).toHaveValue('lpm'));
    expect(within(dialog).getByLabelText('Agent')).toHaveValue('');
  });
});

describe('Add project opens over the page, not inside it (§8.1)', () => {
  it('renders the dialog on a scrim, so `aria-modal` is a description of the screen', async () => {
    open({});
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Add project/u }));

    const dialog = await screen.findByRole('dialog', { name: 'Add project' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // The scrim is what makes that true. `.dialog::backdrop` never applied here:
    // this is a div with a role, not a native `<dialog>`.
    expect(dialog.parentElement).toHaveClass('dialog-scrim');
  });
});
