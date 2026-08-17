/**
 * Avatar object URLs and the download helper (DESIGN §3.1).
 *
 * The acceptance criterion this exists for is negative and absolute: **no
 * `<img src="/api/…">` exists in the tree**, because that request cannot carry
 * the bearer and would 401 over the tailnet. The grep that proves the absence
 * lives in `web/test/noRemoteImages.test.ts`; what is proven here is that the
 * replacement works — and is memoised, bounded and revoked.
 */

import { describe, expect, it, vi } from 'vitest';

import { AvatarCache, downloadViaApi } from './avatars';
import { ApiClient } from './client';

function cacheWith(
  respond: (url: string) => Response,
  options: { limit?: number } = {},
): {
  cache: AvatarCache;
  urls: string[];
  revoked: string[];
} {
  const urls: string[] = [];
  const revoked: string[] = [];
  const client = new ApiClient({
    fetch: ((input: string) => {
      urls.push(input);
      return Promise.resolve(respond(input));
    }) as unknown as typeof globalThis.fetch,
    tokens: { get: () => 'phone', set: () => undefined },
  });
  const cache = new AvatarCache(client, {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    revoke: (url) => revoked.push(url),
  });
  return { cache, urls, revoked };
}

const png = (): Response =>
  new Response(new Blob(['not-really-a-png']), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });

describe('AvatarCache (§3.1, §16)', () => {
  it('fetches through the API client and hands back an object URL', async () => {
    const { cache, urls } = cacheWith(png);
    const url = await cache.load('priya');
    expect(url?.startsWith('blob:')).toBe(true);
    expect(urls).toEqual(['/api/roster/agents/priya/avatar']);
  });

  it('memoises per agent id — several cards mounting is one request', async () => {
    const { cache, urls } = cacheWith(png);
    const [a, b, c] = await Promise.all([
      cache.load('priya'),
      cache.load('priya'),
      cache.load('priya'),
    ]);
    expect(urls).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(cache.peek('priya')).toBe(a);

    // And a later mount does not re-fetch either.
    await cache.load('priya');
    expect(urls).toHaveLength(1);
  });

  it('percent-encodes an id rather than pasting it into the path', async () => {
    const { cache, urls } = cacheWith(png);
    await cache.load('a b/c');
    expect(urls[0]).toBe('/api/roster/agents/a%20b%2Fc/avatar');
  });

  it('revokes on invalidate, so a re-uploaded face is not stuck behind the memo', async () => {
    const { cache, urls, revoked } = cacheWith(png);
    const first = await cache.load('priya');
    cache.invalidate('priya');
    expect(revoked).toEqual([first]);
    expect(cache.peek('priya')).toBeUndefined();

    await cache.load('priya');
    expect(urls).toHaveLength(2);
  });

  it('is bounded, evicting and revoking the least recently added', async () => {
    const { cache, revoked } = cacheWith(png, { limit: 2 });
    const one = await cache.load('one');
    await cache.load('two');
    await cache.load('three');
    expect(revoked).toEqual([one]);
    expect(cache.peek('one')).toBeUndefined();
    expect(cache.peek('three')).toBeDefined();
  });

  it('clear() revokes everything it is holding', async () => {
    const { cache, revoked } = cacheWith(png);
    await cache.load('one');
    await cache.load('two');
    cache.clear();
    expect(revoked).toHaveLength(2);
  });

  it('a refused avatar is undefined, never an error the board has to handle', async () => {
    // Roster guarantees one of the three kinds is always present (§5.2), so the
    // card falls back to initials and the rest of the board keeps rendering.
    const { cache } = cacheWith(
      () =>
        new Response(JSON.stringify({ error: 'unauthorized', message: 'no' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(cache.load('priya')).resolves.toBeUndefined();
    expect(cache.peek('priya')).toBeUndefined();
  });
});

describe('downloadViaApi (§3.1)', () => {
  it('fetches to a blob and clicks a synthetic anchor, because a link cannot carry the bearer', async () => {
    const client = new ApiClient({
      fetch: (() =>
        Promise.resolve(
          new Response(new Blob(['log lines']), {
            status: 200,
            headers: { 'content-type': 'application/gzip' },
          }),
        )) as unknown as typeof globalThis.fetch,
      tokens: { get: () => 'phone', set: () => undefined },
    });
    // jsdom's `click()` on an anchor with a `blob:` href does nothing useful, so
    // it is intercepted to record what the download was *named* — which is the
    // part the caller controls.
    const clicks: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function recorded(this: HTMLAnchorElement): void {
        clicks.push(this.download);
      });

    await expect(downloadViaApi(client, '/logs/download', 'core.log.gz')).resolves.toBe(true);
    expect(clicks).toEqual(['core.log.gz']);
    // The anchor is removed again: the page is not left with a stray element.
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);

    click.mockRestore();
  });

  it('reports a refusal rather than downloading an error body', async () => {
    const client = new ApiClient({
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'route_denied_remotely', message: 'no' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
        )) as unknown as typeof globalThis.fetch,
      tokens: { get: () => null, set: () => undefined },
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    await expect(downloadViaApi(client, '/logs/download', 'core.log.gz')).resolves.toBe(false);
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });
});
