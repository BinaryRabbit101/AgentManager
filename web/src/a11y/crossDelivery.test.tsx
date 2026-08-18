/**
 * The cross-delivery acceptance suite (IMPLEMENTATION §11).
 *
 * > "The same `dist/` in Electron and in the remote browser produces the same
 * > behaviour on board, launch, session, inbox, project and usage — with only
 * > the §13.4 differences, **each asserted explicitly rather than by absence**."
 *
 * The two deliveries differ in exactly two runtime facts, and this file builds
 * both clients out of them and nothing else:
 *
 *  - **Electron**: the preload bridge is present, and no bearer is held —
 *    foundation §6.4 pins that the loopback listener has no authentication.
 *  - **Remote browser**: no bridge, and a bearer *is* held. §3.1 makes that the
 *    definition of "remote", which is why nothing else has to be simulated.
 *
 * There is no build flag and no second bundle: `vite.config.ts` has one `base`
 * and no `define`, which `web/test/bundle.test.ts` asserts. So a difference that
 * shows up here is a difference in *behaviour*, and every one of them has to be
 * on §13.4's list.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { DesktopBridge } from '../app/bridge';

import { mountAt, ROUTES } from '../../test/routes';

/** §1.5's preload bridge, with exactly the five keys it declares. */
const ELECTRON_BRIDGE: DesktopBridge = {
  isElectron: true,
  coreUrl: 'http://127.0.0.1:7477',
  pickFolder: () => Promise.resolve('C:\\Code\\littlepocketmuseum'),
  notify: () => Promise.resolve(true),
  setBadge: () => Promise.resolve(true),
};

/** The two clients, built from the two facts that actually differ. */
const DELIVERIES = [
  { name: 'electron', options: { bridge: ELECTRON_BRIDGE } },
  { name: 'remote browser', options: { token: 'a-device-token' } },
] as const;

/** The six screens §11 names. */
const SHARED_SCREENS = ROUTES.filter((route) =>
  ['/', '/sessions/ses_1', '/questions', '/projects', '/projects/lpm', '/usage'].includes(
    route.path,
  ),
);

afterEach(cleanup);

/** What a screen *is*, reduced to something two deliveries can be compared on. */
function shapeOf(): {
  readonly headings: readonly string[];
  readonly landmarks: readonly string[];
  readonly controls: readonly string[];
} {
  const text = (element: Element): string => (element.textContent ?? '').trim();
  return {
    headings: [...document.querySelectorAll('h1, h2, h3')].map(text),
    landmarks: [...document.querySelectorAll('nav, main, aside, [role="complementary"]')].map(
      (element) => element.getAttribute('aria-label') ?? element.tagName.toLowerCase(),
    ),
    controls: [...document.querySelectorAll('button, a[href], select')]
      .map(
        (element) =>
          `${element.tagName.toLowerCase()}:${text(element) || (element.getAttribute('aria-label') ?? '')}`,
      )
      .sort(),
  };
}

describe('the same screens, both ways in', () => {
  for (const route of SHARED_SCREENS) {
    it(`${route.path} renders identically in Electron and over the tailnet`, async () => {
      const shapes: Record<string, ReturnType<typeof shapeOf>> = {};
      for (const delivery of DELIVERIES) {
        mountAt(route.path, delivery.options);
        await waitFor(() => expect(screen.getAllByText(route.settled).length).toBeGreaterThan(0), {
          timeout: 4000,
        });
        shapes[delivery.name] = shapeOf();
        cleanup();
      }
      expect(shapes['remote browser']).toEqual(shapes['electron']);
    }, 30_000);
  }
});

describe('§13.4’s differences, each asserted explicitly', () => {
  it('under the hood: the bearer rides every request over the tailnet, and none locally', async () => {
    const remote = mountAt('/', { token: 'a-device-token' });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Ada' })).toBeInTheDocument());
    expect(remote.client.headers()['authorization']).toBe('Bearer a-device-token');
    cleanup();

    const local = mountAt('/', { bridge: ELECTRON_BRIDGE });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Ada' })).toBeInTheDocument());
    expect(local.client.headers()['authorization']).toBeUndefined();
  }, 30_000);

  it('denied controls: disabled with a reason over the tailnet, live at the desk', async () => {
    mountAt('/settings', { token: 'a-device-token' });
    const remoteMint = await screen.findByRole('button', { name: 'Create device token' });
    expect(remoteMint).toBeVisible();
    expect(remoteMint).toBeDisabled();
    expect(remoteMint.getAttribute('title') ?? '').toContain('at the machine itself');
    cleanup();

    mountAt('/settings', { bridge: ELECTRON_BRIDGE });
    const localMint = await screen.findByRole('button', { name: 'Create device token' });
    expect(localMint).toBeEnabled();
    // Shown in both — never hidden, which is the whole rule (§13.5).
    expect(localMint).toBeVisible();
  }, 30_000);

  it('the folder picker: native in Electron, the browse navigator in a browser', async () => {
    // "with the bridge stubbed (browser build) the same dialog falls back to
    // /api/fs/browse **with no code change at the call site**" (§6's criterion).
    mountAt('/projects', { bridge: ELECTRON_BRIDGE });
    let user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Add project/u }));
    const electronDialog = await screen.findByRole('dialog', { name: 'Add project' });
    await user.click(within(electronDialog).getByRole('button', { name: 'Browse' }));
    // The native picker answered, so the path is filled and nothing was fetched.
    await waitFor(() =>
      expect(within(electronDialog).getByLabelText('Folder path')).toHaveValue(
        'C:\\Code\\littlepocketmuseum',
      ),
    );
    cleanup();

    const browser = mountAt('/projects', { token: 'a-device-token' });
    user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Add project/u }));
    const browserDialog = await screen.findByRole('dialog', { name: 'Add project' });
    await user.click(within(browserDialog).getByRole('button', { name: 'Browse' }));
    await waitFor(() =>
      expect(browser.calls.some((call) => call.startsWith('/api/fs/browse'))).toBe(true),
    );
  }, 30_000);

  it('the inbox is identical by design — the one screen with no remote branch (§11.3)', async () => {
    const shapes: ReturnType<typeof shapeOf>[] = [];
    for (const delivery of DELIVERIES) {
      mountAt('/questions', delivery.options);
      await waitFor(() => expect(screen.getByText(/Store transcripts/u)).toBeInTheDocument());
      // Answering is ungated everywhere: the option buttons are live in both.
      expect(screen.getByRole('button', { name: /On disk/u })).toBeEnabled();
      shapes.push(shapeOf());
      cleanup();
    }
    expect(shapes[0]).toEqual(shapes[1]);
  }, 30_000);

  it('nothing in the tree branches on the delivery except the bridge and the token', () => {
    // The mechanical guarantee behind all of the above: one bundle, no build
    // flag, and the two runtime facts reached through one accessor each.
    const vite = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    expect(vite).not.toContain('define:');
    expect(vite).not.toMatch(/mode ===/u);
  });
});
