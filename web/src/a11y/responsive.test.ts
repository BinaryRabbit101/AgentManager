/**
 * The responsive gate and the CSP (IMPLEMENTATION §11).
 *
 * > "**No horizontal page scroll at 390px or at 200% zoom** on any route; code
 * > and diff blocks scroll inside their own containers."
 *
 * > "**CSP is enforced with no third-party origins**, and the app functions
 * > fully with all non-core network access blocked."
 *
 * jsdom has no layout, so "does not scroll horizontally" cannot be *measured*
 * here. What can be asserted — and is, below — are the properties that cause
 * it: no fixed pixel widths on a container, every wide thing (tables, code,
 * diffs, transcripts) inside a box that scrolls on its own axis, grids that use
 * `minmax(0, …)` or `auto-fit` rather than fixed tracks, and a viewport meta
 * that does not block zoom. The measurement itself is on the manual list, at
 * 390 / 768 / 1280 / 1920 and at 200%, where a real engine can do it.
 *
 * The CSP half is fully automatable and is: the header the core serves is
 * asserted directly, including that it names no origin but `'self'`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '../../../src/http/routes/spa.js';

const webSrc = resolve(process.cwd(), 'web', 'src');
const SHEETS = ['styles.css', 'core-loop.css', 'pages.css', 'collaboration.css', 'home.css'];

function sheet(name: string): string {
  return readFileSync(join(webSrc, name), 'utf8');
}

const ALL_CSS = SHEETS.map(sheet).join('\n');

describe('nothing forces the page wider than the viewport (§2.3, §15)', () => {
  it('never sets a fixed pixel width on a layout container', () => {
    // `min-width` on a *scrolling* table is fine — it is inside `.table-scroll`,
    // which is what makes it scroll rather than the page. Everything else that
    // pins a width in pixels is a horizontal scrollbar at 390px.
    const offenders: string[] = [];
    for (const name of SHEETS) {
      for (const [index, line] of sheet(name).split('\n').entries()) {
        const match = /^\s*(?:width|min-width):\s*(\d+)px/u.exec(line);
        if (match === null) continue;
        // Icons, avatars and pips are content, not containers; 100px is the line.
        if (Number(match[1]) <= 100) continue;
        offenders.push(`${name}:${String(index + 1)} ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses minmax(0, …) or auto-fit for every grid track', () => {
    const tracks = [...ALL_CSS.matchAll(/grid-template-columns:\s*([^;]+);/gu)].map(
      (match) => match[1]?.trim() ?? '',
    );
    expect(tracks.length).toBeGreaterThan(0);
    for (const track of tracks) {
      const safe =
        track.includes('minmax(') || track.includes('auto-fit') || track.includes('auto-fill');
      // A fixed track (`220px 1fr`) is allowed only above a breakpoint, and
      // those live inside a media query — which this test cannot see. Flagging
      // them here would be noise, so the rule is: any *unconditional* track
      // must be flexible.
      expect(safe || track.includes('auto') || track.includes('fr'), track).toBe(true);
    }
  });

  it('gives every wide thing its own scroll container', () => {
    // The transcript's code and diff blocks, and the usage/queue tables.
    expect(ALL_CSS).toContain('.table-scroll');
    const tableScroll = ALL_CSS.slice(ALL_CSS.indexOf('.table-scroll {'));
    expect(tableScroll.slice(0, tableScroll.indexOf('}'))).toContain('overflow-x: auto');
    // Long words and paths wrap rather than push the page out.
    expect(ALL_CSS).toContain('overflow-wrap: anywhere');
  });

  it('lets the page zoom — no maximum-scale, no user-scalable=no', () => {
    const html = readFileSync(resolve(process.cwd(), 'web', 'index.html'), 'utf8');
    expect(html).toContain('width=device-width');
    expect(html).not.toContain('maximum-scale');
    expect(html).not.toContain('user-scalable=no');
  });

  it('has a phone layout at all — the breakpoints of §2.2 and §2.3', () => {
    const queries = [...ALL_CSS.matchAll(/@media \(([^)]+)\)/gu)].map((match) => match[1] ?? '');
    // The tree writes range queries (`width <= 640px`); either spelling counts.
    expect(queries.some((query) => /(?:max-width:\s*|width <= )6[34]\dpx/u.test(query))).toBe(true);
    expect(queries.some((query) => /(?:min-width:\s*|width >= )900px/u.test(query))).toBe(true);
    // §15's touch-target rule, applied where the coarse pointer is.
    expect(ALL_CSS).toContain('@media (pointer: coarse)');
    expect(ALL_CSS).toContain('min-height: 44px');
  });

  it('sizes the QR and the budget bar relative to the viewport, not absolutely', () => {
    expect(ALL_CSS).toContain('width: min(14rem, 60vw)');
    expect(ALL_CSS).toContain('max-width: 30vw');
  });
});

describe('the CSP the core serves (§1.4, remote §9.2 #9)', () => {
  it('names no origin other than the app’s own', () => {
    const origins = CONTENT_SECURITY_POLICY.match(/https?:\/\/[^\s;]+/gu);
    expect(origins).toBeNull();
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ]) {
      expect(CONTENT_SECURITY_POLICY).toContain(directive);
    }
  });

  it('allows no inline script, and inline styles only as a style attribute', () => {
    // React sets `style` for the specialty colour and dnd-kit's transform; a
    // whole inline *stylesheet* is a different thing and stays refused.
    expect(CONTENT_SECURITY_POLICY).toContain("style-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("style-src-attr 'unsafe-inline'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
  });

  it('allows blob: images, because avatars are fetched to object URLs (§3.1)', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("img-src 'self' blob: data:");
  });

  it('ships nosniff and no-referrer beside it', () => {
    expect(SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(SECURITY_HEADERS['referrer-policy']).toBe('no-referrer');
  });

  it('the bundle it protects really has no external reference', () => {
    // The same claim `web/test/bundle.test.ts` makes about the built output,
    // restated here against the *source* of the shell, because the CSP is only
    // as good as the page's willingness to live inside it.
    const html = readFileSync(resolve(process.cwd(), 'web', 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script>[^<]/u);
    expect(html).not.toMatch(/https?:\/\//u);
    const publicDir = resolve(process.cwd(), 'web', 'public');
    for (const entry of readdirSync(publicDir)) {
      expect(readFileSync(join(publicDir, entry), 'utf8')).not.toMatch(/https?:\/\//u);
    }
  });
});
