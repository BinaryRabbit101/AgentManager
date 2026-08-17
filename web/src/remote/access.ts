/**
 * Remote parity, as data (DESIGN §13.4, §3.1, §3.2; IMPLEMENTATION §10).
 *
 * §13.4's table is four rules and one principle, and the principle is what this
 * file encodes: **a denied control is shown disabled with its reason, and the
 * set of denied controls is read from the server**, not hardcoded — "so a
 * future denial greys the right control automatically" (remote §12.7).
 *
 * Everything here is pure, so the parity rules can be asserted without a
 * screen, and the screens can be asserted without a listener.
 */

import type { ApiClient } from '../api/client';
import type { DenyListEntry, RemoteGrantView, RemoteStatus, RemoteTokenView } from '../api/types';
import { TOKEN_EXPIRY_BANNER_DAYS } from '../api/types';

/**
 * Whether this client is talking over the tailnet.
 *
 * §3.1: a bearer is attached "**when a token is held** — in Electron and at
 * `127.0.0.1` there is none, because foundation §6.4 pins that the local
 * listener has no authentication". So holding a token *is* the definition of
 * being remote, and there is no second signal to keep in step with it.
 */
export function isRemoteClient(client: Pick<ApiClient, 'token'>): boolean {
  const token = client.token;
  return token !== null && token !== '';
}

/** A control this screen offers, named the way the route table names it. */
export interface ControlRoute {
  readonly method: string;
  readonly path: string;
}

function matchesPattern(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  if (pattern.endsWith('/**')) return path.startsWith(pattern.slice(0, -2));
  return false;
}

/**
 * The deny entry that covers `control`, or `undefined` when nothing does.
 *
 * Both halves of remote's list are consulted — the routes that declared
 * `remote: 'deny'` and the backstop patterns — because §13.4 says the set is
 * "the deny list enumerated in `GET /api/remote/status`", and the status body
 * carries both.
 */
export function denialFor(
  status: RemoteStatus | undefined,
  control: ControlRoute,
): DenyListEntry | undefined {
  if (status === undefined) return undefined;
  const declared = status.deniedRemotely.find(
    (entry) => entry.method === control.method && matchesPattern(entry.path, control.path),
  );
  if (declared !== undefined) return declared;
  const backstop = status.backstopPatterns.find(
    (entry) =>
      entry.methods.includes(control.method) && matchesPattern(entry.pattern, control.path),
  );
  if (backstop === undefined) return undefined;
  return {
    method: control.method,
    path: control.path,
    source: 'backstop',
    reason: 'This is refused over the tailnet; do it at the machine itself.',
    conditional: false,
  };
}

/**
 * Whether a control is disabled *here*, and why (§13.4, §13.5).
 *
 * Locally nothing is denied — the deny list is a property of the transport, not
 * of the capability — so this asks about the transport first. The reason is
 * always the server's own words when there are any, because "never produce a
 * raw 403 to the user" means the user reads the sentence the server would have
 * sent, before the request is made rather than after.
 */
export interface ControlState {
  readonly disabled: boolean;
  readonly reason: string | undefined;
}

export function controlState(
  status: RemoteStatus | undefined,
  remote: boolean,
  control: ControlRoute,
): ControlState {
  if (!remote) return { disabled: false, reason: undefined };
  const denial = denialFor(status, control);
  if (denial === undefined) return { disabled: false, reason: undefined };
  return { disabled: true, reason: denial.reason };
}

/**
 * runner §15.3 #17, which has no server-side half.
 *
 * The route is the same route on both listeners and runner's own comment says
 * the lower-only rule is "left to remote's policy layer", where it is *not*
 * implemented: a remote client can raise the cap today. So the UI is the only
 * place the rule exists, and it is applied honestly — the control is disabled
 * with the reason rather than pretending a refusal that would not come.
 */
export const CAPACITY_RAISE_REASON =
  'A remote client may lower the cap but not raise it. Raise it at the machine itself.';

export function canRaiseCapacity(remote: boolean): boolean {
  return !remote;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until `iso`, or `undefined` when it never expires. */
export function daysUntil(iso: string | null, now: number): number | undefined {
  if (iso === null) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  return Math.floor((at - now) / DAY_MS);
}

/**
 * remote §4.4's banner: raised at 14 days, and never silent (§3.2 step 4).
 *
 * Only the token this client is *using* matters, and the client cannot tell
 * which row that is — it holds a secret, not an id. So the banner is raised
 * from the soonest expiry among the tokens that are still live, which is the
 * conservative reading and the one that cannot leave a user stranded.
 */
export function tokenExpiryWarning(
  tokens: readonly RemoteTokenView[],
  now: number,
): { readonly days: number; readonly label: string } | undefined {
  const live = tokens.filter((token) => token.revokedAt === null && !token.expired);
  const soonest = live
    .map((token) => ({ token, days: daysUntil(token.expiresAt, now) }))
    .filter((entry): entry is { token: RemoteTokenView; days: number } => entry.days !== undefined)
    .sort((left, right) => left.days - right.days)[0];
  if (soonest === undefined || soonest.days > TOKEN_EXPIRY_BANNER_DAYS) return undefined;
  return {
    days: soonest.days,
    label:
      soonest.days <= 0
        ? `The device token “${soonest.token.label}” has expired. Pair again at the machine.`
        : `The device token “${soonest.token.label}” expires in ${String(soonest.days)} day${
            soonest.days === 1 ? '' : 's'
          }. Create a new one at the machine before it does.`,
  };
}

/**
 * §13.2: "Expiry is always shown — a grant with an invisible deadline is a
 * grant the user will be surprised by."
 */
export function grantExpiryLabel(grant: Pick<RemoteGrantView, 'expiresAt'>, now: number): string {
  const days = daysUntil(grant.expiresAt, now);
  if (days === undefined) return 'expiry unknown';
  if (days < 0) return 'expired';
  if (days === 0) {
    const hours = Math.max(0, Math.floor((Date.parse(grant.expiresAt) - now) / (60 * 60 * 1000)));
    return hours <= 0 ? 'expires within the hour' : `expires in ${String(hours)}h`;
  }
  return `expires in ${String(days)} day${days === 1 ? '' : 's'}`;
}

/**
 * §13.2's listener line, including the `waiting` case.
 *
 * "The `waiting` state renders Tailscale's **own** state string … because that
 * is the string that tells the user what to do." So the sentence carries it
 * verbatim rather than translating it into something friendlier and emptier.
 */
export function listenerLine(status: RemoteStatus): string {
  switch (status.state) {
    case 'listening':
      return status.boundAddress === null
        ? 'Listening.'
        : `Listening on ${status.boundAddress.address}:${String(status.boundAddress.port)}${
            status.magicDnsName === null ? '' : ` (${status.magicDnsName})`
          }.`;
    case 'binding':
      return 'Binding the listener…';
    case 'waiting':
      return `Remote access unavailable — Tailscale is ${status.tailscaleState ?? 'not detected'}.`;
    case 'down':
      return status.lastError === null
        ? 'The listener is down.'
        : `The listener is down: ${status.lastError}`;
  }
}
