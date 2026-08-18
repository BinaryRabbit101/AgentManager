/**
 * The automated accessibility audit (IMPLEMENTATION §11).
 *
 * > "Automated axe (or equivalent) passes with **zero serious/critical
 * > violations** on **all ten routes** in **both themes**."
 *
 * axe-core runs against the real DOM the app renders, in jsdom. What it can see
 * there is a large and genuinely useful subset: roles, names, labels, landmark
 * structure, heading order, duplicate ids, `aria-*` validity, list semantics.
 * What it cannot see is anything needing layout or paint — colour contrast
 * chief among them, because jsdom computes no colours. That half is not skipped:
 * `contrast.test.ts` measures **every token pair in both themes** against the
 * stylesheet, which is a stronger check than axe's sampling of what happens to
 * be on screen. Both run in CI, and between them they cover the criterion.
 *
 * The two themes are exercised by stamping `data-theme` on the root exactly as
 * `theme.ts` does, so a rule that depends on the attribute — and any future
 * markup that changes with it — is audited in both states.
 */

import axe from 'axe-core';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { mountAt, ROUTES } from '../../test/routes';

/** §11's bar: nothing serious, nothing critical. */
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

/**
 * Rules jsdom cannot answer, disabled with the reason.
 *
 * `color-contrast` needs a rendering engine; it is covered far more thoroughly
 * by `contrast.test.ts`. Everything else axe ships stays on.
 */
const DISABLED_RULES = { 'color-contrast': { enabled: false } };

async function violationsOn(theme: 'light' | 'dark'): Promise<string[]> {
  document.documentElement.setAttribute('data-theme', theme);
  const results = await axe.run(document.body, {
    rules: DISABLED_RULES,
    resultTypes: ['violations'],
  });
  return results.violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? '?'}) — ${violation.help}: ` +
        violation.nodes.map((node) => node.target.join(' ')).join(', '),
    );
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

describe('axe finds no serious or critical violation on any route, in either theme', () => {
  for (const route of ROUTES) {
    it(`${route.path} is clean in light and in dark`, async () => {
      mountAt(route.path);
      // Audit the screen the user sees, not the loading state before it.
      await waitFor(() => expect(screen.getAllByText(route.settled).length).toBeGreaterThan(0), {
        timeout: 4000,
      });

      expect(await violationsOn('light')).toEqual([]);
      expect(await violationsOn('dark')).toEqual([]);
    }, 30_000);
  }
});

describe('the audit is really running', () => {
  it('reports a violation when one is deliberately introduced', async () => {
    // A test that only ever passes is indistinguishable from one that is not
    // running at all. This proves the harness sees what it claims to see.
    mountAt('/agents');
    await waitFor(() => expect(screen.getAllByText('Ada').length).toBeGreaterThan(0));

    const broken = document.createElement('button');
    // A button with no accessible name — "serious" in every axe ruleset.
    document.body.append(broken);
    const found = await violationsOn('light');
    broken.remove();

    expect(found.join(' ')).toContain('button-name');
    expect(await violationsOn('light')).toEqual([]);
  }, 30_000);
});
