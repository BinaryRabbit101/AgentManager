/**
 * The launch flow's permission preview, and the **one** seam it comes through
 * (DESIGN §6, §4; roster §9.1).
 *
 * §4: "It never composes permissions. The effective set comes from
 * `POST /api/roster/agents/:id/validate`. Roster is the sole composer." So this
 * file asks that route and renders what comes back — it has no compiler, no
 * merge, and no fallback that invents a set.
 *
 * ## The gap this file exists to hold open
 *
 * `POST /api/roster/agents/:id/validate` is **roster M8** and is not mounted
 * yet: roster's route table calls `/draft`, `/export`, `/import` and `/validate`
 * "deliberately absent rather than stubbed". Until it lands the preview cannot
 * be shown, and §3.5's rule — "never by probing for a 404" — is about
 * *capabilities the config declares*, not about a sibling milestone that has not
 * shipped, which no config flag describes. So the degrade is:
 *
 * - ask once per agent × project;
 * - a `404` (or a `405`) means the route does not exist yet → the panel is
 *   replaced by one sentence, "permission preview available soon", and nothing
 *   is guessed;
 * - **the elevation banner keeps working regardless**, because it is read from
 *   the *project's* `defaults.permissionElevation` (`GET /api/projects/:id`) and
 *   from `policy.allowPermissionElevation`, neither of which is roster's. That is
 *   the half §6 says is "never collapsed", and it is the half that exists to
 *   prevent invisible privilege escalation — so it must not depend on M8.
 *
 * **TODO(roster M8)**: when `/validate` is mounted, nothing above the
 * {@link fetchPermissionPreview} call changes — the route answering `200` is all
 * it takes to light the panel up. This is the single accessor; there is no other
 * caller.
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
  /** The M8 gap: the route is not there. One sentence, no guess. */
  | { readonly state: 'unavailable'; readonly note: string }
  /** The route is there and refused. The server's message, verbatim (§3.1). */
  | { readonly state: 'failed'; readonly message: string };

export const PREVIEW_UNAVAILABLE_NOTE = 'permission preview available soon';

/**
 * The one accessor. `agentId` × `projectId` in, roster's compiled set out.
 *
 * A `404`/`405` is the not-yet-mounted case and is reported as `unavailable`
 * rather than as an error, because "the route does not exist in this build" and
 * "roster refused to compile this" are different facts and the second one is
 * worth interrupting a launch for.
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
      return { state: 'unavailable', note: PREVIEW_UNAVAILABLE_NOTE };
    }
    return {
      state: 'ready',
      effective: value.effective,
      diagnostics: value.diagnostics ?? [],
    };
  }

  if (result.kind === 'error' && (result.status === 404 || result.status === 405)) {
    return { state: 'unavailable', note: PREVIEW_UNAVAILABLE_NOTE };
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
