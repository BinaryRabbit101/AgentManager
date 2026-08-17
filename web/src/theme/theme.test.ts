/**
 * Theme choice, and the half of "no flash" that can be asserted in jsdom
 * (DESIGN §14.2, IMPLEMENTATION §1).
 *
 * The no-flash guarantee has two halves. The mechanism — a *blocking* script in
 * `<head>` that stamps `data-theme` before the first paint — is browser-only and
 * is on the manual-check list (`scripts/ui-manual-checks.mjs`). The **contract**
 * between that script and this module is not: they must agree on the storage
 * key and on the accepted values, or the attribute the boot script writes and
 * the attribute the toggle writes are two different attributes and every reload
 * flashes. That agreement is asserted here, against the real file.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyTheme,
  isThemeChoice,
  readStoredTheme,
  THEME_CHOICES,
  THEME_STORAGE_KEY,
} from './theme';

/**
 * Source read from the repository root rather than from `import.meta.url`:
 * under the jsdom environment Vite rewrites module URLs to an http origin, and
 * these assertions are about files on disk.
 */
const fromRoot = (...segments: string[]): string =>
  readFileSync(resolve(process.cwd(), ...segments), 'utf8');

const bootScript = fromRoot('web', 'public', 'theme-boot.js');

describe('the no-flash contract with public/theme-boot.js (§14.2)', () => {
  it('is loaded synchronously in <head>, before the deferred bundle', () => {
    const html = fromRoot('web', 'index.html');
    const boot = html.indexOf('theme-boot.js');
    const bundle = html.indexOf('main.tsx');
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(bundle);
    // Not `defer`/`async`: either would run after the first paint, which is the
    // flash §14.2 forbids.
    expect(/<script src="\/theme-boot\.js"><\/script>/u.test(html)).toBe(true);
  });

  it('agrees with this module about the storage key', () => {
    expect(bootScript).toContain(THEME_STORAGE_KEY);
  });

  it('stamps the same attribute, for the same two explicit values', () => {
    expect(bootScript).toContain("setAttribute('data-theme'");
    expect(bootScript).toContain("stored === 'light'");
    expect(bootScript).toContain("stored === 'dark'");
    // And removes it for anything else, which is how `system` is expressed.
    expect(bootScript).toContain("removeAttribute('data-theme')");
  });
});

describe('the toggle (§14.2)', () => {
  it('offers exactly three choices and defaults to system', () => {
    expect(THEME_CHOICES).toEqual(['system', 'light', 'dark']);
    expect(readStoredTheme()).toBe('system');
  });

  it('writes data-theme for an explicit choice and removes it for system', () => {
    const root = document.documentElement;

    applyTheme('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    applyTheme('light');
    expect(root.getAttribute('data-theme')).toBe('light');

    // `system` means "let prefers-color-scheme decide", and the stylesheet says
    // so with a media query — so there is no attribute at all.
    applyTheme('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('reads a stored choice back, and treats a hand-edited value as system', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(readStoredTheme()).toBe('dark');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'solarized');
    expect(readStoredTheme()).toBe('system');
    expect(isThemeChoice('solarized')).toBe(false);
  });

  it('still applies the theme when storage refuses', () => {
    const root = document.createElement('html');
    expect(() =>
      applyTheme('dark', root, {
        setItem: () => {
          throw new Error('storage is disabled');
        },
      }),
    ).not.toThrow();
    expect(root.getAttribute('data-theme')).toBe('dark');
  });
});

describe('the token file (§14.2)', () => {
  const tokens = fromRoot('web', 'src', 'theme', 'tokens.css');

  it('declares the complete light palette on bare :root', () => {
    // The `{` matters: the header comment names both selectors in prose, and a
    // slice bounded by the comment would be empty and pass for nothing.
    const light = tokens.slice(
      tokens.indexOf(':root {'),
      tokens.indexOf('@media (prefers-color-scheme: dark) {'),
    );
    expect(light.length).toBeGreaterThan(200);
    for (const token of [
      '--surface',
      '--surface-raised',
      '--text',
      '--text-muted',
      '--accent',
      '--border',
      '--danger',
      '--warn',
      '--ok',
    ]) {
      expect(light, token).toContain(`${token}:`);
    }
  });

  it('carries a status token for each of orchestrator’s six words', () => {
    for (const state of ['idle', 'queued', 'working', 'awaiting_user', 'paused', 'halted']) {
      expect(tokens, state).toContain(`--status-${state}:`);
    }
  });

  it('carries a specialty token for each of roster’s closed enum', () => {
    for (const specialty of [
      'bug-patching',
      'feature-implementation',
      'code-review',
      'testing',
      'documentation',
      'research',
      'email-response',
      'overseer',
      'general',
    ]) {
      expect(tokens, specialty).toContain(`--specialty-${specialty}:`);
    }
  });

  it('lets an explicit light choice win on a dark system, and the reverse', () => {
    // The media block is guarded, and the attribute block comes after it.
    expect(tokens).toContain('@media (prefers-color-scheme: dark) {');
    expect(tokens).toContain(":root:not([data-theme='light']) {");
    expect(tokens.indexOf(":root[data-theme='dark'] {")).toBeGreaterThan(
      tokens.indexOf('@media (prefers-color-scheme: dark) {'),
    );
  });

  it('disables every transition and both loops under prefers-reduced-motion', () => {
    const reduced = tokens.slice(tokens.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('--duration: 0ms');
    expect(reduced).toContain('animation-iteration-count: 1 !important');
    expect(reduced).toContain('transition-duration: 0.01ms !important');
  });

  it('references no webfont and no external origin (§1.4)', () => {
    expect(tokens).not.toContain('@import url(');
    expect(tokens).not.toMatch(/https?:\/\//u);
  });
});
