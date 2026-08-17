/**
 * The built bundle is self-contained (IMPLEMENTATION §1's first acceptance).
 *
 * > "`npm run build` produces a single self-contained bundle with **zero
 * > external network references** — asserted by scanning the built output for
 * > `http://` / `https://` origins other than same-origin, and by loading the
 * > app with the network blocked to everything but the core."
 *
 * The first half is here. The second half needs a browser with its network
 * blocked and is on the manual-check list (`scripts/ui-manual-checks.mjs`);
 * `web/test/sourceScan.test.ts` catches the same class of mistake at the source,
 * where the fix is obvious, and this file catches what a *dependency* drags in —
 * a bundled library with a CDN fallback would pass the source scan and fail
 * here, which is exactly why both exist.
 *
 * `npm run ci` runs `build:web` before `test`, so the output is normally already
 * there; when it is not, this builds it rather than skipping, because a skipped
 * assertion is indistinguishable from a passing one in a CI log.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const outDir = resolve(repoRoot, 'app', 'web');

interface Asset {
  readonly path: string;
  readonly text: string;
  readonly bytes: number;
}

let assets: Asset[] = [];

function collect(): Asset[] {
  const found: Asset[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const raw = readFileSync(path);
      found.push({
        path: relative(outDir, path).replaceAll('\\', '/'),
        text: /\.(?:html|js|mjs|css|json|svg|txt|webmanifest)$/u.test(entry.name)
          ? raw.toString('utf8')
          : '',
        bytes: raw.byteLength,
      });
    }
  };
  walk(outDir);
  return found;
}

beforeAll(async () => {
  if (!existsSync(join(outDir, 'index.html'))) {
    const { build } = await import('vite');
    await build({ configFile: resolve(repoRoot, 'vite.config.ts'), logLevel: 'warn' });
  }
  assets = collect();
}, 180_000);

describe('the emitted bundle', () => {
  it('exists, and is a shell plus content-hashed assets', () => {
    expect(assets.map((asset) => asset.path)).toContain('index.html');
    expect(assets.some((asset) => /^assets\/.+\.js$/u.test(asset.path))).toBe(true);
    expect(assets.some((asset) => /^assets\/.+\.css$/u.test(asset.path))).toBe(true);
    // The no-flash boot script has to be a real same-origin file, not inlined.
    expect(assets.map((asset) => asset.path)).toContain('theme-boot.js');
  });

  /**
   * The two kinds of absolute URL a bundle may legitimately contain, and why
   * neither is a network reference:
   *
   * - **XML namespaces** (`http://www.w3.org/…`) are identifiers. No browser has
   *   ever fetched one; they are how SVG and MathML elements are named.
   * - **React's error-decoder link**. `react-dom`'s production build replaces
   *   each invariant message with a code and a documentation URL, printed into
   *   an `Error` the developer reads. Nothing fetches it, and removing it would
   *   mean patching React.
   *
   * Anything else is a finding. The list is asserted to stay this short, so a
   * dependency that quietly adds a third has to be looked at rather than
   * absorbed.
   */
  const ALLOWED_ABSOLUTE = [
    'http://www.w3.org/',
    'https://reactjs.org/docs/error-decoder.html',
  ] as const;

  it('references no origin other than the one it was served from', () => {
    const offenders: string[] = [];
    for (const asset of assets) {
      for (const match of asset.text.matchAll(/https?:\/\/[^\s'"`)\\]+/gu)) {
        const url = match[0];
        if (ALLOWED_ABSOLUTE.some((allowed) => url.startsWith(allowed))) continue;
        offenders.push(`${asset.path}: ${url}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(ALLOWED_ABSOLUTE).toHaveLength(2);
  });

  it('never puts an absolute URL where a browser would fetch it', () => {
    // The criterion behind the criterion: a URL in an error string cannot cost
    // the tailnet browser a request, and a URL in a `src`, a `fetch` or a socket
    // constructor can.
    for (const asset of assets) {
      expect(asset.text, asset.path).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)="https?:/u);
      expect(asset.text, asset.path).not.toMatch(/fetch\(\s*["'`]https?:/u);
      expect(asset.text, asset.path).not.toMatch(
        /new\s+(?:WebSocket|EventSource)\(\s*["'`]https?:/u,
      );
      expect(asset.text, asset.path).not.toContain('importScripts("http');
    }
  });

  it('names no CDN, no webfont host and no analytics endpoint', () => {
    for (const asset of assets) {
      for (const host of [
        'cdn.jsdelivr.net',
        'unpkg.com',
        'cdnjs.cloudflare.com',
        'fonts.googleapis.com',
        'fonts.gstatic.com',
        'google-analytics.com',
        'googletagmanager.com',
      ]) {
        expect(asset.text, `${asset.path} → ${host}`).not.toContain(host);
      }
    }
  });

  it('embeds no @font-face and ships no font file', () => {
    // §1.4: "Zero font bytes, and emoji avatars render natively on every target."
    for (const asset of assets) {
      expect(asset.text, asset.path).not.toContain('@font-face');
      expect(asset.path, asset.path).not.toMatch(/\.(?:woff2?|ttf|otf|eot)$/u);
    }
  });

  it('loads every asset it names from a relative, same-origin path', () => {
    const html = assets.find((asset) => asset.path === 'index.html');
    expect(html).toBeDefined();
    const references = [...(html?.text.matchAll(/(?:src|href)="([^"]+)"/gu) ?? [])].map(
      (match) => match[1] ?? '',
    );
    expect(references.length).toBeGreaterThan(1);
    for (const reference of references) {
      expect(reference, reference).toMatch(/^\/(?!\/)/u);
    }
  });

  it('emits no source-map sidecar to fetch', () => {
    // A `.map` the browser goes looking for is a request the tailnet may not be
    // able to answer, and it ships the whole source tree with it.
    expect(assets.filter((asset) => asset.path.endsWith('.map'))).toEqual([]);
    for (const asset of assets) {
      expect(asset.text, asset.path).not.toContain('sourceMappingURL');
    }
  });

  it('fits the initial-route budget of under 500 KB gzipped (§16)', async () => {
    const { gzipSync } = await import('node:zlib');
    const initial = assets.filter(
      (asset) => asset.path === 'index.html' || /^assets\//u.test(asset.path),
    );
    const gzipped = initial.reduce(
      (total, asset) =>
        total + gzipSync(readFileSync(join(outDir, asset.path.replaceAll('/', '\\')))).byteLength,
      0,
    );
    expect(gzipped).toBeLessThan(500 * 1024);
  });
});
