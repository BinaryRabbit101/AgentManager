/**
 * Project quick-add — register an existing folder (DESIGN §8.1,
 * IMPLEMENTATION §2).
 *
 * Two criteria, and they pull in different directions, which is why both are
 * here: the flow must be **short** (browse → inspect → create, no form to fill),
 * and a refusal must be **long enough to act on** — the server's own message,
 * with the offending path.
 *
 * The "under a minute" half is a human measurement and is on the manual-check
 * list (`scripts/ui-manual-checks.mjs`). What is asserted here is the thing that
 * decides it: the number of interactions between opening the dialog and seeing
 * the card, and that a typed path reaches the same place with no browsing at
 * all.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { aProject, json, mount } from '../../test/harness';
import type { BrowseListing, ProjectInspection } from '../api/types';

import { QuickAddDialog } from './QuickAddDialog';

const ROOTS: BrowseListing = {
  path: '',
  parent: null,
  roots: ['C:\\Users\\me', 'C:\\Code'],
  entries: [
    { name: 'me', path: 'C:\\Users\\me' },
    { name: 'Code', path: 'C:\\Code' },
  ],
};

const CODE: BrowseListing = {
  path: 'C:\\Code',
  parent: null,
  roots: ROOTS.roots,
  entries: [{ name: 'my-app', path: 'C:\\Code\\my-app' }],
};

const INSPECTION: ProjectInspection = {
  localPath: 'C:\\Code\\my-app',
  localPathKey: 'c:\\code\\my-app',
  name: 'my-app',
  slug: 'my-app',
  vcs: 'git',
  repoUrl: 'https://example.invalid/my-app.git',
  defaultBranch: 'main',
  unc: false,
  warnings: [],
};

interface ServerOptions {
  readonly inspection?: ProjectInspection;
  readonly inspectRefusal?: { status: number; body: unknown };
  readonly createRefusal?: { status: number; body: unknown };
}

function server(options: ServerOptions = {}) {
  const posted: { path: string; body: unknown }[] = [];
  const respond = (url: string, init: RequestInit): Response => {
    const [path, query] = url.split('?');
    if (path === '/api/fs/browse') {
      const asked = new URLSearchParams(query ?? '').get('path');
      return json(asked === null ? ROOTS : CODE);
    }
    if (init.method === 'POST') {
      // The client always sends a JSON string body; anything else is a bug in
      // the client rather than in the fixture, so it is asserted here.
      const raw = init.body;
      if (typeof raw !== 'string') throw new TypeError('the client sent a non-string body');
      posted.push({ path: path ?? '', body: JSON.parse(raw) as unknown });
    }
    if (path === '/api/projects/inspect') {
      if (options.inspectRefusal !== undefined) {
        return json(options.inspectRefusal.body, options.inspectRefusal.status);
      }
      return json(options.inspection ?? INSPECTION);
    }
    if (path === '/api/projects' && init.method === 'POST') {
      if (options.createRefusal !== undefined) {
        return json(options.createRefusal.body, options.createRefusal.status);
      }
      return json(aProject({ id: 'p1', name: 'my-app', localPath: 'C:\\Code\\my-app' }), 201);
    }
    return json({ error: 'not_found', message: `No fixture for ${path ?? ''}.` }, 404);
  };
  return { respond, posted };
}

describe('browse → inspect → create (§8.1)', () => {
  it('registers a folder in four interactions and no typing', async () => {
    const api = server();
    const created: string[] = [];
    const started = Date.now();
    mount(<QuickAddDialog onClose={() => undefined} onCreated={(p) => created.push(p.name)} />, {
      respond: api.respond,
    });

    // 1 — Browse, from nothing: the roots, so a navigator with no knowledge of
    // the machine has somewhere to start.
    await userEvent.click(screen.getByRole('button', { name: 'Browse' }));
    const folders = await screen.findByRole('list', { name: 'Folders' });
    expect(within(folders).getByRole('button', { name: 'Code' })).toBeInTheDocument();

    // 2 — descend.
    await userEvent.click(within(folders).getByRole('button', { name: 'Code' }));
    await waitFor(() => expect(screen.getByLabelText('Folder path')).toHaveValue('C:\\Code'));

    // 3 — Inspect. The form comes back prefilled; nothing was typed.
    await userEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('my-app'));
    expect(screen.getByText('C:\\Code\\my-app')).toBeInTheDocument();
    expect(screen.getByText('https://example.invalid/my-app.git')).toBeInTheDocument();

    // 4 — Create.
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(created).toEqual(['my-app']));

    expect(api.posted.map((call) => call.path)).toEqual(['/api/projects/inspect', '/api/projects']);
    expect(api.posted[1]?.body).toMatchObject({
      localPath: 'C:\\Code\\my-app',
      name: 'my-app',
      slug: 'my-app',
    });
    // The machine half of "under a minute" is milliseconds; the human half is
    // the manual check. This only guards against an accidental sleep or poll.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('accepts a typed absolute path with no browsing at all', async () => {
    // §8.1: "Both always accept a typed absolute path." Over the tailnet this is
    // the path that must never be stranded on the desktop.
    const api = server();
    mount(<QuickAddDialog onClose={() => undefined} />, { respond: api.respond });

    await userEvent.type(screen.getByLabelText('Folder path'), 'C:\\Code\\my-app');
    await userEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('my-app'));

    expect(api.posted[0]).toMatchObject({
      path: '/api/projects/inspect',
      body: { localPath: 'C:\\Code\\my-app' },
    });
    // Nothing was browsed.
    expect(screen.queryByRole('list', { name: 'Folders' })).not.toBeInTheDocument();
  });

  it('posts the reviewed name, not the inspected one, when it is edited', async () => {
    const api = server();
    mount(<QuickAddDialog onClose={() => undefined} />, { respond: api.respond });
    await userEvent.type(screen.getByLabelText('Folder path'), 'C:\\Code\\my-app');
    await userEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('my-app'));

    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Museum');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.posted).toHaveLength(2));
    expect(api.posted[1]?.body).toMatchObject({ name: 'Museum' });
  });

  it('renders inspection warnings verbatim, and still lets the folder be created', async () => {
    const api = server({
      inspection: {
        ...INSPECTION,
        warnings: [
          { code: 'uncommitted_changes', message: 'This repository has uncommitted changes.' },
          { code: 'network_share', message: 'C:\\Code\\my-app is on a network share.' },
        ],
      },
    });
    mount(<QuickAddDialog onClose={() => undefined} />, { respond: api.respond });
    await userEvent.type(screen.getByLabelText('Folder path'), 'C:\\Code\\my-app');
    await userEvent.click(screen.getByRole('button', { name: 'Inspect' }));

    await waitFor(() =>
      expect(screen.getByText('This repository has uncommitted changes.')).toBeInTheDocument(),
    );
    expect(screen.getByText('C:\\Code\\my-app is on a network share.')).toBeInTheDocument();
    // A warning is not a refusal.
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });
});

describe('refusals render the server’s message with the offending path (§8.1)', () => {
  const cases = [
    {
      what: 'a nested project',
      status: 409,
      body: {
        error: 'nested_project',
        message: 'C:\\Code\\my-app\\sub is inside the registered project C:\\Code\\my-app.',
        path: 'C:\\Code\\my-app\\sub',
      },
    },
    {
      what: 'a folder that is already registered',
      status: 409,
      body: {
        error: 'already_registered',
        message: 'C:\\Code\\my-app is already registered as "my-app".',
        path: 'C:\\Code\\my-app',
      },
    },
    {
      what: 'a folder inside the data root',
      status: 400,
      body: {
        error: 'inside_data_root',
        message:
          'C:\\Users\\me\\AppData\\Local\\AgentManager\\x is inside AgentManager’s own data root.',
        path: 'C:\\Users\\me\\AppData\\Local\\AgentManager\\x',
      },
    },
  ] as const;

  for (const testCase of cases) {
    it(`shows ${testCase.what} exactly as the server worded it`, async () => {
      const api = server({ inspectRefusal: { status: testCase.status, body: testCase.body } });
      mount(<QuickAddDialog onClose={() => undefined} />, { respond: api.respond });

      await userEvent.type(screen.getByLabelText('Folder path'), 'C:\\anything');
      await userEvent.click(screen.getByRole('button', { name: 'Inspect' }));

      const notice = await screen.findByRole('alert');
      // Verbatim: projects wrote this for a human and it names the path that
      // caused it. Paraphrasing would delete the one fact that fixes it.
      expect(notice).toHaveTextContent(testCase.body.message);
      expect(notice).toHaveTextContent(testCase.body.path);
      expect(notice).toHaveAttribute('data-error-code', testCase.body.error);
      // And no half-filled form is left behind.
      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    });
  }

  it('shows a refusal that arrives only at create, without losing the form', async () => {
    const api = server({
      createRefusal: {
        status: 409,
        body: {
          error: 'already_registered',
          message: 'C:\\Code\\my-app is already registered as "my-app".',
          path: 'C:\\Code\\my-app',
        },
      },
    });
    mount(<QuickAddDialog onClose={() => undefined} />, { respond: api.respond });
    await userEvent.type(screen.getByLabelText('Folder path'), 'C:\\Code\\my-app');
    await userEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('my-app'));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('C:\\Code\\my-app is already registered as "my-app".');
    // The reviewed values survive, so the user can change the one that was wrong.
    expect(screen.getByLabelText('Name')).toHaveValue('my-app');
  });

  it('surfaces a browse refusal without emptying the navigator’s own message', async () => {
    const respond = (url: string): Response =>
      url.startsWith('/api/fs/browse')
        ? json(
            {
              error: 'browse_root_violation',
              message:
                '"D:\\elsewhere" is outside the folders AgentManager may browse. Configure projects.browseRoots to widen them.',
              path: 'D:\\elsewhere',
            },
            403,
          )
        : json({}, 404);
    mount(<QuickAddDialog onClose={() => undefined} />, { respond });

    await userEvent.click(screen.getByRole('button', { name: 'Browse' }));
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('is outside the folders AgentManager may browse');
  });
});

describe('the dialog itself (§15)', () => {
  it('is a modal dialog, focuses its first field, and closes on Esc', async () => {
    let closed = 0;
    mount(<QuickAddDialog onClose={() => (closed += 1)} />, { respond: server().respond });

    const dialog = screen.getByRole('dialog', { name: 'Add project' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(screen.getByLabelText('Folder path')).toHaveFocus());

    await userEvent.keyboard('{Escape}');
    expect(closed).toBe(1);
  });

  it('cannot inspect an empty path', () => {
    mount(<QuickAddDialog onClose={() => undefined} />, { respond: server().respond });
    expect(screen.getByRole('button', { name: 'Inspect' })).toBeDisabled();
  });
});
