/**
 * Token store and bearer authentication — remote IMPLEMENTATION **M4**, criterion
 * by criterion, over a real mounted listener with the real `sha256` and
 * `timingSafeEqual` paths.
 *
 * | M4 acceptance criterion | Test |
 * |---|---|
 * | A created token authenticates; its plaintext appears in the creation response and in no log, column or later response | *a created token authenticates …*, *the plaintext is stored nowhere …* (and `module.test.ts` scans the real log files) |
 * | Unknown, malformed, expired and revoked produce byte-identical 401 bodies | *unknown, malformed, expired and revoked …* |
 * | Revoked and expired fail immediately, including one revoked mid-test | *a token revoked mid-flight …*, *an expired token …* |
 * | `last_used_at` updates at most once per 60 s under a 100-request burst | *last_used_at is written at most once per 60 s …* |
 * | Every request in `access.log` with origin, tokenId, prefix, peer, requestId; failures at warn | *attributes the token to the request …* |
 * | A peer outside `100.64.0.0/10` is refused before routing | *refuses a peer outside the CGNAT range …* |
 * | A foreign `Host` gets 421; bound IP, MagicDNS and hint all pass | *answers 421 to a foreign Host …* |
 * | Timing shows no correlation with matching leading bytes | *hashes before it compares …*, *performs exactly one constant-time compare …* |
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAGIC_DNS,
  TAILNET_ADDRESS,
  createRemoteHarness,
  type RemoteHarness,
} from './__tests__/harness.js';
import { MISDIRECTED_CODE, PEER_REFUSED_CODE, normaliseHost, normalisePeer } from './middleware.js';
import { isCgnatIPv4 } from './tailscale.js';
import {
  TOKEN_PREFIX_LENGTH,
  UNAUTHORIZED_CODE,
  createRemoteTokenService,
  digestsEqual,
  generateTokenValue,
  hasExpired,
  sha256Hex,
} from './tokens.js';

let harness: RemoteHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Generation and storage (§4.1, §4.2)
// ---------------------------------------------------------------------------

describe('M4 — token generation and storage (§4.1, §4.2)', () => {
  it('mints 256 bits of base64url and stores only the sha256 digest and a six-character prefix', async () => {
    harness = await createRemoteHarness();
    const minted = harness.tokens.mint({ label: 'Pixel 9', device: 'Android 15' });

    // §4.2: 32 bytes, base64url — 43 characters, 256 bits.
    expect(minted.token).toHaveLength(43);
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(minted.token, 'base64url')).toHaveLength(32);

    const row = harness.tokensRepository.get(minted.view.id);
    expect(row).toBeDefined();
    // The stored value is the digest and nothing else — §4.1: "plaintext is never
    // stored, logged, or recoverable".
    expect(row?.tokenHash).toBe(createHash('sha256').update(minted.token).digest('hex'));
    expect(row?.tokenHash).not.toContain(minted.token);
    expect(row?.tokenPrefix).toBe(minted.token.slice(0, TOKEN_PREFIX_LENGTH));
    expect(row?.tokenPrefix).toHaveLength(6);
    expect(row?.label).toBe('Pixel 9');
    expect(row?.device).toBe('Android 15');
    expect(row?.lastUsedAt).toBeNull();
    expect(row?.lastUsedPeer).toBeNull();
  });

  it('is not re-derivable: nothing on the service or the row yields the plaintext again', async () => {
    harness = await createRemoteHarness();
    const minted = harness.tokens.mint({ label: 'work laptop' });

    // The list view and the record, serialised whole: the plaintext must not be a
    // substring of either. This is the assertion that a future field cannot break
    // quietly.
    const listed = JSON.stringify(harness.tokens.list());
    const stored = JSON.stringify(harness.tokensRepository.get(minted.view.id));
    expect(listed).not.toContain(minted.token);
    expect(stored).not.toContain(minted.token);
    expect(Object.keys(harness.tokens.get(minted.view.id) ?? {})).not.toContain('token');
  });

  it('defaults to a 90-day expiry, honours an override, and allows a never-expiring token', async () => {
    harness = await createRemoteHarness();
    const start = harness.now;

    const standard = harness.tokens.mint({ label: 'default' });
    expect(Date.parse(standard.view.expiresAt ?? '')).toBe(start + 90 * DAY_MS);

    const short = harness.tokens.mint({ label: 'short', ttlDays: 1 });
    expect(Date.parse(short.view.expiresAt ?? '')).toBe(start + DAY_MS);

    // §4.4: "`null` = never expire, allowed but flagged in the UI".
    const forever = harness.tokens.mint({ label: 'forever', ttlDays: null });
    expect(forever.view.expiresAt).toBeNull();
    expect(forever.view.expired).toBe(false);
  });

  it('refuses an empty label and refuses to exceed maxActive', async () => {
    harness = await createRemoteHarness({ maxActive: 2 });
    expect(() => harness?.tokens.mint({ label: '   ' })).toThrow(/needs a label/);

    harness.tokens.mint({ label: 'one' });
    harness.tokens.mint({ label: 'two' });
    expect(() => harness?.tokens.mint({ label: 'three' })).toThrow(/maximum/);

    // An expired token does not count against the cap: it is history, not a device.
    harness.now += 91 * DAY_MS;
    expect(() => harness?.tokens.mint({ label: 'three' })).not.toThrow();
  });

  it('generates a distinct token every time', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) seen.add(generateTokenValue());
    expect(seen.size).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Verification over a real socket (§4.6)
// ---------------------------------------------------------------------------

describe('M4 — a created token authenticates', () => {
  it('authenticates over the mounted remote listener and reaches the handler', async () => {
    harness = await createRemoteHarness();
    const { token } = harness.mint();

    const answer = await harness.call('/api/health', { token });
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ status: 'ok' });
  });

  it('the plaintext is stored nowhere the request path can reach', async () => {
    harness = await createRemoteHarness();
    const { id, token } = harness.mint();
    await harness.call('/api/health', { token });

    // Every subsequent response over the listener, scanned for the literal.
    const listed = await harness.call('/api/remote/tokens', { token });
    expect(listed.text).not.toContain(token);
    const status = await harness.call('/api/remote/status', { token });
    expect(status.text).not.toContain(token);

    // And the row, after a successful authentication that wrote `last_used_*`.
    expect(JSON.stringify(harness.tokensRepository.get(id))).not.toContain(token);
  });
});

describe('M4 — every failure is the same failure (§4.6, no oracle)', () => {
  it('answers unknown, malformed, expired and revoked with byte-identical 401 bodies', async () => {
    harness = await createRemoteHarness();

    const unknown = generateTokenValue();
    const expired = harness.mint('expired', { ttlDays: 1 });
    const revoked = harness.mint('revoked');
    harness.tokens.revoke(revoked.id);
    // Past the expiry, by the injected clock rather than by waiting.
    harness.now += 2 * DAY_MS;

    const bodies: string[] = [];
    const statuses: number[] = [];
    for (const candidate of [unknown, 'not-a-token', expired.token, revoked.token]) {
      const answer = await harness.call('/api/health', { token: candidate });
      statuses.push(answer.status);
      bodies.push(answer.text);
    }

    expect(statuses).toEqual([401, 401, 401, 401]);
    // Byte-identical, not merely same-shaped: one string, four times.
    expect(new Set(bodies).size).toBe(1);
    expect((JSON.parse(bodies[0] ?? '{}') as { error: string }).error).toBe(UNAUTHORIZED_CODE);
  });

  it('answers a request with no Authorization header with the same 401 body', async () => {
    harness = await createRemoteHarness();
    const withNone = await harness.call('/api/health');
    const withGarbage = await harness.call('/api/health', { token: generateTokenValue() });

    expect(withNone.status).toBe(401);
    expect(withNone.text).toBe(withGarbage.text);
  });

  it('never reveals whether an /api path exists to an unauthenticated caller', async () => {
    harness = await createRemoteHarness();
    const known = await harness.call('/api/health');
    const unknown = await harness.call('/api/does-not-exist');

    // Both 401, identical bodies: auth runs before the router's 404, so the
    // listener is not a route oracle either (§3.1's ordering).
    expect(known.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(known.text).toBe(unknown.text);
  });

  it('answers a JSON 404 for an unknown /api path once authenticated', async () => {
    harness = await createRemoteHarness();
    const { token } = harness.mint();
    const answer = await harness.call('/api/does-not-exist', { token });

    // 401 → 403 → 404 are three distinct answers to three distinct questions
    // (§8.2). Only a caller who has proved itself learns that a path is unknown.
    expect(answer.status).toBe(404);
    expect((answer.json as { error: string }).error).toBe('not_found');
  });
});

describe('M4 — revocation and expiry are honoured immediately', () => {
  it('refuses a token revoked mid-flight, on the very next request', async () => {
    harness = await createRemoteHarness();
    const { id, token } = harness.mint();

    expect((await harness.call('/api/health', { token })).status).toBe(200);
    expect(harness.tokens.revoke(id)).toBe(true);
    // No restart, no cache flush, no waiting: the next request is refused.
    expect((await harness.call('/api/health', { token })).status).toBe(401);
    // A second revoke changes nothing and does not resurrect the token.
    expect(harness.tokens.revoke(id)).toBe(false);
    expect((await harness.call('/api/health', { token })).status).toBe(401);
  });

  it('refuses an expired token the moment the clock passes its expires_at', async () => {
    harness = await createRemoteHarness();
    const { token } = harness.mint('short', { ttlDays: 1 });

    harness.now += DAY_MS - 1;
    expect((await harness.call('/api/health', { token })).status).toBe(200);

    // Inclusive boundary: dead *at* the deadline, which is the safe side of an
    // off-by-one on a credential.
    harness.now += 1;
    expect((await harness.call('/api/health', { token })).status).toBe(401);
  });

  it('treats a never-expiring token as live and an unparseable expiry as dead', () => {
    expect(hasExpired(null, Date.now())).toBe(false);
    expect(hasExpired('not a timestamp', Date.now())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// last_used_at / last_used_peer throttling (§4.6)
// ---------------------------------------------------------------------------

describe('M4 — last_used_at is written at most once per 60 s', () => {
  it('writes once across a 100-request burst, and again after the throttle window', async () => {
    harness = await createRemoteHarness({
      // The node name enrichment of §9.3, so the audit column's shape is asserted
      // too — and asserted as *enrichment*, since the request succeeds either way.
      peerName: (address) => (address === '127.0.0.1' ? 'test-node' : null),
    });
    const { id, token } = harness.mint();

    for (let index = 0; index < 100; index += 1) {
      const answer = await harness.call('/api/health', { token });
      expect(answer.status).toBe(200);
      // Advance a little on each request: 100 requests spread over 20 seconds is
      // the realistic shape of an SSE reconnect storm, and still one write.
      harness.now += 200;
    }

    const afterBurst = harness.tokensRepository.get(id);
    expect(afterBurst?.lastUsedAt).toBe(new Date(harness.now - 100 * 200).toISOString());
    expect(afterBurst?.lastUsedPeer).toBe('127.0.0.1 (test-node)');

    // Past the throttle window, the next success writes again.
    harness.now += 61_000;
    await harness.call('/api/health', { token });
    expect(harness.tokensRepository.get(id)?.lastUsedAt).toBe(new Date(harness.now).toISOString());
  });

  it('records the bare peer IP when the peer map resolves no node name (§9.3)', async () => {
    harness = await createRemoteHarness({ peerName: () => null });
    const { id, token } = harness.mint();
    await harness.call('/api/health', { token });

    // §9.3: "if the map is stale or absent, the request proceeds and the field is
    // `null`" — the request is the thing that must not depend on it.
    expect(harness.tokensRepository.get(id)?.lastUsedPeer).toBe('127.0.0.1');
  });
});

// ---------------------------------------------------------------------------
// Attribution into access.log (§9.1 #4, R3)
// ---------------------------------------------------------------------------

describe('M4 — attributes the token to the request for access.log (§9.1 #4)', () => {
  it('sets tokenId, prefix and the resolved node name on the request context', async () => {
    const seen: {
      tokenId: string | undefined;
      prefix: string | undefined;
      peerName: string | undefined;
      origin: string;
      requestId: string;
      peer: string | undefined;
    }[] = [];

    harness = await createRemoteHarness({
      peerName: () => 'pixel-9',
      routes: [
        {
          method: 'GET',
          path: '/api/fixture/attribution',
          handler: (request, response) => {
            seen.push({
              tokenId: request.tokenId,
              prefix: request.tokenAttribution?.prefix,
              peerName: request.tokenAttribution?.peerName,
              origin: request.origin,
              requestId: request.requestId,
              peer: request.remoteAddress,
            });
            return response.json({ ok: true });
          },
        },
      ],
    });
    const { id, token } = harness.mint('Pixel 9');
    const answer = await harness.call('/api/fixture/attribution', { token });
    expect(answer.status).toBe(200);

    const record = seen[0];
    expect(record).toBeDefined();
    // R3: the *id* is the join key; the prefix rides along for a human reader.
    expect(record?.tokenId).toBe(id);
    expect(record?.prefix).toBe(token.slice(0, TOKEN_PREFIX_LENGTH));
    expect(record?.peerName).toBe('pixel-9');
    expect(record?.origin).toBe('remote');
    expect(record?.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(record?.peer).toBe('127.0.0.1');
  });

  it('attributes nothing when the request was not authenticated', async () => {
    let attributed: string | undefined = 'unset';
    harness = await createRemoteHarness({
      routes: [
        {
          method: 'GET',
          path: '/*',
          remote: 'allow',
          handler: (request, response) => {
            attributed = request.tokenId;
            return response.text('shell');
          },
        },
      ],
    });

    // The static shell serves without a token (§3.1 rule 1), so nothing is
    // attributed — a line in `access.log` with a tokenId it did not earn would be
    // worse than one without.
    const answer = await harness.call('/');
    expect(answer.status).toBe(200);
    expect(attributed).toBeUndefined();
  });

  it('records a failed sign-in in the audit trail at warn, and a successful one not at all', async () => {
    harness = await createRemoteHarness();
    const { token } = harness.mint();

    await harness.call('/api/health', { token: generateTokenValue() });
    expect(harness.audit.failures).toHaveLength(1);
    expect(harness.audit.failures[0]?.path).toBe('/api/health');
    expect(harness.audit.failures[0]?.peer).toBe('127.0.0.1');

    await harness.call('/api/health', { token });
    expect(harness.audit.failures).toHaveLength(1);
    expect(harness.audit.refusals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Peer-address validation (§9.2 #6)
// ---------------------------------------------------------------------------

describe('M4 — refuses a peer outside the CGNAT range before routing (§9.2 #6)', () => {
  it('refuses every request, including the static shell, with the production predicate', async () => {
    let handlerRan = false;
    // No `allowPeer` override: the real predicate, against a real loopback peer,
    // which is exactly the misconfiguration §9.2 #6 exists to catch.
    harness = await createRemoteHarness({
      allowPeer: isCgnatIPv4,
      routes: [
        {
          method: 'GET',
          path: '/api/fixture/never',
          handler: (_request, response) => {
            handlerRan = true;
            return response.json({ reached: true });
          },
        },
      ],
    });

    for (const path of ['/', '/assets/app.js', '/api/health', '/api/fixture/never']) {
      const answer = await harness.call(path);
      expect(answer.status, path).toBe(403);
      expect((answer.json as { error: string }).error, path).toBe(PEER_REFUSED_CODE);
    }
    // "Refused before any routing": no handler ran, for any path, and the refusal
    // is identical for a path that exists and one that does not.
    expect(handlerRan).toBe(false);
    expect(harness.audit.refusals.map((entry) => entry.code)).toEqual([
      PEER_REFUSED_CODE,
      PEER_REFUSED_CODE,
      PEER_REFUSED_CODE,
      PEER_REFUSED_CODE,
    ]);
  });

  it('accepts a tailnet peer and refuses a LAN one, including the CPE-CGNAT trap', () => {
    expect(isCgnatIPv4('100.101.102.103')).toBe(true);
    expect(isCgnatIPv4('192.168.0.197')).toBe(false);
    expect(isCgnatIPv4('127.0.0.1')).toBe(false);
  });

  it('normalises an IPv4-mapped IPv6 peer so a dual-stack socket is not refused wholesale', () => {
    // A guard that refused `::ffff:100.64.0.7` would be an outage dressed as
    // security.
    expect(normalisePeer('::ffff:100.64.0.7')).toBe('100.64.0.7');
    expect(normalisePeer('100.64.0.7')).toBe('100.64.0.7');
    expect(normalisePeer(undefined)).toBeUndefined();
    expect(normalisePeer('   ')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The Host allowlist (§9.2 #8)
// ---------------------------------------------------------------------------

describe('M4 — the Host allowlist answers 421 (§9.2 #8)', () => {
  it('passes the bound IP, the MagicDNS name and the hostnameHint, and refuses anything else', async () => {
    harness = await createRemoteHarness({
      allowedHosts: () => ['127.0.0.1', TAILNET_ADDRESS, MAGIC_DNS, 'nickname'],
    });
    const { token } = harness.mint();

    for (const host of ['127.0.0.1', TAILNET_ADDRESS, MAGIC_DNS, 'nickname', `${MAGIC_DNS}.`]) {
      const answer = await harness.call('/api/health', { token, host });
      expect(answer.status, host).toBe(200);
    }

    for (const host of ['evil.example.com', 'localhost', '192.168.0.197']) {
      const answer = await harness.call('/api/health', { token, host });
      expect(answer.status, host).toBe(421);
      expect((answer.json as { error: string }).error, host).toBe(MISDIRECTED_CODE);
    }
  });

  it('refuses a foreign Host before the static shell, so a rebinding page cannot even load', async () => {
    harness = await createRemoteHarness({ allowedHosts: () => ['127.0.0.1'] });
    const answer = await harness.call('/', { host: 'evil.example.com' });
    expect(answer.status).toBe(421);
  });

  it('strips the port and lowercases, and fails closed on an absent Host', () => {
    expect(normaliseHost('100.64.0.7:7478')).toBe('100.64.0.7');
    expect(normaliseHost('[::1]:7478')).toBe('::1');
    expect(normaliseHost('WorkStation.Tail.TS.NET.')).toBe('workstation.tail.ts.net');
    expect(normaliseHost(undefined)).toBeUndefined();
    expect(normaliseHost('  ')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The timing criterion (§4.6, M4's last acceptance line)
// ---------------------------------------------------------------------------

describe('M4 — response time cannot correlate with matching leading bytes', () => {
  it('hashes before it compares, so leading-byte agreement is destroyed by construction', () => {
    // The statistical claim reduces to a structural one: the only value that
    // reaches the lookup and the comparison is `sha256(presented)`, and SHA-256's
    // avalanche means a candidate agreeing on 42 of 43 characters yields a digest
    // agreeing on nothing in particular. Measured rather than merely asserted.
    const real = generateTokenValue();
    const realDigest = Buffer.from(sha256Hex(real), 'hex');

    const differingBits: number[] = [];
    for (let index = 0; index < 64; index += 1) {
      // The strongest "many matching leading bytes" case an attacker could build:
      // every character but the last one, sixty-four different ways.
      const suffix =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[index] ?? 'A';
      if (suffix === real[42]) continue;
      const near = Buffer.from(sha256Hex(`${real.slice(0, 42)}${suffix}`), 'hex');
      let bits = 0;
      for (let byte = 0; byte < 32; byte += 1) {
        let xor = (realDigest[byte] ?? 0) ^ (near[byte] ?? 0);
        while (xor !== 0) {
          bits += xor & 1;
          xor >>= 1;
        }
      }
      differingBits.push(bits);
    }

    // Half of 256 bits, give or take: no candidate constructed from a near-miss
    // prefix produces a digest that is "close" to the stored one in any sense the
    // lookup or the compare could reveal.
    const mean = differingBits.reduce((sum, value) => sum + value, 0) / differingBits.length;
    expect(differingBits.length).toBeGreaterThan(50);
    expect(mean).toBeGreaterThan(96);
    expect(mean).toBeLessThan(160);
  });

  it('performs exactly one constant-time compare, over two 32-byte digests, whatever was presented', async () => {
    const widths: number[] = [];
    let compares = 0;
    harness = await createRemoteHarness();
    const service = createRemoteTokenService({
      tokens: harness.tokensRepository,
      clock: () => new Date(harness?.now ?? 0),
      defaultTtlDays: 90,
      maxActive: 10,
      compare: (left, right) => {
        compares += 1;
        widths.push(left.byteLength, right.byteLength);
        return timingSafeEqual(left, right);
      },
    });

    const minted = service.mint({ label: 'timing' });
    // Candidates sharing 0, 6, 20, 42 and all 43 leading characters with the real
    // token — the exact axis the criterion names.
    const candidates = [
      generateTokenValue(),
      `${minted.token.slice(0, 6)}${generateTokenValue().slice(6)}`,
      `${minted.token.slice(0, 20)}${generateTokenValue().slice(20)}`,
      `${minted.token.slice(0, 42)}${minted.token.endsWith('A') ? 'B' : 'A'}`,
      minted.token,
    ];

    const outcomes = candidates.map((candidate) => service.verify(candidate).ok);
    expect(outcomes).toEqual([false, false, false, false, true]);
    // Exactly one compare happened, and only for the one candidate whose digest
    // matched a row — every other candidate was rejected by a digest lookup that
    // cannot leak a prefix. Every compared buffer was a full digest.
    expect(compares).toBe(1);
    expect(new Set(widths)).toEqual(new Set([32]));
  });

  it('refuses to compare digests of unequal length rather than throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, which would be a crash *and*
    // a timing signal. The guard is a diagnostic for a corrupted row.
    expect(digestsEqual(sha256Hex('a'), sha256Hex('a'))).toBe(true);
    expect(digestsEqual(sha256Hex('a'), 'ab')).toBe(false);
    expect(digestsEqual('', '')).toBe(false);
  });

  it('shows no measurable timing spread across prefix-agreement groups', { retry: 2 }, async () => {
    // The wall-clock half, kept deliberately blunt: five groups of candidates
    // agreeing on 0 to 43 leading characters, and the spread *between* group
    // medians must not exceed the spread *within* a group by a wide factor. A
    // tighter bound would measure the CI runner's load, not this code.
    harness = await createRemoteHarness();
    const minted = harness.tokens.mint({ label: 'timing' });
    const groups = [0, 6, 20, 42, 43].map((shared) =>
      Array.from({ length: 60 }, () =>
        shared === 43
          ? minted.token
          : `${minted.token.slice(0, shared)}${randomBytes(32).toString('base64url').slice(shared)}`,
      ),
    );

    const medians = groups.map((candidates) => {
      const samples = candidates.map((candidate) => {
        const started = process.hrtime.bigint();
        harness?.tokens.verify(candidate);
        return Number(process.hrtime.bigint() - started);
      });
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)] ?? 0;
    });

    const slowest = Math.max(...medians);
    const fastest = Math.min(...medians);
    expect(fastest).toBeGreaterThan(0);
    expect(slowest / fastest).toBeLessThan(10);
  });
});

// ---------------------------------------------------------------------------
// R5 — remote never reads a stored secret
// ---------------------------------------------------------------------------

describe('M4 — verification reads no secret (R5)', () => {
  it('contains no call to the secret store anywhere in the module', () => {
    // R5 corrects foundation §3.2's authorised `.reveal()` list: "**remote does
    // not call `.reveal()`.** Bearer verification hashes the presented token and
    // compares against `remote_tokens.token_hash`." Asserted over the source,
    // because the property is an absence and an absence has no happy path.
    const sources = [
      'index.ts',
      'tokens.ts',
      'middleware.ts',
      'policy.ts',
      'rateLimit.ts',
      'routes.ts',
      'tokenRoutes.ts',
      'listener.ts',
      'tailscale.ts',
    ];
    for (const file of sources) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\.reveal\(/);
      expect(code, file).not.toMatch(/ctx\.secrets/);
    }
  });
});
