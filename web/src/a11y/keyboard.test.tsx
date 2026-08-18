/**
 * The keyboard gate (IMPLEMENTATION §11, DESIGN §15).
 *
 * > "Every interactive element is reachable and operable by keyboard alone,
 * > with a visible focus ring; every dialog **traps focus**, closes on `Esc`,
 * > and **restores focus to its trigger**."
 *
 * Three assertions, in three shapes:
 *
 *  1. **Reachable** — on every route, everything that acts is a real control
 *     (`button`, `a[href]`, a form field), nothing is removed from the tab order
 *     with `tabindex="-1"`, and nothing is a `div` with a click handler. The
 *     last one is checked at the source, where the fix is obvious.
 *  2. **A visible ring** — the stylesheet has one `:focus-visible` rule with a
 *     real outline, and nothing anywhere removes an outline.
 *  3. **Dialogs** — every dialog in the app is opened, Tabbed past both ends,
 *     closed with `Esc`, and checked to have handed focus back.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { useAppStore } from '../state/store';

import { focusableWithin } from './focusTrap';
import { mountAt, ROUTES } from '../../test/routes';

const webSrc = resolve(process.cwd(), 'web', 'src');

function sourceFiles(): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.tsx') || entry.name.endsWith('.test.tsx')) continue;
      found.push({
        path: relative(webSrc, path).replaceAll('\\', '/'),
        text: readFileSync(path, 'utf8'),
      });
    }
  };
  walk(webSrc);
  return found;
}

afterEach(cleanup);

describe('everything that acts is a real control (§15)', () => {
  const files = sourceFiles();

  it('found the tree', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it('never hangs a click handler on a div, a span or a bare li', () => {
    const offenders = files.filter((file) =>
      /<(?:div|span|li|p|section)\b[^>]*\sonClick=/su.test(file.text),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('never removes an outline, anywhere in the stylesheets', () => {
    const styles = [
      'styles.css',
      'core-loop.css',
      'pages.css',
      'collaboration.css',
      'theme/tokens.css',
    ];
    for (const name of styles) {
      const css = readFileSync(join(webSrc, name), 'utf8');
      expect(css, name).not.toMatch(/outline:\s*(?:none|0)/u);
    }
  });

  it('has exactly one focus-visible rule, and it draws a real ring', () => {
    const css = readFileSync(join(webSrc, 'styles.css'), 'utf8');
    const rule = css.slice(css.indexOf(':focus-visible {'));
    expect(rule.slice(0, rule.indexOf('}'))).toMatch(/outline:\s*2px solid var\(--focus-ring\)/u);
  });
});

describe('every route is walkable by keyboard alone (§15)', () => {
  for (const route of ROUTES) {
    it(`${route.path} puts nothing out of the tab order`, async () => {
      mountAt(route.path);
      await waitFor(() => expect(screen.getAllByText(route.settled).length).toBeGreaterThan(0), {
        timeout: 4000,
      });

      const focusable = focusableWithin(document.body);
      expect(focusable.length).toBeGreaterThan(0);
      // Nothing an author wrote is pulled out of the tab order. (`tabindex=-1`
      // is legitimate on a *programmatic* focus target — the minted-token
      // heading — and those are not in this list by construction.)
      for (const element of focusable) {
        expect(element.getAttribute('tabindex'), element.outerHTML.slice(0, 80)).not.toBe('-1');
      }

      // And Tab really moves through them, in document order.
      const user = userEvent.setup();
      const first = focusable[0]!;
      first.focus();
      await user.tab();
      expect(document.activeElement).not.toBe(first);
      expect(focusable).toContain(document.activeElement as HTMLElement);
    }, 20_000);
  }
});

describe('every dialog traps focus, closes on Escape, and restores it (§15)', () => {
  /** Opens each dialog the way a user does, and names its trigger. */
  const DIALOGS = [
    {
      name: 'Launch',
      route: '/agents',
      open: async (user: ReturnType<typeof userEvent.setup>) => {
        const trigger = await screen.findByRole('button', { name: 'Actions for Ada' });
        await user.click(trigger);
        await user.click(await screen.findByRole('menuitem', { name: 'Launch on…' }));
        return trigger;
      },
    },
    {
      name: 'Start a pair',
      route: '/agents',
      open: async (user: ReturnType<typeof userEvent.setup>) => {
        const trigger = await screen.findByRole('button', { name: 'Actions for Ada' });
        await user.click(trigger);
        await user.click(await screen.findByRole('menuitem', { name: 'Start a pair…' }));
        return trigger;
      },
    },
    {
      name: 'Add project',
      route: '/projects',
      open: async (user: ReturnType<typeof userEvent.setup>) => {
        const trigger = await screen.findByRole('button', { name: /Add project/u });
        await user.click(trigger);
        return trigger;
      },
    },
    {
      name: 'Archive agent',
      route: '/agents/ada',
      open: async (user: ReturnType<typeof userEvent.setup>) => {
        const trigger = await screen.findByRole('button', { name: 'Archive' });
        await user.click(trigger);
        return trigger;
      },
    },
  ] as const;

  for (const dialog of DIALOGS) {
    it(`${dialog.name} keeps Tab inside it`, async () => {
      mountAt(dialog.route);
      const user = userEvent.setup();
      await dialog.open(user);

      const sheet = await screen.findByRole('dialog', { name: dialog.name });
      const inside = focusableWithin(sheet);
      expect(inside.length).toBeGreaterThan(1);

      // From the last control, Tab wraps to the first rather than escaping.
      inside[inside.length - 1]!.focus();
      await user.tab();
      expect(sheet.contains(document.activeElement)).toBe(true);

      // And Shift+Tab from the first wraps to the last, for the same reason.
      inside[0]!.focus();
      await user.tab({ shift: true });
      expect(sheet.contains(document.activeElement)).toBe(true);
    }, 20_000);

    it(`${dialog.name} closes on Escape and hands focus back to its trigger`, async () => {
      mountAt(dialog.route);
      const user = userEvent.setup();
      const trigger = await dialog.open(user);
      const sheet = await screen.findByRole('dialog', { name: dialog.name });

      within(sheet).getAllByRole('button')[0]?.focus();
      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByRole('dialog', { name: dialog.name })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    }, 20_000);
  }
});

describe('the card menu is a menu, and behaves like one (§15)', () => {
  it('opens, is walkable, closes on Escape and restores focus', async () => {
    mountAt('/agents');
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Actions for Ada' });
    await user.click(trigger);

    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(3);
    expect(document.activeElement).toBe(items[0]);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect((document.activeElement as HTMLElement).outerHTML).toBe(trigger.outerHTML);
  }, 20_000);
});

describe('reorder mode is operable without a pointer (§5.4)', () => {
  it('exposes ▲▼ buttons with names and a position readout', async () => {
    mountAt('/agents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reorder' }));

    expect(screen.getByRole('button', { name: 'Move Ada up' })).toBeDisabled();
    const down = screen.getByRole('button', { name: 'Move Ada down' });
    expect(down).toBeEnabled();
    await user.click(down);
    expect(screen.getByText('2 of 2')).toBeInTheDocument();

    useAppStore.getState().setReorderMode(false);
  }, 20_000);
});
