/**
 * The two negative acceptance criteria, asserted over the source tree.
 *
 * IMPLEMENTATION §2: "no `<img src="/api/…">` exists in the tree (asserted by
 * grep)". IMPLEMENTATION §1 and DESIGN §1.4: no external CDN, webfont, icon
 * font or remote image — "the tailnet browser may have no internet route at
 * all", so a stray absolute URL is a screen that is blank on a phone.
 *
 * The built-bundle half of the §1 criterion is `web/e2e/bundle.test.ts`, which
 * scans the emitted output. This file catches it at the source, where the fix
 * is obvious.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * From the repository root rather than from `import.meta.url`: under the jsdom
 * environment Vite rewrites module URLs to an http origin and `fileURLToPath`
 * refuses those. Vitest runs from the root, which is where `web/` lives.
 */
const webRoot = resolve(process.cwd(), 'web');

/**
 * Everything that reaches the bundle: `src/`, `public/` and the shell.
 *
 * Test files are excluded deliberately and not by accident — they are never
 * built, and this very file necessarily contains the strings it is looking for.
 */
function sourceFiles(): { path: string; text: string }[] {
  const collected: { path: string; text: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(?:tsx?|css|html|js)$/u.test(entry.name)) continue;
      if (/\.test\.tsx?$/u.test(entry.name)) continue;
      collected.push({
        path: relative(webRoot, path).replaceAll('\\', '/'),
        text: readFileSync(path, 'utf8'),
      });
    }
  };
  walk(join(webRoot, 'src'));
  walk(join(webRoot, 'public'));
  collected.push({ path: 'index.html', text: readFileSync(join(webRoot, 'index.html'), 'utf8') });
  return collected;
}

/**
 * The file with comment lines removed.
 *
 * Prose is not a request. Both criteria below are about what the browser will
 * *do*, and several of these files explain at length why they do not do it —
 * `avatars.ts` quotes the forbidden `<img src="/api/…">` in the doc comment that
 * exists to prevent it. Scanning the comments would make the fix "stop
 * documenting the rule".
 */
function codeOf(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*\/|\*|#)/u.test(line))
    .filter((line) => !/^\s*<!--/u.test(line) && !/^\s*-->/u.test(line))
    .join('\n');
}

const files = sourceFiles().map((file) => ({ ...file, code: codeOf(file.text) }));

describe('no <img src="/api/…"> anywhere in the tree (§3.1, IMPLEMENTATION §2)', () => {
  it('found source to scan at all', () => {
    // A scan that silently matched nothing would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.path.endsWith('Avatar.tsx'))).toBe(true);
  });

  it('never points a browser-fetched attribute at an /api path', () => {
    // `<img src="/api/roster/agents/:id/avatar">` cannot set `Authorization`,
    // so over the tailnet it would 401. Avatars go through the object-URL
    // helper of §3.1 instead, and there is no second way in.
    //
    // The attributes checked are the ones the *browser* fetches on its own —
    // `src`, `srcSet`, `poster`, and `<link href>`. A plain `<a href="/api/…">`
    // is a navigation the user chose, carries no credential expectation, and is
    // how the no-bundle fallback page offers `/api/health`.
    const offenders = files.filter(
      (file) =>
        /(?:\bsrc|\bsrcSet|\bposter)\s*=\s*[{"'`]?\s*[{"'`]?\s*\/api\//u.test(file.code) ||
        /<link\b[^>]*href\s*=\s*["'`]\/api\//u.test(file.code),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('has exactly one <img> in the whole tree, and its src is a blob URL', () => {
    const withImages = files.filter(
      (file) => file.path.endsWith('.tsx') && /<img\b/u.test(file.code),
    );
    expect(withImages.map((file) => file.path)).toEqual(['src/board/Avatar.tsx']);
    expect(withImages[0]?.code).toContain('<img src={objectUrl}');
  });
});

describe('no external network references (§1.4, IMPLEMENTATION §1)', () => {
  it('never names an http(s) origin in code', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const line of file.code.split('\n')) {
        const match = /https?:\/\/[^\s'"`)]+/u.exec(line);
        if (match === null) continue;
        // The XML namespace is not a fetch: no browser ever requests it.
        if (match[0].startsWith('http://www.w3.org/')) continue;
        offenders.push(`${file.path}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('loads no webfont and no icon font', () => {
    // "No webfonts. A system font stack. Zero font bytes." (§1.4)
    for (const file of files) {
      expect(file.code, file.path).not.toContain('@font-face');
      expect(file.code, file.path).not.toContain('fonts.googleapis');
      expect(file.code, file.path).not.toContain('cdn.jsdelivr');
      expect(file.code, file.path).not.toContain('unpkg.com');
    }
  });

  it('has no <link rel="preconnect"|"dns-prefetch"> in the shell', () => {
    const html = files.find((file) => file.path === 'index.html');
    expect(html).toBeDefined();
    expect(html?.code).not.toMatch(/rel="(?:preconnect|dns-prefetch|prefetch)"/u);
  });
});
