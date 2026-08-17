/**
 * Per-agent remote-access grants — remote DESIGN §6.1 and §6.3;
 * IMPLEMENTATION §8.
 *
 * ## One `settings` row per agent, and why the shape is the decision
 *
 * §6.1: "foundation's `settings` table, one row per agent, key
 * `remote.agentAccess.<agentId>`, owned by the remote module." Foundation §1.4
 * shipped `listByPrefix` and `deleteByKey` *for this*, and R2 states the reason
 * in as many words: "Per-agent rows avoid read-modify-write races that one JSON
 * blob would have." Granting one agent and revoking another are two independent
 * writes to two independent rows; with a blob they would be two read-modify-write
 * cycles over the same row, and the second would silently undo the first.
 *
 * Why not roster's `library/agents/<id>/agent.json`? §6.1: that file is
 * "authored, git-versioned, portable content that must be identical in both
 * editions", and "a machine's remote posture is not a property of the agent;
 * committing 'this persona may be launched from a phone' would be committing a
 * fact about one Windows box."
 *
 * ## Absence is the disabled state
 *
 * §6.1: "Rows are deleted rather than set to `enabled: false` — absence is the
 * disabled state, so a sweep has nothing to garbage-collect." Every revocation
 * path below therefore calls `deleteByKey`, and {@link GrantStore.isLive} treats a
 * missing row and a lapsed row identically.
 *
 * ## Expiry is evaluated twice, on purpose
 *
 * §6.3: "Expiry is evaluated **lazily on read** (so a grant is never honoured
 * past its deadline even if the sweep is late) **plus** a boot sweep and an hourly
 * sweep whose only job is emitting the events that keep the UI honest."
 *
 * So {@link GrantStore.isLive} refuses a lapsed grant *without writing anything* —
 * a read that mutated would make the machine's behaviour depend on who read last,
 * and would rob the sweep of the events it exists to emit — and
 * {@link GrantStore.sweep} is the only thing that deletes lapsed rows and emits
 * `remote.agent.access.expired`. A machine asleep through a deadline therefore
 * still refuses the launch on waking, whether or not the sweep has run yet.
 */
import type { Logger } from 'pino';

import type { AgentsRepository, Clock, SettingsRepository } from '../../storage/index.js';
import { isoTimestamp } from '../../storage/index.js';
import type { EventBus } from '../types.js';

/** §6.1's key space. One row per agent, under this prefix. */
export const AGENT_ACCESS_PREFIX = 'remote.agentAccess.';

/** The three persisted events of §7.2 / IMPLEMENTATION §8. */
export const GRANT_GRANTED_EVENT = 'remote.agent.access.granted';
export const GRANT_REVOKED_EVENT = 'remote.agent.access.revoked';
export const GRANT_EXPIRED_EVENT = 'remote.agent.access.expired';

/** Where a grant came from (§6.1's value shape). */
export type GrantOrigin = 'local' | 'remote';

/** Why a grant ended — carried on `remote.agent.access.revoked` (§6.3). */
export type RevokeReason =
  /** The roster board card or the remote settings screen, either listener. */
  | 'toggled_off'
  /** Roster archived, deleted or purged the agent (`roster.changed`). */
  | 'agent_gone'
  /** §4.5: the last active token went, so no remote identity exists. */
  | 'last_token_revoked';

/** §6.1's stored value, exactly. */
export interface GrantValue {
  readonly enabled: true;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly grantedVia: GrantOrigin;
  /** The token that asked, when a remote client did the asking. */
  readonly tokenId?: string;
}

/** One row as `GET /api/remote/agents` reports it (§5, §12 contract 4). */
export interface GrantView {
  readonly agentId: string;
  readonly agentName: string | null;
  readonly enabled: boolean;
  readonly grantedAt: string;
  /** §12 contract 4: "a grant with an invisible deadline is a grant the user will be surprised by." */
  readonly expiresAt: string;
  readonly grantedVia: GrantOrigin;
  readonly tokenId: string | null;
}

export interface GrantStore {
  /** The key this store uses for an agent. Exposed so tests read the real one. */
  key(agentId: string): string;
  /**
   * Whether `agentId` may be put to work by a remote client right now.
   *
   * Lazy expiry: a row past its deadline answers `false` and is left for the
   * sweep to delete and announce.
   */
  isLive(agentId: string, at: number): boolean;
  /** The stored value, honest about expiry (`undefined` when lapsed or absent). */
  get(agentId: string, at: number): GrantValue | undefined;
  /**
   * Grants, or slides an existing grant's deadline (§6.3: "measured from the last
   * remote start of that agent (sliding, not fixed)").
   *
   * @returns the value written.
   */
  grant(
    agentId: string,
    at: number,
    detail: { readonly via: GrantOrigin; readonly tokenId?: string | undefined },
  ): GrantValue;
  /** Slides the deadline of a live grant. A no-op when there is none. */
  touch(agentId: string, at: number): boolean;
  /** Deletes the row and emits `.revoked`. `false` when there was nothing to end. */
  revoke(agentId: string, reason: RevokeReason): boolean;
  /** §4.5's "revoking the last active token clears every per-agent grant". */
  revokeAll(reason: RevokeReason): readonly string[];
  /** Deletes every lapsed row and emits `.expired` for each. Returns their ids. */
  sweep(at: number): readonly string[];
  /** Every live grant, newest deadline last (settings order is by key). */
  list(at: number): readonly GrantView[];
}

export interface GrantStoreDeps {
  readonly settings: SettingsRepository;
  /** Names for the `409` body and the list view; never an authorisation input. */
  readonly agents: Pick<AgentsRepository, 'get'>;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly logger: Logger;
  /** `remote.agentAccess.ttlHours` (§6.3, default 72). */
  readonly ttlHours: number;
}

/** True when a stored value is well-formed enough to be honoured. */
function isGrantValue(value: unknown): value is GrantValue {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['enabled'] === true &&
    typeof record['grantedAt'] === 'string' &&
    typeof record['expiresAt'] === 'string'
  );
}

/**
 * Whether a deadline has passed.
 *
 * Inclusive, and an unparseable timestamp counts as lapsed — the same rule token
 * expiry uses, for the same reason: a permission whose lifetime cannot be
 * established has no established lifetime.
 */
export function hasLapsed(expiresAt: string, at: number): boolean {
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return true;
  return deadline <= at;
}

export function createGrantStore(deps: GrantStoreDeps): GrantStore {
  const ttlMs = Math.max(1, Math.round(deps.ttlHours * 3_600_000));

  const key = (agentId: string): string => `${AGENT_ACCESS_PREFIX}${agentId}`;
  const agentIdOf = (settingKey: string): string => settingKey.slice(AGENT_ACCESS_PREFIX.length);
  const nameOf = (agentId: string): string | null => deps.agents.get(agentId)?.name ?? null;

  const read = (agentId: string): GrantValue | undefined => {
    const value = deps.settings.get<unknown>(key(agentId));
    return isGrantValue(value) ? value : undefined;
  };

  const emit = (type: string, agentId: string, payload: Record<string, unknown>): void => {
    deps.bus.emit({ type, persist: true, ids: { agentId }, payload: { agentId, ...payload } });
  };

  return {
    key,

    get: (agentId, at) => {
      const value = read(agentId);
      if (value === undefined) return undefined;
      return hasLapsed(value.expiresAt, at) ? undefined : value;
    },

    isLive: (agentId, at) => {
      const value = read(agentId);
      return value !== undefined && !hasLapsed(value.expiresAt, at);
    },

    grant: (agentId, at, detail) => {
      const existing = read(agentId);
      const value: GrantValue = {
        enabled: true,
        // A slide keeps the original consent moment: "granted at" is when the
        // user agreed, and rewriting it would erase that from the audit trail.
        grantedAt:
          existing !== undefined && !hasLapsed(existing.expiresAt, at)
            ? existing.grantedAt
            : isoTimestamp(new Date(at)),
        expiresAt: isoTimestamp(new Date(at + ttlMs)),
        grantedVia: detail.via,
        ...(detail.tokenId === undefined ? {} : { tokenId: detail.tokenId }),
      };
      deps.settings.set(key(agentId), value, isoTimestamp(new Date(at)));
      deps.logger.info(
        { agentId, grantedVia: value.grantedVia, expiresAt: value.expiresAt },
        'granted remote access for an agent',
      );
      emit(GRANT_GRANTED_EVENT, agentId, {
        agentName: nameOf(agentId),
        grantedAt: value.grantedAt,
        expiresAt: value.expiresAt,
        grantedVia: value.grantedVia,
        tokenId: value.tokenId ?? null,
      });
      return value;
    },

    touch: (agentId, at) => {
      const value = read(agentId);
      if (value === undefined || hasLapsed(value.expiresAt, at)) return false;
      const slid: GrantValue = { ...value, expiresAt: isoTimestamp(new Date(at + ttlMs)) };
      deps.settings.set(key(agentId), slid, isoTimestamp(new Date(at)));
      return true;
    },

    revoke: (agentId, reason) => {
      const existing = read(agentId);
      // Deleted whether or not the row parsed: absence is the disabled state, and
      // a malformed row is one nobody should be able to leave behind.
      const had = deps.settings.has(key(agentId));
      if (!had) return false;
      deps.settings.deleteByKey(key(agentId));
      deps.logger.warn({ agentId, reason }, 'revoked remote access for an agent');
      emit(GRANT_REVOKED_EVENT, agentId, {
        agentName: nameOf(agentId),
        reason,
        expiresAt: existing?.expiresAt ?? null,
      });
      return true;
    },

    revokeAll: (reason) => {
      const ended: string[] = [];
      for (const record of deps.settings.listByPrefix<unknown>(AGENT_ACCESS_PREFIX)) {
        const agentId = agentIdOf(record.key);
        deps.settings.deleteByKey(record.key);
        ended.push(agentId);
        emit(GRANT_REVOKED_EVENT, agentId, { agentName: nameOf(agentId), reason, expiresAt: null });
      }
      if (ended.length > 0) {
        deps.logger.warn(
          { reason, agents: ended.length },
          'cleared every per-agent remote access grant',
        );
      }
      return ended;
    },

    sweep: (at) => {
      const expired: string[] = [];
      for (const record of deps.settings.listByPrefix<unknown>(AGENT_ACCESS_PREFIX)) {
        const value = record.value;
        const lapsed = !isGrantValue(value) || hasLapsed(value.expiresAt, at);
        if (!lapsed) continue;
        const agentId = agentIdOf(record.key);
        deps.settings.deleteByKey(record.key);
        expired.push(agentId);
        emit(GRANT_EXPIRED_EVENT, agentId, {
          agentName: nameOf(agentId),
          expiresAt: isGrantValue(value) ? value.expiresAt : null,
        });
      }
      if (expired.length > 0) {
        deps.logger.info({ agents: expired.length }, 'per-agent remote access grants expired');
      }
      return expired;
    },

    list: (at) => {
      const views: GrantView[] = [];
      for (const record of deps.settings.listByPrefix<unknown>(AGENT_ACCESS_PREFIX)) {
        const value = record.value;
        if (!isGrantValue(value)) continue;
        // Lapsed rows are omitted rather than shown as disabled: the list is "what
        // is currently allowed", and the read-time rule is the same one the gate
        // applies, so the UI and the enforcement can never disagree.
        if (hasLapsed(value.expiresAt, at)) continue;
        const agentId = agentIdOf(record.key);
        views.push({
          agentId,
          agentName: nameOf(agentId),
          enabled: true,
          grantedAt: value.grantedAt,
          expiresAt: value.expiresAt,
          grantedVia: value.grantedVia,
          tokenId: value.tokenId ?? null,
        });
      }
      return views;
    },
  };
}
