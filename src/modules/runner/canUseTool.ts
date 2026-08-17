/**
 * Runner's `canUseTool` callback (runner DESIGN §5.1, D10) — M3's half of it.
 *
 * Roster composes permissions and deliberately does **not** set
 * `options.canUseTool` (roster §6.1: "the callback itself is installed by the
 * runner"); it hands over a `CanUseToolPolicy` instead. By the verified
 * evaluation order, anything reaching this callback has already survived the
 * deny rules and already failed to be auto-approved — so the callback is the
 * escalation point for an *undecided* call, never a place where a rule is
 * evaluated. **Runner matches no rule patterns and consults no rule set.**
 *
 * M7 turns the escalation into the question bridge: raise a card, hold for
 * `runner.question.holdMs`, deliver the answer inside the pending tool call.
 * Until then the only correct behaviour is roster's stated terminal fallback —
 * *deny*, with roster's own message — which is exactly what "default-deny is the
 * outcome whenever no human answers" means.
 *
 * ## SDK-NOTES G5, which is why this function has no branches that fall off the
 * end
 *
 * > "Return `null` ONLY after the consumer has already sent the control_response
 * > out-of-band… **an accidental null means no control_response is sent and the
 * > tool stays blocked indefinitely — permission prompts have no park
 * > deadline.**"
 *
 * The adapter is therefore **total**: every path returns an allow or a deny, and
 * the type below cannot express `null`. The one place a `null` could ever be
 * correct — an out-of-band response — is not a thing runner does.
 */
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import type { CanUseToolPolicyView } from './contracts.js';

export interface DefaultDenyDeps {
  /** roster's compiled policy, read rather than re-derived (roster §6.1). */
  readonly policy: CanUseToolPolicyView;
  /** Observability only: which calls reached the callback, and were denied. */
  readonly onDenied?: (toolName: string, detail: { readonly toolUseId: string }) => void;
}

/**
 * The default-deny callback M3 installs.
 *
 * Returns a `PermissionResult`, never `null`, and never a promise that can
 * reject: a throw out of `canUseTool` would leave the control request
 * unanswered, which is G5's failure in a different costume.
 */
export function createDefaultDenyCanUseTool(deps: DefaultDenyDeps): CanUseTool {
  return (toolName, _input, options) => {
    const denial: PermissionResult = {
      behavior: 'deny',
      message: deps.policy.denyMessage,
      // No `interrupt`: an ordinary denial lets the turn continue and lets the
      // agent report what it could not do. §5.4's parking denial is the one that
      // interrupts, and it belongs to M7.
      toolUseID: options.toolUseID,
    };
    try {
      deps.onDenied?.(toolName, { toolUseId: options.toolUseID });
    } catch {
      // An observer that throws must not wedge a tool call (G5).
    }
    return Promise.resolve(denial);
  };
}
