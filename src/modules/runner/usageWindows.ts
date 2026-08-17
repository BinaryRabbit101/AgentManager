/**
 * Usage windows and plan-window honesty (runner DESIGN §7.4, D7, as reconciled
 * by SDK-NOTES **C3**) — milestone M11.
 *
 * ## The one sentence this file exists to keep true
 *
 * **AgentManager cannot know how much of the owner's 5-hour or weekly window is
 * left.** The windows are shared with the owner's interactive Claude Code and
 * claude.ai usage (D2), and nothing this process can read tells it what share
 * of them is ours. So `GET /api/runner/usage` reports facts with their
 * provenance attached and never a derived quota:
 *
 * | Signal | Source | Honesty label |
 * |---|---|---|
 * | Our own consumption, rolling 5-hour and 7-day sums over `usage_events` | our database | `local-estimate` |
 * | Rate-limit telemetry, when the CLI volunteers it | the `rate_limit_event` stream message | `cli-reported` |
 * | Rate-limit hits and the cool-down in effect | our own error classification | `observed` |
 *
 * The payload carries tokens, timestamps and window sources. It carries no
 * percentage, no ratio, no "remaining", and no plan total to compute one from —
 * the ui's usage screen asserts that contract by scanning its own rendered text
 * (ui §12), and the API is the half of it that has to be true first, because a
 * client cannot render a percentage it was never given.
 *
 * ## C3, and why it changes the reasons rather than the rules
 *
 * SDK-NOTES **C3** found that §7.4's stated premise is false against the pinned
 * SDK: plan-window utilization, reset timestamps and the subscription tier *are*
 * programmatically exposed, through
 * `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` and
 * `AccountInfo.subscriptionType`. D7's conclusions survive anyway, and C3 says
 * so in as many words: the method's own documentation promises that its **name
 * will change** when it stabilises, so anything depending on it breaks on an SDK
 * bump; and the numbers describe *the owner's whole plan*, not AgentManager's
 * share of it, so they are still not headroom this app may spend.
 *
 * Two consequences are implemented here, and one is deliberately not:
 *
 * - `rate_limit_event` is **captured**, permissively, into
 *   `settings['runner.rateLimit.lastEvent']` and surfaced as
 *   `rateLimit.cliReported` under the `cli-reported` label. C3 downgrades the
 *   permissive parse from "shape guess" to "version-drift guard", which is why
 *   it stays: the message is typed today and may not be tomorrow.
 * - **No scheduling logic reads any of it.** §6.4's cool-down is driven by the
 *   observed-error path, and M11's acceptance nails that down by running M5's
 *   cool-down suite with the whole handler switched off
 *   (`runner.rateLimit.observeCliEvent: false`) and asserting identical
 *   behaviour.
 * - The experimental usage API is **not** called from any production path. C3
 *   allows an optional `plan` block behind a default-off flag; M11's acceptance
 *   list does not ask for one, and the only honest way to learn what that API
 *   returns is against a live account — which is where it lives, as the
 *   token-gated **L13** check in `__spike__/sdk.spike.test.ts`. Shipping a
 *   read of an API whose name is documented to change, to populate a block no
 *   surface renders, would buy a maintenance liability and no user-visible
 *   truth. Raised rather than absorbed.
 */
import type { Clock, SettingsRepository } from '../../storage/index.js';

import { readRateLimitEvent, type RateLimitEventFacts } from './messages.js';
import type { RateLimitStatus } from './scheduler.js';
import type { SDKMessage } from './sdk.js';
import type { UsageRepository } from './usage.js';

/**
 * The `settings` key §7.4 pins for the CLI's volunteered telemetry.
 *
 * Foundation §1.4 anticipates exactly this key with "last-seen plan-window
 * reset", which is why it is a `settings` row rather than a runner table: it is
 * a single last-writer-wins fact about the installation, not a series.
 */
export const RATE_LIMIT_EVENT_SETTING_KEY = 'runner.rateLimit.lastEvent';

/** The 5-hour window of §7.4, in milliseconds. */
export const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
/** The 7-day window of §7.4, in milliseconds. */
export const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * §7.4's disclaimer, verbatim and non-negotiable.
 *
 * It ships from the API rather than from the client so that every surface —
 * Electron, the tailnet browser, and anything that reads the route directly —
 * says the same true thing, and so that a client cannot quietly drop it in a
 * redesign without the string disappearing from a server test too.
 */
export const USAGE_DISCLAIMER =
  'Counts AgentManager sessions only. Your interactive Claude usage shares the same plan ' +
  'windows and is not visible here.';

/** One window on the wire (§7.4's jsonc, field for field). */
export interface UsageWindowView {
  /** The window's lower bound. The numbers below are "since" this instant. */
  readonly since: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Cache tokens, reported separately because §7.2 excludes them from the
   * budget and §7.1 meters them for cost display. Folding them into
   * `inputTokens` would inflate the honest number with a cheaper one.
   */
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** Distinct sessions that spent inside the window. */
  readonly sessions: number;
}

/**
 * What was recognised on the last `rate_limit_event`, with when we saw it.
 *
 * Every field is nullable because every field is optional in the SDK's own
 * type, and a build that stops sending one must cost a line of display rather
 * than a parse error. `utilization` is reported **as the CLI stated it, about
 * the owner's whole plan** — it is not AgentManager's share of anything and is
 * labelled `cli-reported` on the wire so no client can mistake it for one.
 */
export interface CliReportedRateLimit {
  readonly status: string | null;
  readonly rateLimitType: string | null;
  readonly utilization: number | null;
  readonly resetsAt: string | null;
  /** Our clock, when the message arrived — the CLI does not stamp it. */
  readonly observedAt: string;
}

/** `GET /api/runner/usage` (§7.4, §11.1). */
export interface UsageWindows {
  readonly own: {
    readonly window5h: UsageWindowView;
    readonly window7d: UsageWindowView;
    /** §7.4's honesty label. Constant: this only ever comes from our database. */
    readonly source: 'local-estimate';
  };
  readonly rateLimit: {
    readonly state: 'ok' | 'cooling';
    readonly lastHitAt: string | null;
    readonly resetsAt: string | null;
    /** Absent until the CLI volunteers one, and `null` for ever if it never does. */
    readonly cliReported: CliReportedRateLimit | null;
    /** The label for everything above `cliReported`: our own classification. */
    readonly source: 'observed';
    /** The label for `cliReported`, so the two provenances never blur. */
    readonly cliSource: 'cli-reported';
  };
  readonly disclaimer: string;
}

// ---------------------------------------------------------------------------
// The CLI's volunteered telemetry
// ---------------------------------------------------------------------------

export type UsageLog = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  detail?: Record<string, unknown>,
) => void;

export interface RateLimitEventCaptureDeps {
  readonly settings: Pick<SettingsRepository, 'get' | 'set'>;
  readonly clock: Clock;
  readonly log?: UsageLog | undefined;
}

/**
 * Turns the parsed facts into the stored row.
 *
 * Only what §7.4 calls "whatever is recognised": four fields plus our own
 * timestamp. Unknown members of `rate_limit_info` are dropped rather than
 * stored, so the settings row cannot grow an unbounded blob from an SDK that
 * decides to attach a payment-method summary to a rate-limit notice.
 */
function toStored(facts: RateLimitEventFacts, observedAt: string): CliReportedRateLimit {
  return {
    status: facts.status,
    rateLimitType: facts.rateLimitType,
    utilization: facts.utilization,
    resetsAt: facts.resetsAt?.toISOString() ?? null,
    observedAt,
  };
}

/** A stored value from any build, read back without trusting its shape. */
export function readStoredRateLimitEvent(
  settings: Pick<SettingsRepository, 'get'>,
): CliReportedRateLimit | null {
  let raw: unknown;
  try {
    raw = settings.get(RATE_LIMIT_EVENT_SETTING_KEY);
  } catch {
    // A settings row whose JSON no longer parses is a display this process
    // does without, never a failed usage request.
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const observedAt = record['observedAt'];
  return {
    status: typeof record['status'] === 'string' ? record['status'] : null,
    rateLimitType: typeof record['rateLimitType'] === 'string' ? record['rateLimitType'] : null,
    utilization:
      typeof record['utilization'] === 'number' && Number.isFinite(record['utilization'])
        ? record['utilization']
        : null,
    resetsAt: typeof record['resetsAt'] === 'string' ? record['resetsAt'] : null,
    observedAt: typeof observedAt === 'string' ? observedAt : '',
  };
}

export interface RateLimitEventCapture {
  /**
   * Offers a stream message to the capture.
   *
   * Returns the parsed facts when the message *was* a `rate_limit_event` — the
   * launch chain still needs them for §6.4's presence check — and `undefined`
   * for everything else. **It never throws**: it is called from inside the
   * reader loop, and a shape the parser did not expect must cost a display,
   * not a session.
   */
  capture(message: SDKMessage): RateLimitEventFacts | undefined;
  /** The last stored event, or `null` — read back from `settings`. */
  last(): CliReportedRateLimit | null;
}

export function createRateLimitEventCapture(
  deps: RateLimitEventCaptureDeps,
): RateLimitEventCapture {
  const log: UsageLog = deps.log ?? ((): void => {});

  return {
    capture(message) {
      let facts: RateLimitEventFacts | undefined;
      try {
        facts = readRateLimitEvent(message);
        if (facts === undefined) return undefined;
        deps.settings.set(
          RATE_LIMIT_EVENT_SETTING_KEY,
          toStored(facts, deps.clock().toISOString()),
        );
        log('debug', 'captured a CLI-reported rate-limit event', {
          status: facts.status,
          rateLimitType: facts.rateLimitType,
        });
      } catch (error) {
        // Includes the settings write: an unwritable row is a lost display.
        log('debug', 'a rate_limit_event could not be captured', {
          error: error instanceof Error ? error.message : String(error),
        });
        return facts;
      }
      return facts;
    },

    last: () => readStoredRateLimitEvent(deps.settings),
  };
}

// ---------------------------------------------------------------------------
// The windows
// ---------------------------------------------------------------------------

export interface UsageWindowsDeps {
  readonly usage: Pick<UsageRepository, 'windowSums'>;
  readonly settings: Pick<SettingsRepository, 'get'>;
  /** §7.4's `observed` row — the scheduler's own classification (§6.4). */
  readonly rateLimit: () => RateLimitStatus;
  readonly clock: Clock;
}

/**
 * Builds §7.4's payload on every call.
 *
 * Nothing is cached. The two windows are two indexed reads, and a cache would
 * trade a number that is right for a number that is nearly right — on the one
 * screen whose entire purpose is not overstating what it knows.
 */
export function createUsageWindows(deps: UsageWindowsDeps): () => UsageWindows {
  function window(nowMs: number, spanMs: number): UsageWindowView {
    const sums = deps.usage.windowSums(new Date(nowMs - spanMs).toISOString());
    return {
      since: sums.since,
      inputTokens: sums.tokens.input,
      outputTokens: sums.tokens.output,
      cacheReadTokens: sums.tokens.cacheRead,
      cacheCreationTokens: sums.tokens.cacheCreation,
      sessions: sums.sessions,
    };
  }

  return function usageWindows(): UsageWindows {
    const nowMs = deps.clock().getTime();
    const observed = deps.rateLimit();
    return {
      own: {
        window5h: window(nowMs, WINDOW_5H_MS),
        window7d: window(nowMs, WINDOW_7D_MS),
        source: 'local-estimate',
      },
      rateLimit: {
        state: observed.state,
        lastHitAt: observed.lastHitAt,
        resetsAt: observed.resetsAt,
        cliReported: readStoredRateLimitEvent(deps.settings),
        source: 'observed',
        cliSource: 'cli-reported',
      },
      disclaimer: USAGE_DISCLAIMER,
    };
  };
}
