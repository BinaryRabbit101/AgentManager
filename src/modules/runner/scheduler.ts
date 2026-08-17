/**
 * The scheduler (runner DESIGN §6) — milestone M5.
 *
 * M3 admitted one session at a time from a hard-coded constant. This is the real
 * thing: the **weighted** concurrency cap, §6.2's two priority bands, blocked
 * entries waiting on a workspace, the `settings`-backed runtime capacity
 * override, and §6.4's rate-limit cool-down. It owns *when* a queued session
 * runs and nothing else — the launch chain still owns what running one means.
 *
 * ## The cap is on the sum of weights, not the count (§6.1)
 *
 * Weight comes from roster's `defaults.concurrencyWeight` and is copied onto
 * `sessions.weight` at enqueue, "so a heavy agent declared `concurrencyWeight:
 * 2` occupies the whole cap at the default setting". One exception, and it is
 * deliberate: a session whose weight *exceeds* the whole cap still runs when
 * nothing else is running. The alternative is a row that can never be admitted
 * and never explains why.
 *
 * ## Strict FIFO within a band, including when the head does not fit
 *
 * §6.2 pins "two priority bands, FIFO by `queued_at` within each" and §6.3 rules
 * out preemption. A work-conserving scheduler that skipped past a weight-2 head
 * to start a weight-1 session behind it would be neither FIFO nor fair: on a
 * busy queue the heavy session never starts, and nothing in the UI says so. So
 * when the head does not fit, the scheduler waits. With a cap of 2 and no
 * aging, that is a queue whose order a human can predict, which is the property
 * §6.2 chose bands for in the first place.
 *
 * ## Cool-down is a gate on admissions only (§6.4)
 *
 * "Running sessions are left alone; queued sessions stay queued." Backoff
 * doubles per consecutive hit up to `rateLimit.maxCooldownMs`, a reset time
 * reported by the CLI wins over the backoff, and **any successful session start
 * clears it** — because the authoritative signal that the window reopened is a
 * session that started.
 */
import type { Clock, SettingsRepository } from '../../storage/index.js';

import { MAX_CONCURRENT_LIMIT, type RunnerConfig } from './config.js';
import type { RateLimitSource } from './messages.js';
import type { RunnerSessionRecord, SessionPriority, SessionRepository } from './repository.js';

export type { RateLimitSource };

/** The `settings` key §6.1 pins for the runtime override. */
export const CAPACITY_SETTING_KEY = 'runner.maxConcurrent';

/** §6.2's bands, ranked. `interactive` means a human is waiting. */
export function bandRank(priority: SessionPriority): number {
  return priority === 'interactive' ? 0 : 1;
}

/** What `GET /api/runner/queue` and `runner.queue.changed` report (§10, §11.2). */
export interface QueueState {
  readonly running: number;
  /** Queued and admissible — blocked entries are counted separately. */
  readonly queued: number;
  readonly blocked: number;
  readonly capacity: number;
  /** Sum of the weights currently occupying the cap. */
  readonly usedWeight: number;
  readonly cooling: boolean;
  readonly coolingUntil: string | null;
}

/** One row of the queue panel. */
export interface QueueEntry {
  readonly sessionId: string;
  readonly assignmentId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly status: 'running' | 'queued';
  readonly priority: SessionPriority;
  readonly weight: number;
  readonly queuedAt: string | null;
  readonly blockedReason: string | null;
  /** Position within the admission order; `null` for a running session. */
  readonly position: number | null;
}

export interface RateLimitHit {
  readonly source: RateLimitSource;
  /** From a `rate_limit_event`, when the CLI volunteered one — it beats the backoff. */
  readonly resetsAt?: Date | undefined;
  readonly hint?: string | undefined;
}

export type SchedulerLog = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  detail?: Record<string, unknown>,
) => void;

export interface SchedulerDeps {
  readonly sessions: SessionRepository;
  readonly config: Pick<RunnerConfig, 'maxConcurrent' | 'workspaceWaitMinutes' | 'rateLimit'>;
  /** Foundation's `settings` — config is immutable per process, this is not (§6.1). */
  readonly settings: Pick<SettingsRepository, 'get' | 'set'>;
  readonly clock: Clock;
  /** The launch chain's `runSession`. Resolves when the session is no longer live. */
  readonly run: (sessionId: string) => Promise<void>;
  /** A blocked entry that outlived `workspaceWaitMinutes` (§3.2 row 4). */
  readonly onBlockedExpired: (sessionId: string, reason: string) => void;
  /** Fires after every state change, for `runner.queue.changed` (§10). */
  readonly onChanged?: ((state: QueueState) => void) | undefined;
  /** `runner.ratelimited`, persisted (§10). */
  readonly onRateLimited?:
    ((payload: { until: string; source: RateLimitSource; hint: string }) => void) | undefined;
  /** Called after a session leaves the active set, before the next admission. */
  readonly onSettled?: ((sessionId: string) => void) | undefined;
  readonly log?: SchedulerLog | undefined;
}

export interface Scheduler {
  /** Re-runs admission. Safe to call from anywhere, including re-entrantly. */
  evaluate(): void;
  /** A retryable workspace refusal: keeps the row `queued`, frees the slot (§6.2). */
  block(sessionId: string, reason: string): void;
  /** `workspace.released`: every blocked entry becomes eligible again (§6.2). */
  unblockAll(): void;
  /** A session reached `running` — §6.4's cool-down reset. */
  noteStarted(): void;
  /** An observed rate limit (§6.4). */
  noteRateLimit(hit: RateLimitHit): void;
  isActive(sessionId: string): boolean;
  activeCount(): number;
  activeWeight(): number;
  /** `settings['runner.maxConcurrent'] ?? config`, clamped to 1..8 (§6.1). */
  capacity(): number;
  /** The runtime override. Returns the clamped value actually stored. */
  setCapacity(value: number): number;
  state(): QueueState;
  entries(): readonly QueueEntry[];
  /** Stops admitting. Running sessions are untouched — M9 owns shutdown. */
  stop(): void;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { sessions, config, settings, clock } = deps;
  const log: SchedulerLog = deps.log ?? ((): void => {});

  /** sessionId → weight, for the sessions currently occupying the cap. */
  const active = new Map<string, number>();
  /** sessionId → when it was **first** blocked, for the §3.2 deadline. */
  const blockedSince = new Map<string, number>();

  let admitting = true;
  let evaluating = false;
  let coolingUntil = 0;
  let consecutiveHits = 0;
  let wake: NodeJS.Timeout | undefined;

  function nowMs(): number {
    return clock().getTime();
  }

  function capacity(): number {
    const override = settings.get<number>(CAPACITY_SETTING_KEY);
    const chosen =
      typeof override === 'number' && Number.isFinite(override) ? override : config.maxConcurrent;
    return clampCapacity(chosen);
  }

  function activeWeight(): number {
    let sum = 0;
    for (const weight of active.values()) sum += weight;
    return sum;
  }

  function cooling(): boolean {
    return coolingUntil > nowMs();
  }

  /** The queue in admission order: best band first, oldest first within it. */
  function ordered(): readonly RunnerSessionRecord[] {
    return [...sessions.list({ status: 'queued' })].sort((left, right) => {
      const band = bandRank(left.priority) - bandRank(right.priority);
      if (band !== 0) return band;
      const queued = (left.queuedAt ?? '').localeCompare(right.queuedAt ?? '');
      // Ties are broken by id so the order is total: two sessions enqueued in
      // the same millisecond must still have one answer, or a test that starts
      // two at once is flaky by construction.
      return queued === 0 ? left.id.localeCompare(right.id) : queued;
    });
  }

  function state(): QueueState {
    const queued = sessions.list({ status: 'queued' });
    const blocked = queued.filter((session) => session.blockedReason !== null).length;
    return {
      running: active.size,
      queued: queued.length - blocked,
      blocked,
      capacity: capacity(),
      usedWeight: activeWeight(),
      cooling: cooling(),
      coolingUntil: coolingUntil === 0 ? null : new Date(coolingUntil).toISOString(),
    };
  }

  function announce(): void {
    deps.onChanged?.(state());
  }

  function scheduleWake(atMs: number): void {
    const delay = Math.max(atMs - nowMs(), 0);
    if (wake !== undefined) clearTimeout(wake);
    wake = setTimeout(() => {
      wake = undefined;
      evaluate();
    }, delay);
    // A scheduler timer must never hold the process open (foundation §4.2).
    wake.unref?.();
  }

  /**
   * §3.2 row 4: a blocked entry that waited longer than the design allows.
   *
   * Measured over the **first** refusal, not the latest, and read from the map
   * rather than from `blocked_reason` — `unblockAll` clears that column on every
   * `workspace.released`, so a workspace taken and released once a minute would
   * otherwise reset the deadline for ever and the session would wait silently
   * until `queueStaleHours` noticed it a day later.
   */
  function expireBlocked(): void {
    const deadlineMs = config.workspaceWaitMinutes * 60_000;
    for (const [sessionId, since] of [...blockedSince]) {
      // A session being launched right now is not waiting for anything: the
      // attempt is in flight and will either succeed or block again.
      if (active.has(sessionId)) continue;
      const session = sessions.get(sessionId);
      if (session === undefined || session.status !== 'queued') {
        blockedSince.delete(sessionId);
        continue;
      }
      if (nowMs() - since < deadlineMs) continue;
      blockedSince.delete(sessionId);
      log('warn', 'a queued session waited too long for a workspace', {
        sessionId,
        reason: session.blockedReason,
        waitedMinutes: Math.round((nowMs() - since) / 60_000),
      });
      deps.onBlockedExpired(
        sessionId,
        session.blockedReason ?? 'the workspace was never granted for this assignment',
      );
    }
  }

  function fits(weight: number): boolean {
    const used = activeWeight();
    // Nothing running: admit whatever is at the head, even if its weight is
    // larger than the whole cap. See the header.
    return used === 0 || used + weight <= capacity();
  }

  function admit(session: RunnerSessionRecord): void {
    active.set(session.id, Math.max(session.weight, 1));
    // The wait entry is deliberately **not** cleared here. This attempt may
    // itself end in another retryable refusal, and a deadline that restarted on
    // every attempt would never be reached — which is how a session waits for a
    // workspace for ever while the queue panel says it is merely queued.
    void deps
      .run(session.id)
      .catch((error: unknown) => {
        log('error', 'a session ended in an unhandled failure', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        active.delete(session.id);
        try {
          deps.onSettled?.(session.id);
          evaluate();
        } catch (error) {
          // The session is already over; its bookkeeping must not become an
          // unhandled rejection. The one way to reach here in practice is a
          // shutdown that closed the database between the settle and this tick.
          log('debug', 'the scheduler could not re-evaluate after a session ended', {
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
  }

  function evaluate(): void {
    // Re-entrancy is normal here: `run` can settle synchronously, and its
    // `finally` calls back in. The flag makes the outer loop the one that
    // finishes the pass.
    //
    // Once admission has stopped this is a hard no-op — not merely "admit
    // nothing". After `stop()` the database may already be closing, and a
    // scheduler that still read the queue to announce a state nobody wants
    // would turn a clean shutdown into an unhandled rejection.
    if (evaluating || !admitting) return;
    evaluating = true;
    try {
      expireBlocked();
      if (cooling()) {
        scheduleWake(coolingUntil);
        return;
      }
      for (const session of ordered()) {
        if (session.blockedReason !== null) continue;
        if (active.has(session.id)) continue;
        if (!fits(Math.max(session.weight, 1))) break;
        admit(session);
      }
    } finally {
      evaluating = false;
      announce();
    }
  }

  return {
    evaluate,

    block(sessionId, reason) {
      sessions.patch(sessionId, { blockedReason: reason });
      if (!blockedSince.has(sessionId)) blockedSince.set(sessionId, nowMs());
      announce();
    },

    unblockAll() {
      // Whether an entry is admitted is this scheduler's call; whether it stays
      // blocked is projects' answer the next time it asks. The wait deadline is
      // deliberately **not** reset — it runs from the first refusal, or a
      // workspace that is released and re-taken every minute would keep a
      // session queued for ever.
      for (const session of sessions.list({ status: 'queued' })) {
        if (session.blockedReason !== null) sessions.patch(session.id, { blockedReason: null });
      }
      evaluate();
    },

    noteStarted() {
      if (consecutiveHits === 0 && coolingUntil === 0) return;
      log('info', 'a session started, so the rate-limit cool-down is cleared', {
        hits: consecutiveHits,
      });
      consecutiveHits = 0;
      coolingUntil = 0;
      announce();
      evaluate();
    },

    noteRateLimit(hit) {
      consecutiveHits += 1;
      const backoff = Math.min(
        config.rateLimit.cooldownMs * 2 ** (consecutiveHits - 1),
        config.rateLimit.maxCooldownMs,
      );
      const reported = hit.resetsAt?.getTime();
      const until =
        reported !== undefined && Number.isFinite(reported) && reported > nowMs()
          ? reported
          : nowMs() + backoff;
      coolingUntil = Math.max(coolingUntil, until);
      const hint =
        hit.hint ??
        'Rate limiting was observed. AgentManager shares the plan window with your own Claude ' +
          'usage, so admissions are paused until it clears — running sessions continue.';
      log('warn', 'the scheduler entered a rate-limit cool-down', {
        source: hit.source,
        until: new Date(coolingUntil).toISOString(),
        hits: consecutiveHits,
      });
      deps.onRateLimited?.({
        until: new Date(coolingUntil).toISOString(),
        source: hit.source,
        hint,
      });
      scheduleWake(coolingUntil);
      announce();
    },

    isActive: (sessionId) => active.has(sessionId),
    activeCount: () => active.size,
    activeWeight,
    capacity,

    setCapacity(value) {
      const clamped = clampCapacity(value);
      settings.set(CAPACITY_SETTING_KEY, clamped);
      log('info', 'the runtime concurrency cap changed', { maxConcurrent: clamped });
      evaluate();
      return clamped;
    },

    state,

    entries() {
      const rows: QueueEntry[] = [];
      for (const sessionId of active.keys()) {
        const session = sessions.get(sessionId);
        if (session === undefined) continue;
        rows.push(toEntry(session, 'running', null));
      }
      let position = 0;
      for (const session of ordered()) {
        if (active.has(session.id)) continue;
        position += 1;
        rows.push(toEntry(session, 'queued', position));
      }
      return rows;
    },

    stop() {
      admitting = false;
      if (wake !== undefined) clearTimeout(wake);
      wake = undefined;
    },
  };
}

function toEntry(
  session: RunnerSessionRecord,
  status: 'running' | 'queued',
  position: number | null,
): QueueEntry {
  return {
    sessionId: session.id,
    assignmentId: session.assignmentId,
    agentId: session.agentId,
    projectId: session.projectId,
    status,
    priority: session.priority,
    weight: session.weight,
    queuedAt: session.queuedAt,
    blockedReason: session.blockedReason,
    position,
  };
}

/**
 * §6.1: "clamped to 1..8".
 *
 * Clamped rather than refused, because this is the *runtime* override — a
 * remote client on a flaky link that asks for 12 should get the cap it is
 * allowed to have, with the number it actually got in the response. The
 * configured value is validated instead of clamped (`config.ts`), because a
 * config file is written once and read for ever.
 */
export function clampCapacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_CONCURRENT_LIMIT);
}
