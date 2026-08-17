/**
 * Rate limiting and lockout — remote IMPLEMENTATION **M5**, criterion by
 * criterion.
 *
 * | M5 acceptance criterion | Test |
 * |---|---|
 * | 10 failures in 5 min from one peer produce a 429 with `Retry-After`; a different peer is unaffected | *ten failures from one peer …*, *a different peer is unaffected …* |
 * | The block lifts exactly after `blockMs`, verified with the injected clock, not a real sleep | *the block lifts exactly after blockMs …* |
 * | 100 failures emit **one** `remote.auth.failed` event and one `warn` block line | *one event and one block line for a hundred failures …* |
 * | A valid token is never revoked by any number of failures against its prefix | *no number of failures against a prefix revokes the token …* |
 * | 61 `fs/browse` calls in a minute from one token yield a 429 on the last; other routes unaffected | *the sixty-first fs/browse call …*, *other routes are unaffected …* |
 *
 * **Not one of these tests sleeps.** Every deadline is moved by assigning
 * `harness.now`, which is the whole reason `ctx.clock` is injectable (§10.4: "All
 * comparisons in UTC ISO through `ctx.clock`, so tests are deterministic").
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  BLOCK_MS,
  FAIL_WINDOW_MS,
  MAX_FAILURES,
  createRemoteHarness,
  type RemoteHarness,
} from './__tests__/harness.js';
import { AUTH_BLOCKED_CODE, RATE_LIMITED_CODE } from './middleware.js';
import { createAuthLimiter, createRouteBucket } from './rateLimit.js';
import { UNAUTHORIZED_CODE, generateTokenValue } from './tokens.js';

let harness: RemoteHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** One failed sign-in from the loopback peer the harness binds. */
async function fail(
  instance: RemoteHarness,
): Promise<{ status: number; retryAfter: string | null }> {
  const answer = await instance.call('/api/health', { token: generateTokenValue() });
  return { status: answer.status, retryAfter: answer.headers.get('retry-after') };
}

// ---------------------------------------------------------------------------
// The per-peer sliding window (§4.6)
// ---------------------------------------------------------------------------

describe('M5 — ten failures from one peer produce a 429 with Retry-After (§4.6)', () => {
  it('answers 401 for the first nine and 429 with Retry-After from the tenth on', async () => {
    harness = await createRemoteHarness();

    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let attempt = 1; attempt <= MAX_FAILURES + 2; attempt += 1) {
      const outcome = await fail(harness);
      statuses.push(outcome.status);
      if (outcome.retryAfter !== null) retryAfter ??= outcome.retryAfter;
      // A second between attempts, so all ten sit inside the five-minute window.
      harness.now += 1_000;
    }

    // Nine 401s, then the tenth failure is itself answered with the lockout: the
    // budget is exactly `maxFailures`, not one more than it.
    expect(statuses.slice(0, MAX_FAILURES - 1)).toEqual(Array(MAX_FAILURES - 1).fill(401));
    expect(statuses.slice(MAX_FAILURES - 1)).toEqual([429, 429, 429]);
    expect(retryAfter).toBe(String(BLOCK_MS / 1000));

    const blocked = await harness.call('/api/health', { token: generateTokenValue() });
    expect((blocked.json as { error: string }).error).toBe(AUTH_BLOCKED_CODE);
  });

  it('blocks a valid token from a blocked peer too — the lockout is on the peer, not the credential', async () => {
    harness = await createRemoteHarness();
    const { token } = harness.mint();
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) await fail(harness);

    const answer = await harness.call('/api/health', { token });
    expect(answer.status).toBe(429);
  });

  it('lets the window expire: nine failures spread past failWindowMs never reach the limit', async () => {
    harness = await createRemoteHarness();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const outcome = await fail(harness);
      expect(outcome.status).toBe(401);
      // Each failure lands after the previous one has aged out of the window, so
      // the sliding window never holds more than one.
      harness.now += FAIL_WINDOW_MS + 1;
    }
  });

  it('never counts a request that presented no credential at all', async () => {
    harness = await createRemoteHarness();

    // A browser that has not paired yet hits `/api/**` without a token. Counting
    // those would lock the device out of its own pairing screen, and the
    // brute-force this counter makes visible necessarily *presents* something.
    for (let attempt = 0; attempt < MAX_FAILURES * 3; attempt += 1) {
      const answer = await harness.call('/api/health');
      expect(answer.status).toBe(401);
    }
    expect(harness.audit.failures).toHaveLength(0);
    expect(harness.audit.blocks).toHaveLength(0);

    const { token } = harness.mint();
    expect((await harness.call('/api/health', { token })).status).toBe(200);
  });

  it('counts a malformed Authorization header, so the lockout is not avoidable by sending Basic', async () => {
    harness = await createRemoteHarness();

    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      await harness.call('/api/health', { headers: { authorization: 'Basic aGk6dGhlcmU=' } });
      harness.now += 1_000;
    }
    expect(harness.audit.blocks).toHaveLength(1);
  });
});

describe('M5 — a different peer is unaffected (§4.6)', () => {
  it('locks out one peer and leaves another serving', () => {
    // Two peers over one loopback socket: the limiter is keyed by the address the
    // peer guard normalised, so the test drives it directly for the second peer
    // while the socket exercises the first.
    const limiter = createAuthLimiter({
      maxFailures: MAX_FAILURES,
      failWindowMs: FAIL_WINDOW_MS,
      blockMs: BLOCK_MS,
    });
    const at = Date.parse('2026-08-17T12:00:00.000Z');

    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      limiter.recordFailure('100.64.0.7', at + attempt * 1_000);
    }

    // The block starts from the failure that closed the window — the tenth, nine
    // seconds in — not from the first.
    expect(limiter.blockedUntil('100.64.0.7', at)).toBe(at + (MAX_FAILURES - 1) * 1_000 + BLOCK_MS);
    // The other device on the tailnet never typed anything wrong and must not pay
    // for its neighbour.
    expect(limiter.blockedUntil('100.64.0.9', at)).toBeUndefined();
    expect(limiter.recordFailure('100.64.0.9', at).blocked).toBe(false);
  });
});

describe('M5 — the block lifts exactly after blockMs (§4.6)', () => {
  it('is still blocked one millisecond before the deadline and serving one millisecond after', async () => {
    harness = await createRemoteHarness();
    const { token } = harness.mint();
    const start = harness.now;

    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) await fail(harness);
    expect((await harness.call('/api/health', { token })).status).toBe(429);

    harness.now = start + BLOCK_MS - 1;
    expect((await harness.call('/api/health', { token })).status).toBe(429);

    // Not a sleep, an assignment. The whole point of the injected clock.
    harness.now = start + BLOCK_MS;
    expect((await harness.call('/api/health', { token })).status).toBe(200);
  });

  it('gives a lifted peer its full budget again rather than re-blocking on the next mistake', async () => {
    harness = await createRemoteHarness();
    const start = harness.now;
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) await fail(harness);

    harness.now = start + BLOCK_MS;
    // A device that mistypes once after its lockout expired is not instantly
    // locked out again — otherwise one bad pairing costs the rest of the day.
    expect((await fail(harness)).status).toBe(401);
  });

  it('counts down Retry-After as the block ages', async () => {
    harness = await createRemoteHarness();
    const start = harness.now;
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) await fail(harness);

    harness.now = start + BLOCK_MS / 2;
    const midway = await harness.call('/api/health', { token: generateTokenValue() });
    expect(midway.headers.get('retry-after')).toBe(String(BLOCK_MS / 2000));
  });
});

// ---------------------------------------------------------------------------
// One event and one warn line per window (§4.6)
// ---------------------------------------------------------------------------

describe('M5 — one event and one block line for a hundred failures (§4.6)', () => {
  it('emits one auth-failed record and one block record, not a hundred of each', async () => {
    harness = await createRemoteHarness();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      await fail(harness);
      harness.now += 1_000;
    }

    // §4.6: "Repeat failures inside a window do not each emit an event — that is
    // how a brute-force attempt becomes a self-inflicted log flood."
    expect(harness.audit.failures).toHaveLength(1);
    expect(harness.audit.blocks).toHaveLength(1);
    expect(harness.audit.failures[0]?.failures).toBe(1);
    expect(harness.audit.blocks[0]?.failures).toBe(MAX_FAILURES);
    expect(harness.audit.blocks[0]?.retryAfterSeconds).toBe(BLOCK_MS / 1000);
    // The refusals are the 429s that followed, which are the response and not a
    // second sign-in attempt.
    expect(harness.audit.refusals.every((entry) => entry.code === AUTH_BLOCKED_CODE)).toBe(true);
  });

  it('opens a fresh window — and so a fresh event — once the previous one has aged out', async () => {
    harness = await createRemoteHarness();
    await fail(harness);
    expect(harness.audit.failures).toHaveLength(1);

    await fail(harness);
    expect(harness.audit.failures).toHaveLength(1);

    harness.now += FAIL_WINDOW_MS + 1;
    await fail(harness);
    expect(harness.audit.failures).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// No auto-revocation (§4.6's DoS-resistance decision)
// ---------------------------------------------------------------------------

describe('M5 — no number of failures against a prefix revokes the token (§4.6)', () => {
  it('leaves a valid token live and usable after 200 failures aimed at its own prefix', async () => {
    harness = await createRemoteHarness();
    const { id, token } = harness.mint('Pixel 9');
    const prefix = token.slice(0, 6);

    // §4.6: "the 6-character prefix is visible in the UI and in logs, so anyone
    // who could brute-force could instead cheaply *revoke* every device by failing
    // against known prefixes." So: two hundred failures that all carry the real
    // prefix, from many peers, spread across many windows.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const guess = `${prefix}${generateTokenValue().slice(6)}`;
      await harness.call('/api/health', { token: guess });
      // Past the block each time, so every attempt is actually counted rather
      // than short-circuited by a lockout.
      harness.now += BLOCK_MS + 1;
    }

    const row = harness.tokensRepository.get(id);
    expect(row?.revokedAt).toBeNull();
    expect(row?.expiresAt).not.toBeNull();

    // And it still works — availability lost nothing, which is the point.
    const answer = await harness.call('/api/health', { token });
    expect(answer.status).toBe(200);
  });

  it('has no code path from the limiter to the token store', () => {
    // Structural half of the same decision: the limiter is given no repository, so
    // "auto-revoke after N failures" is not a feature someone can switch on by
    // accident.
    const limiter = createAuthLimiter({ maxFailures: 1, failWindowMs: 1, blockMs: 1 });
    expect(Object.keys(limiter).sort()).toEqual(['blockedUntil', 'recordFailure', 'size', 'sweep']);
  });
});

// ---------------------------------------------------------------------------
// The per-token fs/browse bucket (§3.3)
// ---------------------------------------------------------------------------

describe('M5 — the sixty-first fs/browse call in a minute is refused (§3.3)', () => {
  it('serves sixty and answers 429 with Retry-After on the sixty-first', async () => {
    harness = await createRemoteHarness({ browseLimit: 60 });
    const { token } = harness.mint();

    for (let call = 1; call <= 60; call += 1) {
      const answer = await harness.call('/api/fs/browse?path=C%3A%5CUsers', { token });
      expect(answer.status, `call ${String(call)}`).toBe(200);
    }

    const refused = await harness.call('/api/fs/browse?path=C%3A%5CUsers', { token });
    expect(refused.status).toBe(429);
    expect((refused.json as { error: string }).error).toBe(RATE_LIMITED_CODE);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);

    // A minute later the window has slid and the bucket refills.
    harness.now += 60_001;
    expect((await harness.call('/api/fs/browse', { token })).status).toBe(200);
  });

  it('leaves other routes unaffected once the browse bucket is full', async () => {
    harness = await createRemoteHarness({ browseLimit: 2 });
    const { token } = harness.mint();

    await harness.call('/api/fs/browse', { token });
    await harness.call('/api/fs/browse', { token });
    expect((await harness.call('/api/fs/browse', { token })).status).toBe(429);

    // The bucket is a property of one route, not of the token's whole session —
    // and §6.2's Restrain tier must never be throttled into uselessness.
    expect((await harness.call('/api/health', { token })).status).toBe(200);
  });

  it('is per token: one device exhausting the bucket does not throttle another', async () => {
    harness = await createRemoteHarness({ browseLimit: 1 });
    const first = harness.mint('first');
    const second = harness.mint('second');

    expect((await harness.call('/api/fs/browse', { token: first.token })).status).toBe(200);
    expect((await harness.call('/api/fs/browse', { token: first.token })).status).toBe(429);
    expect((await harness.call('/api/fs/browse', { token: second.token })).status).toBe(200);
  });

  it('logs every browse with its resolved path (§3.3’s audit-is-the-control)', async () => {
    harness = await createRemoteHarness({
      resolvePath: (path) => `${path}\\resolved`,
    });
    const { id, token } = harness.mint();
    await harness.call('/api/fs/browse?path=C%3A%5CUsers%5Cme%5Cjunction', { token });

    expect(harness.audit.browses).toHaveLength(1);
    expect(harness.audit.browses[0]).toMatchObject({
      tokenId: id,
      requested: 'C:\\Users\\me\\junction',
      // §3.3 asks for the **resolved** path, because a Windows junction is a real
      // containment escape and the requested string does not show where it went.
      resolved: 'C:\\Users\\me\\junction\\resolved',
    });
  });

  it('logs the requested path when resolution fails, rather than failing the request', async () => {
    harness = await createRemoteHarness({
      resolvePath: () => {
        throw new Error('ENOENT');
      },
    });
    const { token } = harness.mint();
    const answer = await harness.call('/api/fs/browse?path=C%3A%5Cgone', { token });

    // An audit line must never be the reason a request fails.
    expect(answer.status).toBe(200);
    expect(harness.audit.browses[0]?.resolved).toBe('C:\\gone');
  });
});

// ---------------------------------------------------------------------------
// Housekeeping: the in-memory maps do not grow without bound
// ---------------------------------------------------------------------------

describe('M5 — the in-memory state is swept', () => {
  it('drops a peer once its window has aged out and its block has lifted', () => {
    const limiter = createAuthLimiter({ maxFailures: 3, failWindowMs: 1_000, blockMs: 2_000 });
    const at = 1_000_000;
    for (let peer = 0; peer < 50; peer += 1) limiter.recordFailure(`100.64.0.${String(peer)}`, at);
    expect(limiter.size()).toBe(50);

    limiter.sweep(at + 500);
    expect(limiter.size()).toBe(50);

    limiter.sweep(at + 5_000);
    expect(limiter.size()).toBe(0);
  });

  it('drops a bucket key once its window is empty', () => {
    const bucket = createRouteBucket({ limit: 2, windowMs: 1_000 });
    expect(bucket.take('token-a', 0)).toBe(true);
    expect(bucket.take('token-a', 0)).toBe(true);
    expect(bucket.take('token-a', 0)).toBe(false);
    expect(bucket.retryAfterSeconds('token-a', 0)).toBe(1);

    bucket.sweep(2_000);
    expect(bucket.size()).toBe(0);
    expect(bucket.take('token-a', 2_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The uniform 401 survives the lockout machinery
// ---------------------------------------------------------------------------

describe('M5 — the lockout does not become a token oracle', () => {
  it('answers a good token and a bad one identically once the peer is blocked', async () => {
    harness = await createRemoteHarness();
    const { token } = harness.mint();
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) await fail(harness);

    const good = await harness.call('/api/health', { token });
    const bad = await harness.call('/api/health', { token: generateTokenValue() });
    expect(good.status).toBe(429);
    expect(good.text).toBe(bad.text);
    // And a blocked peer never learns which of its guesses was closest: the 401
    // body it saw before the block is one constant string.
    expect((good.json as { error: string }).error).not.toBe(UNAUTHORIZED_CODE);
  });
});
