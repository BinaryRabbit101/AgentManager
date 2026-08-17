/**
 * M8 — per-agent remote-access grants, the three-tier gate, and every disable
 * trigger.
 *
 * Every criterion of IMPLEMENTATION §8 is a named test here, driven over the same
 * real second listener M7 uses, with the real `settings` rows, the real event bus,
 * and launch fixtures that really write `assignments` and `sessions` rows — so
 * "creates no assignment and no session row" is a claim about the gate refusing
 * before the handler, not about a stub doing nothing.
 */
import { describe, expect, it } from 'vitest';

import {
  GRANT_TTL_HOURS,
  createRemoteStreamHarness,
  type StreamHarness,
} from './__tests__/streamHarness.js';
import {
  AGENT_ACCESS_PREFIX,
  GRANT_EXPIRED_EVENT,
  GRANT_GRANTED_EVENT,
  GRANT_REVOKED_EVENT,
} from './grants.js';
import {
  INITIATING_SURFACES,
  NON_INITIATING_WRITES,
  REMOTE_ACCESS_REQUIRED_CODE,
  RESTRAINING_SURFACES,
  classifyPath,
  inLaunchNamespace,
} from './gate.js';

const HOUR_MS = 3_600_000;

async function withHarness(
  run: (harness: StreamHarness) => void | Promise<void>,
  options?: Parameters<typeof createRemoteStreamHarness>[0],
): Promise<void> {
  const harness = await createRemoteStreamHarness(options);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

interface Scene {
  readonly token: string;
  readonly tokenId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly assignmentId: string;
  readonly sessionId: string;
}

/** One paired device, one agent, one project, one assignment, one session. */
function scene(harness: StreamHarness, name = 'Ada'): Scene {
  const minted = harness.mint();
  const agentId = harness.seedAgent(name);
  const projectId = harness.seedProject();
  const assignmentId = harness.seedAssignment(projectId, [agentId]);
  const sessionId = harness.seedSession(assignmentId, agentId, projectId);
  return { token: minted.token, tokenId: minted.id, agentId, projectId, assignmentId, sessionId };
}

/**
 * The rows a refused launch must not have created.
 *
 * Counted from the repositories rather than asserted as "the handler did not run",
 * because IMPLEMENTATION §8's criterion is about the *rows*.
 */
function rowCounts(
  harness: StreamHarness,
  projectId: string,
): { assignments: number; sessions: number } {
  return {
    assignments: harness.store.assignments.listByProject(projectId).length,
    sessions: harness.store.sessions.list().length,
  };
}

// ---------------------------------------------------------------------------
// §6.1 — the row shape
// ---------------------------------------------------------------------------

describe('M8 — one settings row per agent (§6.1, R2)', () => {
  it('writes remote.agentAccess.<id> with §6.1’s value shape, and nothing else', async () => {
    await withHarness((harness) => {
      const { agentId } = scene(harness);
      harness.grants.grant(agentId, harness.now, { via: 'local' });

      const key = `${AGENT_ACCESS_PREFIX}${agentId}`;
      expect(harness.grants.key(agentId)).toBe(key);
      expect(harness.store.settings.get(key)).toEqual({
        enabled: true,
        grantedAt: new Date(harness.now).toISOString(),
        expiresAt: new Date(harness.now + GRANT_TTL_HOURS * HOUR_MS).toISOString(),
        grantedVia: 'local',
      });
      // One row, under the prefix, and no blob anywhere.
      expect(harness.store.settings.listByPrefix(AGENT_ACCESS_PREFIX).map((r) => r.key)).toEqual([
        key,
      ]);
    });
  });

  it('grants and revokes two agents as independent writes, so neither undoes the other', async () => {
    await withHarness((harness) => {
      const ada = harness.seedAgent('Ada');
      const sam = harness.seedAgent('Sam');
      harness.grants.grant(ada, harness.now, { via: 'local' });
      harness.grants.grant(sam, harness.now, { via: 'remote', tokenId: 'token-x' });

      expect(harness.grants.revoke(ada, 'toggled_off')).toBe(true);
      // The read-modify-write race a single JSON blob would have had: Sam's row is
      // untouched, because it was never in the same row.
      expect(harness.grants.isLive(sam, harness.now)).toBe(true);
      expect(harness.grants.isLive(ada, harness.now)).toBe(false);
      expect(harness.store.settings.has(`${AGENT_ACCESS_PREFIX}${ada}`)).toBe(false);
    });
  });

  it('revokes by deleting the row — absence is the disabled state (§6.1)', async () => {
    await withHarness((harness) => {
      const agentId = harness.seedAgent('Ada');
      harness.grants.grant(agentId, harness.now, { via: 'local' });
      harness.grants.revoke(agentId, 'toggled_off');

      // Not `{enabled: false}`: there is nothing for a sweep to garbage-collect.
      expect(harness.store.settings.listByPrefix(AGENT_ACCESS_PREFIX)).toEqual([]);
    });
  });

  it('records the granting token and origin when a remote client asks', async () => {
    await withHarness(async (harness) => {
      const { agentId, token, tokenId } = scene(harness);
      const answer = await harness.call(`/api/remote/agents/${agentId}/access`, {
        method: 'PUT',
        token,
        body: { enabled: true },
      });

      expect(answer.status).toBe(200);
      expect(harness.grants.get(agentId, harness.now)).toMatchObject({
        grantedVia: 'remote',
        tokenId,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// §6.2 — the gate, over the live surfaces
// ---------------------------------------------------------------------------

describe('M8 — an ungranted agent cannot be started remotely (§6.2, §6.3)', () => {
  it('refuses POST /api/assignments/solo with 409 and creates no assignment and no session row', async () => {
    await withHarness(async (harness) => {
      const { token, agentId, projectId } = scene(harness);
      const before = rowCounts(harness, projectId);

      const answer = await harness.call('/api/assignments/solo', {
        method: 'POST',
        token,
        body: { projectId, agentId, prompt: 'go' },
      });

      expect(answer.status).toBe(409);
      const body = answer.json as {
        error: string;
        agents: { agentId: string; agentName: string }[];
      };
      expect(body.error).toBe(REMOTE_ACCESS_REQUIRED_CODE);
      // §6.3: "The list is always present, even for a solo launch of one agent."
      expect(body.agents).toEqual([{ agentId, agentName: 'Ada' }]);
      expect(rowCounts(harness, projectId)).toEqual(before);
    });
  });

  it('succeeds after the grant, and the session carries origin: remote', async () => {
    await withHarness(async (harness) => {
      const { token, agentId, projectId } = scene(harness);
      const granted = await harness.call(`/api/remote/agents/${agentId}/access`, {
        method: 'PUT',
        token,
        body: { enabled: true },
      });
      expect(granted.status).toBe(200);

      const answer = await harness.call('/api/assignments/solo', {
        method: 'POST',
        token,
        body: { projectId, agentId, prompt: 'go' },
      });
      expect(answer.status).toBe(201);
      const { sessionId } = answer.json as { sessionId: string };
      expect(harness.store.sessions.get(sessionId)?.origin).toBe('remote');
    });
  });

  it('refuses POST /api/assignments listing every ungranted member', async () => {
    await withHarness(async (harness) => {
      const { token, projectId, agentId } = scene(harness, 'Ada');
      const sam = harness.seedAgent('Sam');
      harness.grants.grant(agentId, harness.now, { via: 'local' });
      const before = rowCounts(harness, projectId);

      const answer = await harness.call('/api/assignments', {
        method: 'POST',
        token,
        body: {
          projectId,
          pattern: 'pair',
          members: [
            { agentId, role: 'implementer' },
            { agentId: sam, role: 'reviewer' },
          ],
        },
      });

      expect(answer.status).toBe(409);
      const body = answer.json as { agents: { agentId: string; agentName: string }[] };
      // Only the ungranted one, so the client prompts for exactly what is missing.
      expect(body.agents).toEqual([{ agentId: sam, agentName: 'Sam' }]);
      expect(rowCounts(harness, projectId)).toEqual(before);
    });
  });

  it('refuses POST /api/assignments/:id/advance for an ungranted member of the assignment', async () => {
    await withHarness(async (harness) => {
      const { token, projectId, agentId } = scene(harness, 'Ada');
      const sam = harness.seedAgent('Sam');
      const assignmentId = harness.seedAssignment(projectId, [agentId, sam]);
      harness.grants.grant(agentId, harness.now, { via: 'local' });
      const before = rowCounts(harness, projectId);

      const answer = await harness.call(`/api/assignments/${assignmentId}/advance`, {
        method: 'POST',
        token,
        body: {},
      });

      // Refused in the middleware chain, before the handler that would have
      // started a session for each member.
      expect(answer.status).toBe(409);
      expect((answer.json as { agents: { agentId: string }[] }).agents).toEqual([
        { agentId: sam, agentName: 'Sam' },
      ]);
      expect(rowCounts(harness, projectId)).toEqual(before);

      // With every member granted it goes through, which is what makes the refusal
      // above about the grant rather than about the route.
      harness.grants.grant(sam, harness.now, { via: 'local' });
      const allowed = await harness.call(`/api/assignments/${assignmentId}/advance`, {
        method: 'POST',
        token,
        body: {},
      });
      expect(allowed.status).toBe(201);
    });
  });

  it('refuses an initiating request to a route the table does not register, rather than 404-ing past the gate', async () => {
    await withHarness(async (harness) => {
      const { token } = scene(harness);
      // `POST /api/sessions` is named by §6.2 and registered by nothing in this
      // build. The gate still runs — it is a middleware, not a handler — and with
      // no agent resolvable it refuses closed.
      const answer = await harness.call('/api/sessions', { method: 'POST', token, body: {} });
      expect(answer.status).toBe(409);
      expect((answer.json as { error: string }).error).toBe(REMOTE_ACCESS_REQUIRED_CODE);
    });
  });

  it('gates /steer and /resume but never /stop or /pause (§6.2’s safety valve)', async () => {
    await withHarness(async (harness) => {
      const { token, sessionId } = scene(harness);

      for (const verb of ['steer', 'resume']) {
        const answer = await harness.call(`/api/sessions/${sessionId}/${verb}`, {
          method: 'POST',
          token,
          body: { text: 'do more' },
        });
        expect(answer.status, verb).toBe(409);
      }

      for (const verb of ['stop', 'pause']) {
        const answer = await harness.call(`/api/sessions/${sessionId}/${verb}`, {
          method: 'POST',
          token,
          body: {},
        });
        expect(answer.status, verb).toBe(200);
      }
    });
  });

  it('lets an agent with no grant at all be stopped, paused, read and answered', async () => {
    await withHarness(async (harness) => {
      const { token, sessionId } = scene(harness);
      expect(harness.grants.list(harness.now)).toEqual([]);

      expect(
        (await harness.call(`/api/sessions/${sessionId}/stop`, { method: 'POST', token })).status,
      ).toBe(200);
      expect(
        (await harness.call(`/api/sessions/${sessionId}/pause`, { method: 'POST', token })).status,
      ).toBe(200);
      expect((await harness.call(`/api/sessions/${sessionId}/transcript`, { token })).status).toBe(
        200,
      );
      // §7.4's hard invariant: answering is never gated, in any state.
      const answered = await harness.call('/api/questions/q-1/answer', {
        method: 'POST',
        token,
        body: { answer: 'yes' },
      });
      expect(answered.status).toBe(200);
      expect((answered.json as { answeredVia: string }).answeredVia).toBe('remote');
    });
  });

  it('lets an agent whose grant has expired be stopped, paused, read and answered', async () => {
    await withHarness(async (harness) => {
      const { token, agentId, sessionId } = scene(harness);
      harness.grants.grant(agentId, harness.now, { via: 'remote' });
      harness.now += (GRANT_TTL_HOURS + 1) * HOUR_MS;
      expect(harness.grants.isLive(agentId, harness.now)).toBe(false);

      expect(
        (await harness.call(`/api/sessions/${sessionId}/stop`, { method: 'POST', token })).status,
      ).toBe(200);
      expect(
        (await harness.call(`/api/sessions/${sessionId}/pause`, { method: 'POST', token })).status,
      ).toBe(200);
      expect((await harness.call(`/api/sessions/${sessionId}/transcript`, { token })).status).toBe(
        200,
      );
      expect(
        (
          await harness.call('/api/questions/q-1/answer', {
            method: 'POST',
            token,
            body: { answer: 'yes' },
          })
        ).status,
      ).toBe(200);
      // …and the same expired grant still refuses a new launch.
      expect(
        (
          await harness.call(`/api/sessions/${sessionId}/steer`, {
            method: 'POST',
            token,
            body: { text: 'more' },
          })
        ).status,
      ).toBe(409);
    });
  });

  it('refuses an initiating request whose agents cannot be resolved, rather than allowing it', async () => {
    await withHarness(async (harness) => {
      const { token, projectId } = scene(harness);
      const before = rowCounts(harness, projectId);

      // A launch body with no agent named at all: fail closed.
      const answer = await harness.call('/api/assignments/solo', {
        method: 'POST',
        token,
        body: { projectId, prompt: 'go' },
      });
      expect(answer.status).toBe(409);
      expect((answer.json as { agents: unknown[] }).agents).toEqual([]);
      expect(rowCounts(harness, projectId)).toEqual(before);
    });
  });
});

// ---------------------------------------------------------------------------
// §6.3 — confirmRemoteAccess
// ---------------------------------------------------------------------------

describe('M8 — confirmRemoteAccess grants and starts in one call (§6.3)', () => {
  it('grants the named agent and starts atomically', async () => {
    await withHarness(async (harness) => {
      const { token, agentId, projectId } = scene(harness);

      const answer = await harness.call('/api/assignments/solo', {
        method: 'POST',
        token,
        body: { projectId, agentId, prompt: 'go', confirmRemoteAccess: true },
      });

      expect(answer.status).toBe(201);
      expect(harness.grants.isLive(agentId, harness.now)).toBe(true);
      expect(harness.events.filter((event) => event.type === GRANT_GRANTED_EVENT)).toHaveLength(1);
    });
  });

  it('grants every listed member of a pattern launch', async () => {
    await withHarness(async (harness) => {
      const { token, projectId, agentId } = scene(harness, 'Ada');
      const sam = harness.seedAgent('Sam');

      const answer = await harness.call('/api/assignments', {
        method: 'POST',
        token,
        body: {
          projectId,
          pattern: 'pair',
          members: [
            { agentId, role: 'implementer' },
            { agentId: sam, role: 'reviewer' },
          ],
          confirmRemoteAccess: true,
        },
      });

      expect(answer.status).toBe(201);
      expect(harness.grants.isLive(agentId, harness.now)).toBe(true);
      expect(harness.grants.isLive(sam, harness.now)).toBe(true);
    });
  });

  it('does not let confirmRemoteAccess bypass the unresolved-agents refusal', async () => {
    await withHarness(async (harness) => {
      const { token, projectId } = scene(harness);
      const answer = await harness.call('/api/assignments/solo', {
        method: 'POST',
        token,
        body: { projectId, prompt: 'go', confirmRemoteAccess: true },
      });
      // Nothing to grant means nothing to check, which means refuse.
      expect(answer.status).toBe(409);
      expect(harness.store.settings.listByPrefix(AGENT_ACCESS_PREFIX)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// §6.3 — the sliding TTL and lazy expiry
// ---------------------------------------------------------------------------

describe('M8 — the grant TTL slides and is enforced at read time (§6.3)', () => {
  it('refreshes expiresAt on every remote start, keeping the original grantedAt', async () => {
    await withHarness(async (harness) => {
      const { token, agentId, projectId } = scene(harness);
      harness.grants.grant(agentId, harness.now, { via: 'local' });
      const first = harness.grants.get(agentId, harness.now);

      harness.now += 40 * HOUR_MS;
      const answer = await harness.call('/api/assignments/solo', {
        method: 'POST',
        token,
        body: { projectId, agentId, prompt: 'go' },
      });
      expect(answer.status).toBe(201);

      const slid = harness.grants.get(agentId, harness.now);
      expect(slid?.grantedAt).toBe(first?.grantedAt);
      expect(Date.parse(slid?.expiresAt ?? '')).toBeGreaterThan(Date.parse(first?.expiresAt ?? ''));
      expect(slid?.expiresAt).toBe(new Date(harness.now + GRANT_TTL_HOURS * HOUR_MS).toISOString());
    });
  });

  it('lets the grant lapse after ttlHours with no remote start, and the next start 409s', async () => {
    await withHarness(async (harness) => {
      const { token, agentId, projectId } = scene(harness);
      harness.grants.grant(agentId, harness.now, { via: 'remote' });

      harness.now += GRANT_TTL_HOURS * HOUR_MS;
      const answer = await harness.call('/api/assignments/solo', {
        method: 'POST',
        token,
        body: { projectId, agentId, prompt: 'go' },
      });
      expect(answer.status).toBe(409);
    });
  });

  it('refuses a lapsed grant at read time even when the sweep has never run', async () => {
    await withHarness((harness) => {
      const agentId = harness.seedAgent('Ada');
      harness.grants.grant(agentId, harness.now, { via: 'local' });
      harness.now += (GRANT_TTL_HOURS + 5) * HOUR_MS;

      // The row is still on disk — nothing has swept — and it is still refused.
      expect(harness.store.settings.has(`${AGENT_ACCESS_PREFIX}${agentId}`)).toBe(true);
      expect(harness.grants.isLive(agentId, harness.now)).toBe(false);
      expect(harness.grants.get(agentId, harness.now)).toBeUndefined();
      // And it is absent from the list the UI reads, so enforcement and display
      // cannot disagree.
      expect(harness.grants.list(harness.now)).toEqual([]);
    });
  });

  it('the sweep deletes lapsed rows and emits one .expired event each', async () => {
    await withHarness((harness) => {
      const ada = harness.seedAgent('Ada');
      const sam = harness.seedAgent('Sam');
      harness.grants.grant(ada, harness.now, { via: 'local' });
      harness.now += 10 * HOUR_MS;
      harness.grants.grant(sam, harness.now, { via: 'local' });

      // Ada's deadline is at +72 h and Sam's at +82 h, so at +75 h exactly one has
      // lapsed and one sweep takes exactly one row.
      harness.now += 65 * HOUR_MS;
      expect(harness.grants.sweep(harness.now)).toEqual([ada]);
      const expired = harness.events.filter((event) => event.type === GRANT_EXPIRED_EVENT);
      expect(expired).toHaveLength(1);
      expect(expired[0]?.ids.agentId).toBe(ada);
      expect(harness.grants.isLive(sam, harness.now)).toBe(true);

      harness.now += 10 * HOUR_MS;
      expect(harness.grants.sweep(harness.now)).toEqual([sam]);
      expect(harness.store.settings.listByPrefix(AGENT_ACCESS_PREFIX)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// §6.3 — every disable trigger
// ---------------------------------------------------------------------------

describe('M8 — every disable trigger of §6.3', () => {
  it('an explicit toggle off clears the grant immediately and emits .revoked', async () => {
    await withHarness(async (harness) => {
      const { token, agentId } = scene(harness);
      harness.grants.grant(agentId, harness.now, { via: 'local' });

      const answer = await harness.call(`/api/remote/agents/${agentId}/access`, {
        method: 'PUT',
        token,
        body: { enabled: false },
      });
      expect(answer.status).toBe(200);
      expect((answer.json as { revoked: boolean }).revoked).toBe(true);
      expect(harness.grants.isLive(agentId, harness.now)).toBe(false);
      expect(
        harness.events.filter((event) => event.type === GRANT_REVOKED_EVENT).at(-1)?.payload,
      ).toMatchObject({ agentId, reason: 'toggled_off' });
    });
  });

  it('revoking the last active token clears every grant (§4.5)', async () => {
    await withHarness(async (harness) => {
      const { token, tokenId, agentId } = scene(harness);
      const sam = harness.seedAgent('Sam');
      harness.grants.grant(agentId, harness.now, { via: 'remote' });
      harness.grants.grant(sam, harness.now, { via: 'remote' });

      const answer = await harness.call(`/api/remote/tokens/${tokenId}`, {
        method: 'DELETE',
        token,
      });
      expect(answer.status).toBe(200);
      expect((answer.json as { clearedGrants: string[] }).clearedGrants.sort()).toEqual(
        [agentId, sam].sort(),
      );
      expect(harness.store.settings.listByPrefix(AGENT_ACCESS_PREFIX)).toEqual([]);
      expect(
        harness.events
          .filter((event) => event.type === GRANT_REVOKED_EVENT)
          .map((event) => (event.payload as { reason: string }).reason),
      ).toEqual(['last_token_revoked', 'last_token_revoked']);
    });
  });

  it('revoking one of two tokens leaves the grants alone', async () => {
    await withHarness(async (harness) => {
      const { tokenId, agentId } = scene(harness);
      const other = harness.mint('tablet');
      harness.grants.grant(agentId, harness.now, { via: 'remote' });

      await harness.call(`/api/remote/tokens/${tokenId}`, { method: 'DELETE', token: other.token });
      // A remote identity still exists, so nothing should be un-authorized.
      expect(harness.grants.isLive(agentId, harness.now)).toBe(true);
    });
  });

  it('archiving the agent clears its grant and emits .revoked with agent_gone', async () => {
    await withHarness((harness) => {
      const agentId = harness.seedAgent('Ada');
      harness.grants.grant(agentId, harness.now, { via: 'local' });

      // Roster's own signal: the index row is archived and `roster.changed` fires.
      // (The module subscribes in `index.ts`; here the reconciliation is driven
      // directly, because this harness mounts the routes rather than the module.)
      harness.store.agents.upsert({
        id: agentId,
        name: 'Ada',
        archivedAt: new Date(harness.now).toISOString(),
      });
      for (const view of harness.grants.list(harness.now)) {
        const agent = harness.store.agents.get(view.agentId);
        if (agent !== undefined && agent.archivedAt === null) continue;
        harness.grants.revoke(view.agentId, 'agent_gone');
      }

      expect(harness.grants.isLive(agentId, harness.now)).toBe(false);
      expect(
        harness.events.filter((event) => event.type === GRANT_REVOKED_EVENT).at(-1)?.payload,
      ).toMatchObject({ reason: 'agent_gone' });
    });
  });

  it('remote.enabled: false blocks initiation but preserves grants, and re-enabling does not re-prompt', async () => {
    let enabled = true;
    await withHarness(
      async (harness) => {
        const { token, agentId, projectId } = scene(harness);
        harness.grants.grant(agentId, harness.now, { via: 'remote' });

        enabled = false;
        const blocked = await harness.call('/api/assignments/solo', {
          method: 'POST',
          token,
          body: { projectId, agentId, prompt: 'go' },
        });
        expect(blocked.status).toBe(403);
        expect((blocked.json as { error: string }).error).toBe('route_denied_remotely');
        // §6.3: grants **survive**, "so re-enabling does not re-nag the user
        // through every consent prompt again".
        expect(harness.store.settings.has(`${AGENT_ACCESS_PREFIX}${agentId}`)).toBe(true);

        enabled = true;
        const allowed = await harness.call('/api/assignments/solo', {
          method: 'POST',
          token,
          body: { projectId, agentId, prompt: 'go' },
        });
        expect(allowed.status).toBe(201);
      },
      { remoteEnabled: () => enabled },
    );
  });
});

// ---------------------------------------------------------------------------
// §5 / §12 contract 4 — the list endpoint and the live events
// ---------------------------------------------------------------------------

describe('M8 — GET /api/remote/agents reports expiresAt and the events are live (§5, §12.4)', () => {
  it('lists live grants with their deadline and the agent’s name', async () => {
    await withHarness(async (harness) => {
      const { token, agentId } = scene(harness);
      harness.grants.grant(agentId, harness.now, { via: 'local' });

      const answer = await harness.call('/api/remote/agents', { token });
      expect(answer.status).toBe(200);
      expect((answer.json as { agents: unknown[] }).agents).toEqual([
        {
          agentId,
          agentName: 'Ada',
          enabled: true,
          grantedAt: new Date(harness.now).toISOString(),
          expiresAt: new Date(harness.now + GRANT_TTL_HOURS * HOUR_MS).toISOString(),
          grantedVia: 'local',
          tokenId: null,
        },
      ]);
    });
  });

  it('emits a persisted .granted event a local UI stream can see', async () => {
    await withHarness(async (harness) => {
      const { token, agentId } = scene(harness);
      const client = await harness.sse(`/api/events?ticket=${await harness.ticketFor(token)}`);
      await client.waitFor('replay-complete', 1_000);

      await harness.call(`/api/remote/agents/${agentId}/access`, {
        method: 'PUT',
        token,
        body: { enabled: true },
      });

      const frame = await client.waitFor('event', 1_000);
      expect(frame.data).toContain(GRANT_GRANTED_EVENT);
      // Persisted, so a client that was asleep replays it (§6.5).
      const persisted = harness.events.find((event) => event.type === GRANT_GRANTED_EVENT);
      expect(persisted?.persist).toBe(true);
      expect(persisted?.id).toBeDefined();
      client.drop();
    });
  });

  it('rejects a malformed grant body rather than guessing a direction', async () => {
    await withHarness(async (harness) => {
      const { token, agentId } = scene(harness);
      const answer = await harness.call(`/api/remote/agents/${agentId}/access`, {
        method: 'PUT',
        token,
        body: { enabled: 'yes' },
      });
      expect(answer.status).toBe(400);
      expect(harness.grants.isLive(agentId, harness.now)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// The enumeration criterion: a new launch route arrives gated
// ---------------------------------------------------------------------------

describe('M8 — the gate is defined over launch semantics, not route names (§6.2)', () => {
  it('classifies every write in the launch namespaces deliberately', () => {
    // The three lists partition the writes this element knows about; the safety
    // net below covers everything else. A route that belongs in none of them
    // fails this test rather than shipping ungated.
    const enumerated = [...INITIATING_SURFACES, ...RESTRAINING_SURFACES, ...NON_INITIATING_WRITES];
    for (const surface of enumerated) {
      expect(surface.reason.length, surface.pattern).toBeGreaterThan(20);
    }
    for (const surface of INITIATING_SURFACES) {
      for (const method of surface.methods) {
        expect(classifyPath(method, surface.pattern.replace(/:\w+/g, 'x')), surface.pattern).toBe(
          'initiate',
        );
      }
    }
    for (const surface of RESTRAINING_SURFACES) {
      for (const method of surface.methods) {
        expect(classifyPath(method, surface.pattern.replace(/:\w+/g, 'x')), surface.pattern).toBe(
          'restrain',
        );
      }
    }
  });

  it('treats an unclassified write inside a launch namespace as initiation', () => {
    // The failure §6.2 records as having happened once already: an enumeration
    // that named the wrong endpoint. A route nobody has classified is gated.
    expect(inLaunchNamespace('/api/assignments/abc/launch-everything')).toBe(true);
    expect(classifyPath('POST', '/api/assignments/abc/launch-everything')).toBe('initiate');
    expect(classifyPath('POST', '/api/sessions/abc/start-over')).toBe('initiate');
    expect(classifyPath('PUT', '/api/sessions/abc/whatever')).toBe('initiate');
  });

  it('leaves reads and other namespaces in the observe tier', () => {
    for (const path of [
      '/api/assignments',
      '/api/assignments/abc',
      '/api/sessions/abc',
      '/api/sessions/abc/transcript',
      '/api/questions/abc/answer',
      '/api/events',
      '/api/roster/agents',
      '/api/fs/browse',
    ]) {
      expect(classifyPath('GET', path), path).toBe('observe');
    }
    // Answering is a write, and it is deliberately outside the launch namespaces
    // and in the observe tier — §7.4's hard invariant.
    expect(classifyPath('POST', '/api/questions/abc/answer')).toBe('observe');
    expect(classifyPath('POST', '/api/projects')).toBe('observe');
  });

  it('refuses an unclassified launch-namespace write over the real listener', async () => {
    await withHarness(
      async (harness) => {
        const { token } = scene(harness);
        const answer = await harness.call('/api/assignments/anything/launch-everything', {
          method: 'POST',
          token,
          body: {},
        });
        // Gated, and — because no agent could be named — refused closed.
        expect(answer.status).toBe(409);
        expect((answer.json as { error: string }).error).toBe(REMOTE_ACCESS_REQUIRED_CODE);
      },
      {
        routes: [
          {
            method: 'POST',
            path: '/api/assignments/:id/launch-everything',
            handler: (_request, response) => response.json({ started: true }),
          },
        ],
      },
    );
  });
});
