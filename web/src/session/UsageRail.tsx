/**
 * The usage rail (DESIGN §9.2, §4; runner §7.3/§15.2 #13, orchestrator §16.8).
 *
 * Three sentences decide everything in this file:
 *
 * > "live input/output tokens from `session.usage`, the assignment budget bar in
 * > **tokens**, and — labelled exactly — **'estimated model cost'** for
 * > `session_usage.cost_usd`, with a tooltip stating it is a client-side estimate
 * > from a bundled price table and not a charge. It is never summed into anything
 * > that reads like an invoice."
 *
 * > "It never shows a plan-window percentage or a 'remaining quota'."
 *
 * > "It never presents a dollar figure as spend."
 *
 * So: **tokens are the primary unit**, the dollar figure appears once and only
 * under that exact label, and the words "remaining", "% of plan" and "quota" do
 * not appear — which IMPLEMENTATION §4 asserts as a literal string check over the
 * rendered output, and {@link FORBIDDEN_USAGE_STRINGS} is what that check reads.
 */

import type { ReactElement } from 'react';

import type { SessionUsageTotals } from '../api/types';

/**
 * The strings the rendered rail must never contain (§4, §18 #11).
 *
 * Exported so the assertion lives beside the rule rather than in a test's head:
 * "a well-meaning future change cannot reintroduce a quota gauge".
 */
export const FORBIDDEN_USAGE_STRINGS: readonly string[] = [
  'remaining',
  '% of plan',
  'quota',
  'spend',
  'spent',
  'bill',
  'charge',
];

/** The one label a dollar figure may ever carry in this app. */
export const COST_LABEL = 'estimated model cost';

export const COST_TOOLTIP =
  'A client-side estimate from a bundled price table. It is not a charge, and under a Claude ' +
  'subscription it corresponds to no dollar amount at all.';

function tokens(value: number): string {
  return value.toLocaleString('en-US');
}

export interface UsageRailProps {
  readonly usage: SessionUsageTotals | null;
  /** orchestrator §16.8's budget, in tokens. Absent until the assignment view (M9). */
  readonly budget?: { readonly used: number; readonly total: number } | undefined;
}

export function UsageRail({ usage, budget }: UsageRailProps): ReactElement {
  return (
    <aside className="usage-rail" aria-labelledby="usage-rail-heading">
      <h3 id="usage-rail-heading">Usage</h3>

      {usage === null ? (
        <p className="empty">Nothing metered yet.</p>
      ) : (
        <dl className="usage-rail__figures">
          {/* Tokens first, and largest: they are the unit (§16.8). */}
          <dt>Input tokens</dt>
          <dd data-primary="true">{tokens(usage.inputTokens)}</dd>
          <dt>Output tokens</dt>
          <dd data-primary="true">{tokens(usage.outputTokens)}</dd>
          <dt>Cache read</dt>
          <dd>{tokens(usage.cacheReadTokens)}</dd>
          <dt>Cache write</dt>
          <dd>{tokens(usage.cacheCreationTokens)}</dd>
          <dt>Turns</dt>
          <dd>{tokens(usage.turns)}</dd>
          {usage.costUsdEstimate === null ? null : (
            <>
              <dt title={COST_TOOLTIP}>{COST_LABEL}</dt>
              <dd data-primary="false" title={COST_TOOLTIP}>
                ${usage.costUsdEstimate.toFixed(4)}
              </dd>
            </>
          )}
        </dl>
      )}

      {budget === undefined ? null : (
        <div className="usage-rail__budget">
          <p>
            {tokens(budget.used)} of {tokens(budget.total)} tokens
          </p>
          <div
            className="usage-rail__bar"
            role="img"
            aria-label={`${tokens(budget.used)} of ${tokens(budget.total)} tokens used`}
          >
            <span
              style={{
                width: `${String(Math.min(100, Math.round((budget.used / Math.max(1, budget.total)) * 100)))}%`,
              }}
            />
          </div>
        </div>
      )}
    </aside>
  );
}
