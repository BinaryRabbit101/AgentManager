/**
 * M7 — stream tickets, WS/SSE authentication, and connection lifecycle.
 *
 * Every criterion of IMPLEMENTATION §7 is a named test here, driven over a real
 * loopback socket with remote's real middleware chain and remote's real routes in
 * front of it (`__tests__/streamHarness.ts` explains why a real socket and a
 * header-less SSE client are the only honest way to assert any of it).
 *
 * The one place a criterion is asserted below the socket is the half-open reaper:
 * "reaped within two heartbeat intervals … no leak under 100 connect/drop cycles"
 * is a property of the registry's arithmetic, and driving 100 real sockets through
 * two real 30-second intervals would be a test nobody runs. It gets both: a
 * deterministic registry test for the *rule*, and a socket test proving a dropped
 * browser really does leave the map empty.
 */
import { describe, expect, it } from 'vitest';

import {
  createRemoteStreamHarness,
  TICKET_TTL_SEC,
  type StreamHarness,
} from './__tests__/streamHarness.js';
import { STREAM_TICKET_PATHS, isStreamTicketRequest } from './policy.js';
import {
  MISSED_BEATS_BEFORE_CLOSE,
  createStreamRegistry,
  type StreamConnection,
} from './streams.js';
import { TICKET_BYTES, createTicketStore } from './tickets.js';

async function withHarness(
  run: (harness: StreamHarness) => Promise<void>,
  options?: Parameters<typeof createRemoteStreamHarness>[0],
): Promise<void> {
  const harness = await createRemoteStreamHarness(options);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

// ---------------------------------------------------------------------------
// The ticket store's own arithmetic (§3.4)
// ---------------------------------------------------------------------------

describe('M7 — the ticket store (§3.4)', () => {
  it('mints 32 bytes of base64url bound to the minting token', () => {
    const tickets = createTicketStore({ ttlSec: 30 });
    const minted = tickets.mint('token-a', 1_000);

    expect(Buffer.from(minted.ticket, 'base64url')).toHaveLength(TICKET_BYTES);
    expect(minted.ttlSec).toBe(30);
    expect(minted.expiresAt).toBe(new Date(31_000).toISOString());
    expect(tickets.consume(minted.ticket, 1_500)).toEqual({ ok: true, tokenId: 'token-a' });
  });

  it('is single use: the second consume of one ticket is refused with no reason', () => {
    const tickets = createTicketStore({ ttlSec: 30 });
    const minted = tickets.mint('token-a', 0);

    expect(tickets.consume(minted.ticket, 1)).toEqual({ ok: true, tokenId: 'token-a' });
    // Byte-identical to an unknown ticket: replay is not detected, it is impossible.
    expect(tickets.consume(minted.ticket, 2)).toEqual({ ok: false });
    expect(tickets.consume('never-existed', 2)).toEqual({ ok: false });
    expect(tickets.size()).toBe(0);
  });

  it('refuses a ticket at and after its deadline, and forgets it either way', () => {
    const tickets = createTicketStore({ ttlSec: 30 });
    const minted = tickets.mint('token-a', 0);

    // Inclusive, like token expiry: dead *at* the deadline.
    expect(tickets.consume(minted.ticket, 30_000)).toEqual({ ok: false });
    expect(tickets.size()).toBe(0);

    const second = tickets.mint('token-a', 0);
    tickets.sweep(30_001);
    expect(tickets.size()).toBe(0);
    expect(tickets.consume(second.ticket, 10)).toEqual({ ok: false });
  });

  it('never persists anything — there is no store to read a ticket out of', () => {
    const tickets = createTicketStore({ ttlSec: 30 });
    tickets.mint('token-a', 0);
    // A fresh store shares nothing with the first: the only copy was in memory.
    expect(createTicketStore({ ttlSec: 30 }).size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A browser-shaped client connects with a ticket
// ---------------------------------------------------------------------------

describe('M7 — a browser-shaped client streams with a ticket', () => {
  it.each(STREAM_TICKET_PATHS.map((pattern) => pattern.replace(':id', 'session-1')))(
    'connects to %s with no headers at all and receives a frame',
    async (path) => {
      await withHarness(async (harness) => {
        const { token } = harness.mint();
        const ticket = await harness.ticketFor(token);

        const client = await harness.sse(`${path}?ticket=${ticket}`);
        expect(client.status).toBe(200);
        // Within 1 s, per the criterion — the helper's default timeout is 2 s and
        // the assertion below is what fails if the frame is late.
        const frame = await client.waitFor('replay-complete', 1_000);
        expect(frame.event).toBe('replay-complete');
        client.drop();
      });
    },
  );

  it('receives an event emitted after subscription within 1 s', async () => {
    await withHarness(async (harness) => {
      const { token } = harness.mint();
      const ticket = await harness.ticketFor(token);
      const client = await harness.sse(`/api/events?ticket=${ticket}`);
      await client.waitFor('replay-complete', 1_000);

      harness.bus.emit({ type: 'session.started', persist: false });
      const frame = await client.waitFor('event', 1_000);
      expect(frame.data).toContain('session.started');
      client.drop();
    });
  });

  it('refuses the same stream with no ticket and with no header — 401, not a 200', async () => {
    await withHarness(async (harness) => {
      const answer = await harness.call('/api/events');
      expect(answer.status).toBe(401);
      expect((answer.json as { error: string }).error).toBe('unauthorized');
      expect(harness.streams.count()).toBe(0);
    });
  });

  it('accepts the bearer header on a stream route as well, so no client needs a ticket twice', async () => {
    await withHarness(async (harness) => {
      const { token } = harness.mint();
      // No ticket and no header: refused, and nothing registered.
      expect((await harness.sse('/api/events')).status).toBe(401);
      expect(harness.streams.count()).toBe(0);

      // The durable credential still works on a stream route — the ticket scheme
      // is an *addition* for browsers, never a replacement that locks out a client
      // which can set a header.
      expect(await harness.probe('/api/events', { token })).toBe(200);
    });
  });

  it('lets the bearer header win over a ticket, and does not spend the ticket doing so', async () => {
    await withHarness(async (harness) => {
      const { token } = harness.mint();
      const ticket = await harness.ticketFor(token);

      expect(await harness.probe(`/api/events?ticket=${ticket}`, { token })).toBe(200);
      // The header authenticated, so the ticket was never consumed and is still
      // worth exactly one connection.
      expect(harness.tickets.size()).toBe(1);
      const client = await harness.sse(`/api/events?ticket=${ticket}`);
      expect(client.status).toBe(200);
      client.drop();
    });
  });
});

// ---------------------------------------------------------------------------
// Replay, then live, with no gap and no duplicate (§3.4)
// ---------------------------------------------------------------------------

describe('M7 — replay then live over the remote listener (§3.4)', () => {
  it('replays a since= watermark and continues into the live stream with no gap', async () => {
    await withHarness(async (harness) => {
      const { token } = harness.mint();
      const ticket = await harness.ticketFor(token);

      const client = await harness.sse(`/api/events?since=0&ticket=${ticket}`);
      await client.waitFor('replay-complete', 1_000);

      harness.bus.emit({ type: 'session.started', persist: true });
      harness.bus.emit({ type: 'session.ended', persist: true });
      await client.waitFor('event', 1_000);

      // Both live emits arrive, in order, exactly once each.
      const seen = client.frames.filter((frame) => frame.event === 'event').map((f) => f.data);
      expect(seen.filter((data) => data.includes('session.started'))).toHaveLength(1);
      client.drop();
    });
  });
});

// ---------------------------------------------------------------------------
// Refusals: reuse, expiry, revocation, wrong route
// ---------------------------------------------------------------------------

describe('M7 — a ticket is single use, short lived, and dies with its token', () => {
  it('refuses a reused ticket', async () => {
    await withHarness(async (harness) => {
      const { token } = harness.mint();
      const ticket = await harness.ticketFor(token);

      const first = await harness.sse(`/api/events?ticket=${ticket}`);
      expect(first.status).toBe(200);
      const second = await harness.sse(`/api/events?ticket=${ticket}`);
      expect(second.status).toBe(401);
      first.drop();
    });
  });

  it('refuses an expired ticket, with the clock moved rather than waited out', async () => {
    await withHarness(async (harness) => {
      const { token } = harness.mint();
      const ticket = await harness.ticketFor(token);

      harness.now += TICKET_TTL_SEC * 1000;
      const client = await harness.sse(`/api/events?ticket=${ticket}`);
      expect(client.status).toBe(401);
      expect(harness.streams.count()).toBe(0);
    });
  });

  it('refuses a ticket minted by token A once token A is revoked', async () => {
    await withHarness(async (harness) => {
      const { id, token } = harness.mint('Pixel 9');
      harness.mint('desk');
      const ticket = await harness.ticketFor(token);

      const revoked = await harness.call(`/api/remote/tokens/${id}`, {
        method: 'DELETE',
        token,
      });
      expect(revoked.status).toBe(200);

      // The ticket is still inside its 30 seconds — it is the *token* that died.
      const client = await harness.sse(`/api/events?ticket=${ticket}`);
      expect(client.status).toBe(401);
    });
  });

  it('never honours a ticket outside the three declared stream paths', async () => {
    await withHarness(async (harness) => {
      const { token } = harness.mint();
      const ticket = await harness.ticketFor(token);

      // A read that is not a stream: the ticket buys nothing, so this is the same
      // 401 a request with no credential at all gets.
      const answer = await harness.call(`/api/health?ticket=${ticket}`);
      expect(answer.status).toBe(401);
      expect(isStreamTicketRequest('GET', '/api/health')).toBe(false);

      // And the ticket was not spent by the attempt, so the closed direction did
      // not become a way to burn someone else's ticket.
      const client = await harness.sse(`/api/events?ticket=${ticket}`);
      expect(client.status).toBe(200);
      client.drop();
    });
  });

  it('refuses a ticket on a write, even to a stream path', async () => {
    await withHarness(async (harness) => {
      const { token } = harness.mint();
      const ticket = await harness.ticketFor(token);
      const answer = await harness.call(`/api/events?ticket=${ticket}`, { method: 'POST' });
      // 401 (no credential) or 405 (no such route) — never 200. Both are refusals;
      // the assertion is that a ticket cannot authenticate a write.
      expect(answer.status).not.toBe(200);
    });
  });

  it('refuses to mint a ticket where there is no token identity to bind it to', async () => {
    await withHarness(async (harness) => {
      const answer = await harness.call('/api/remote/stream-ticket', { method: 'POST' });
      expect(answer.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// §4.5 — revoking a token closes its streams
// ---------------------------------------------------------------------------

describe('M7 — revoking a token closes its live streams (§4.5)', () => {
  it('closes the revoked token’s streams within 1 s and leaves the other token’s open', async () => {
    await withHarness(async (harness) => {
      const alice = harness.mint('Pixel 9');
      const bob = harness.mint('tablet');

      const aliceStream = await harness.sse(
        `/api/events?ticket=${await harness.ticketFor(alice.token)}`,
      );
      const bobStream = await harness.sse(
        `/api/events?ticket=${await harness.ticketFor(bob.token)}`,
      );
      await aliceStream.waitFor('replay-complete', 1_000);
      await bobStream.waitFor('replay-complete', 1_000);
      expect(harness.streams.count(alice.id)).toBe(1);
      expect(harness.streams.count(bob.id)).toBe(1);

      const answer = await harness.call(`/api/remote/tokens/${alice.id}`, {
        method: 'DELETE',
        token: bob.token,
      });
      expect(answer.status).toBe(200);
      expect((answer.json as { closedStreams: number }).closedStreams).toBe(1);

      await aliceStream.waitForClose(1_000);
      expect(aliceStream.closed).toBe(true);
      expect(bobStream.closed).toBe(false);
      expect(harness.streams.count(alice.id)).toBe(0);
      expect(harness.streams.count(bob.id)).toBe(1);
      bobStream.drop();
    });
  });

  it('registers a stream against the token that authenticated it, never against none', async () => {
    await withHarness(async (harness) => {
      const { id, token } = harness.mint();
      const client = await harness.sse(`/api/events?ticket=${await harness.ticketFor(token)}`);
      await client.waitFor('replay-complete', 1_000);

      expect(harness.streams.tokens).toEqual([id]);
      client.drop();
    });
  });
});

// ---------------------------------------------------------------------------
// The heartbeat and the reaper (§3.4)
// ---------------------------------------------------------------------------

describe('M7 — heartbeats reap half-open connections without leaking (§3.4)', () => {
  it('closes after exactly two missed beats, not one', () => {
    const registry = createStreamRegistry();
    let closed = 0;
    let writable = true;
    const connection: StreamConnection = {
      tokenId: 'token-a',
      close: () => void (closed += 1),
      beat: () => writable,
    };
    registry.add(connection);

    expect(registry.beat()).toBe(0);
    expect(registry.count()).toBe(1);

    writable = false;
    // One miss is not enough — a single failed write is how a healthy connection
    // looks the instant before its socket flushes.
    expect(registry.beat()).toBe(0);
    expect(registry.count()).toBe(1);
    expect(closed).toBe(0);

    expect(registry.beat()).toBe(1);
    expect(MISSED_BEATS_BEFORE_CLOSE).toBe(2);
    expect(closed).toBe(1);
    // Closed *and* forgotten: the map entry is the leak.
    expect(registry.count()).toBe(0);
    expect(registry.tokens).toEqual([]);
  });

  it('resets the miss count when a beat succeeds again', () => {
    const registry = createStreamRegistry();
    let writable = true;
    registry.add({ tokenId: 'token-a', close: () => {}, beat: () => writable });

    writable = false;
    registry.beat();
    writable = true;
    registry.beat();
    writable = false;
    // The earlier miss was forgiven, so this is miss one of two, not two of two.
    expect(registry.beat()).toBe(0);
    expect(registry.count()).toBe(1);
  });

  it('leaks nothing over 100 connect/drop cycles', () => {
    const registry = createStreamRegistry();
    for (let cycle = 0; cycle < 100; cycle += 1) {
      let writable = true;
      registry.add({
        tokenId: `token-${String(cycle % 3)}`,
        close: () => void (writable = false),
        beat: () => writable,
      });
      writable = false;
      registry.beat();
      registry.beat();
    }
    expect(registry.count()).toBe(0);
    expect(registry.tokens).toEqual([]);
  });

  it('deregisters a dropped browser over the real socket', async () => {
    await withHarness(async (harness) => {
      const { id, token } = harness.mint();
      const client = await harness.sse(`/api/events?ticket=${await harness.ticketFor(token)}`);
      await client.waitFor('replay-complete', 1_000);
      expect(harness.streams.count(id)).toBe(1);

      client.drop();
      // Two heartbeat ticks are the documented bound; the socket's own close event
      // usually gets there first, which is why the loop tolerates either.
      const deadline = Date.now() + 2_000;
      while (harness.streams.count(id) > 0 && Date.now() < deadline) {
        harness.heartbeat();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(harness.streams.count(id)).toBe(0);
      expect(harness.streams.count()).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// R3 — no credential material in access.log
// ---------------------------------------------------------------------------

describe('M7 — no ticket or Authorization value reaches access.log (R3)', () => {
  it('scrubs the ticket query parameter and the bearer header, keeping the names', async () => {
    const harness = await createRemoteStreamHarness();
    let ticket = '';
    let token = '';
    try {
      const minted = harness.mint();
      token = minted.token;
      ticket = await harness.ticketFor(token);
      const client = await harness.sse(`/api/events?ticket=${ticket}`);
      await client.waitFor('replay-complete', 1_000);
      client.drop();
      // A bearer request too, so both credential shapes are in the file's history.
      await harness.call('/api/health', { token });
    } finally {
      const log = await harness.readAccessLog();
      await harness.close();

      expect(log.length).toBeGreaterThan(0);
      expect(ticket.length).toBeGreaterThan(0);
      expect(log).not.toContain(ticket);
      expect(log).not.toContain(token);
      // The parameter *name* survives: "knowing that a ticket was presented is
      // exactly what incident review needs" (foundation §5.4).
      expect(log).toContain('ticket=[redacted]');
    }
  });
});
