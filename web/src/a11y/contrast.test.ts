/**
 * The contrast gate (IMPLEMENTATION §11).
 *
 * > "Contrast meets AA on **every token pair in both themes**, asserted
 * > programmatically rather than by eye."
 *
 * Every pair is derived from the token names in `tokens.css` itself, so a
 * specialty or status colour added later is audited the moment it exists — the
 * criterion says *every* pair, and a hand-written list would only ever cover the
 * pairs someone remembered.
 *
 * The recorded ratios are checked too. §15 asks that "the token file carries the
 * measured ratios"; a comment that has drifted from its colour is worse than no
 * comment, because it is a claim, so the two must agree to one decimal place.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AA_LARGE, AA_TEXT, contrastRatio, pairsFor, readTheme, recordedRatio } from './contrast';

const css = readFileSync(resolve(process.cwd(), 'web', 'src', 'theme', 'tokens.css'), 'utf8');

/** The three blocks of §14.2, found by selector-with-brace rather than by prose. */
const THEMES = [
  { name: 'light', selector: ':root {', until: '@media (prefers-color-scheme: dark) {' },
  {
    name: 'dark (system)',
    selector: ":root:not([data-theme='light']) {",
    until: ':root[data-theme=',
  },
  {
    name: 'dark (chosen)',
    selector: ":root[data-theme='dark'] {",
    until: '@media (prefers-reduced-motion',
  },
] as const;

describe('every token pair meets AA, in both themes (§15)', () => {
  for (const theme of THEMES) {
    const { values, recorded } = readTheme(css, theme.selector, theme.until);

    it(`${theme.name}: has enough tokens to be a theme at all`, () => {
      // A block that silently matched nothing would pass every assertion below.
      expect(Object.keys(values).length).toBeGreaterThan(20);
      expect(values['surface']).toBeDefined();
      expect(values['surface-raised']).toBeDefined();
    });

    it(`${theme.name}: clears 4.5:1 for text and 3:1 for UI on every pair`, () => {
      const failures: string[] = [];
      for (const pair of pairsFor(values)) {
        const ratio = contrastRatio(values[pair.foreground]!, values[pair.background]!);
        if (ratio < pair.minimum) {
          failures.push(
            `--${pair.foreground} on --${pair.background}: ${ratio.toFixed(2)}:1 ` +
              `(needs ${String(pair.minimum)}:1)`,
          );
        }
      }
      expect(failures).toEqual([]);
    });

    it(`${theme.name}: records a measured ratio beside every audited token`, () => {
      const audited = new Set(pairsFor(values).map((pair) => pair.foreground));
      const missing = [...audited].filter((token) => recorded[token] === undefined);
      expect(missing).toEqual([]);
    });

    it(`${theme.name}: the recorded ratios agree with the measurement`, () => {
      const wrong: string[] = [];
      // The recorded number is the **worst** of the surfaces a token is painted
      // on, which is the honest one to record and the one the audit enforces.
      for (const pair of pairsFor(values)) {
        const claim = recorded[pair.foreground];
        if (claim === undefined) continue;
        const measured = pairsFor(values)
          .filter((one) => one.foreground === pair.foreground)
          .map((one) => contrastRatio(values[one.foreground]!, values[one.background]!));
        const worst = Math.min(...measured);
        if (claim !== recordedRatio(worst)) {
          wrong.push(`--${pair.foreground}: says ${claim}, measures ${recordedRatio(worst)}`);
        }
      }
      expect([...new Set(wrong)]).toEqual([]);
    });
  }

  it('the two dark blocks are the same palette, so the toggle changes nothing but who wins', () => {
    const system = readTheme(css, THEMES[1].selector, THEMES[1].until).values;
    const chosen = readTheme(css, THEMES[2].selector, THEMES[2].until).values;
    for (const [token, value] of Object.entries(system)) {
      expect(chosen[token], token).toBe(value);
    }
  });
});

describe('the measurement itself', () => {
  it('agrees with the two ratios everyone knows', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('is symmetric, because a ratio has no direction', () => {
    expect(contrastRatio('#1d1a16', '#faf8f5')).toBeCloseTo(
      contrastRatio('#faf8f5', '#1d1a16'),
      10,
    );
  });

  it('uses AA’s two thresholds and no third', () => {
    expect(AA_TEXT).toBe(4.5);
    expect(AA_LARGE).toBe(3);
  });
});
