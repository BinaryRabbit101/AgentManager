/**
 * The launch flow's permission preview, and the **one** seam it comes through
 * (DESIGN §6, §4; roster §9.1).
 *
 * §4: "It never composes permissions. The effective set comes from
 * `POST /api/roster/agents/:id/validate`. Roster is the sole composer." So this
 * file asks that route and renders what comes back — it has no compiler, no
 * merge, and no fallback that invents a set.
 *
 * ## The degrade this file used to hold open, now closed
 *
 * `POST /api/roster/agents/:id/validate` was roster M8 and was not mounted when
 * ui M3 shipped, so the panel degraded to one sentence — "permission preview
 * available soon" — rather than guessing a set. The route has landed
 * (roster `validate.test.ts` pins the `{ effective, diagnostics }` shape this
 * file reads), so as of ui M8 there is no degrade: a refusal is a refusal and is
 * shown with the server's own message.
 *
 * The elevation banner never depended on any of that and still does not: it is
 * read from the *project's* `defaults.permissionElevation` and from
 * `policy.allowPermissionElevation`, neither of which is roster's. That is the
 * half §6 says is "never collapsed", and it is the half that exists to prevent
 * invisible privilege escalation.
 *
 * This is still **the** accessor — the launch flow (§6) and the agent detail
 * page (§7.3) both come through it, because roster is the sole composer and two
 * implementations of "what will this agent be allowed to do" is one too many.
 */

import type { ApiClient } from '../api/client';
import type { Diagnostic, PermissionElevation } from '../api/types';

/** roster's `EffectivePermissions`, total by construction (roster contracts). */
export interface EffectivePermissions {
  readonly mode: string;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
  /** The elevation that was **applied**, or `null`. */
  readonly elevation: PermissionElevation | null;
}

export interface ValidateResponse {
  readonly effective: EffectivePermissions;
  readonly diagnostics?: readonly Diagnostic[];
}

export type PermissionPreview =
  | {
      readonly state: 'ready';
      readonly effective: EffectivePermissions;
      readonly diagnostics: readonly Diagnostic[];
    }
  /** Roster refused, or answered something that is not a compiled set. */
  | { readonly state: 'failed'; readonly message: string };

/** What is said when a `200` carries no `effective` — a contract break, not a state. */
export const PREVIEW_MALFORMED_NOTE =
  'The core answered the permission preview without an effective set.';

/**
 * The one accessor. `agentId` × `projectId` in, roster's compiled set out.
 *
 * Every failure is a failure: "roster refused to compile this" is worth
 * interrupting a launch for, and it is now the only thing a non-`200` can mean.
 */
export async function fetchPermissionPreview(
  client: ApiClient,
  agentId: string,
  projectId: string,
): Promise<PermissionPreview> {
  const result = await client.request<ValidateResponse>(
    `/roster/agents/${encodeURIComponent(agentId)}/validate`,
    { method: 'POST', body: { projectId } },
  );

  if (result.kind === 'ok') {
    const value = result.value;
    if (value === undefined || value.effective === undefined) {
      return { state: 'failed', message: PREVIEW_MALFORMED_NOTE };
    }
    return {
      state: 'ready',
      effective: value.effective,
      diagnostics: value.diagnostics ?? [],
    };
  }

  return { state: 'failed', message: result.message };
}

/**
 * The always-visible half of §6, computed from facts roster does not own.
 *
 * - A project declaring `defaults.permissionElevation` shows the widened rules
 *   **and the mandatory reason**, before launch and again in the session header.
 * - With `policy.allowPermissionElevation: false` — the work edition — the same
 *   banner renders **disabled** with "not permitted on this machine (work
 *   edition)". Shown disabled with a reason, not hidden (§6, §13.5).
 */
export interface ElevationBanner {
  readonly elevation: PermissionElevation | null;
  readonly permitted: boolean;
  readonly disabledReason: string | null;
  /** Which config layer set `policy.allowPermissionElevation` (§13.5). */
  readonly layer: string | null;
}

export function elevationBanner(
  elevation: PermissionElevation | undefined,
  allowPermissionElevation: boolean,
  layer: string | undefined,
): ElevationBanner {
  return {
    elevation: elevation ?? null,
    permitted: allowPermissionElevation,
    disabledReason: allowPermissionElevation
      ? null
      : 'not permitted on this machine (work edition)',
    layer: layer ?? null,
  };
}
