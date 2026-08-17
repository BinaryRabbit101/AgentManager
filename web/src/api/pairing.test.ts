/**
 * Pairing from the QR fragment (DESIGN §3.2).
 *
 * The criterion is about *when*, not only what: the fragment must be gone
 * before the first render, so it cannot be screenshotted from the address bar.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { claimTokenFromHash, type PairingWindow } from './pairing';

function fakeWindow(href: string): PairingWindow & { readonly replaced: string[] } {
  const url = new URL(href);
  const replaced: string[] = [];
  return {
    replaced,
    location: {
      hash: url.hash,
      pathname: url.pathname,
      search: url.search,
    } as Location,
    history: {
      replaceState: (_state: unknown, _title: string, next?: string | URL | null) => {
        replaced.push(String(next));
      },
    } as History,
  };
}

describe('claimTokenFromHash (§3.2)', () => {
  it('stores the token and strips the fragment in one step', () => {
    const stored: (string | null)[] = [];
    const windowRef = fakeWindow('http://box:7478/questions/abc?x=1#t=SECRET');

    expect(claimTokenFromHash({ setToken: (t) => stored.push(t) }, windowRef)).toBe('SECRET');
    expect(stored).toEqual(['SECRET']);
    // The path and query survive; the fragment does not.
    expect(windowRef.replaced).toEqual(['/questions/abc?x=1']);
  });

  it('does nothing when there is no fragment, which is every desktop load', () => {
    const stored: (string | null)[] = [];
    const windowRef = fakeWindow('http://127.0.0.1:7477/');
    expect(claimTokenFromHash({ setToken: (t) => stored.push(t) }, windowRef)).toBeNull();
    expect(stored).toEqual([]);
    expect(windowRef.replaced).toEqual([]);
  });

  it('ignores a fragment that carries no t=, and an empty one', () => {
    const stored: (string | null)[] = [];
    for (const href of ['http://box:7478/#section', 'http://box:7478/#t=']) {
      const windowRef = fakeWindow(href);
      expect(claimTokenFromHash({ setToken: (t) => stored.push(t) }, windowRef), href).toBeNull();
      expect(windowRef.replaced, href).toEqual([]);
    }
    expect(stored).toEqual([]);
  });

  it('is called before React mounts, in main.tsx', () => {
    // The ordering is the criterion, and it is a property of the entry point
    // rather than of this function, so it is asserted against the source.
    const main = readFileSync(resolve(process.cwd(), 'web', 'src', 'main.tsx'), 'utf8');
    expect(main.indexOf('claimTokenFromHash(client)')).toBeGreaterThan(-1);
    expect(main.indexOf('claimTokenFromHash(client)')).toBeLessThan(main.indexOf('createRoot('));
  });
});
