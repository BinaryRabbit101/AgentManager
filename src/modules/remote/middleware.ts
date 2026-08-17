/**
 * The remote listener's request policy — **M3's placeholder, and deliberately a
 * hard deny.**
 *
 * M3 mounts foundation's route table on a second, tailnet-bound socket
 * (IMPLEMENTATION §3). Bearer-token authentication is M4 and the four-rule policy
 * pipeline of DESIGN §3.1 is M6, which leaves one milestone in which a socket
 * exists and no credential mechanism does. The only safe thing a listener can do
 * in that window is refuse everything, so that is exactly what this does:
 *
 * - every request, every method, every path — including the static shell that
 *   §3.1 rule 1 will later serve without a token — is refused;
 * - the refusal carries **no** information about whether the route exists, so the
 *   listener is not a route oracle either;
 * - it is a `Middleware`, so M4 replaces it by prepending the real auth chain
 *   rather than by editing anything that binds a socket.
 *
 * ## Why `503` and not `401`
 *
 * `401` has a defined meaning for the client (DESIGN §8.2: "clear stored token,
 * show the pairing screen"), and acting on it would be wrong — there is no token
 * that could work, so re-pairing cannot help. `503` with a distinct code says
 * "this listener is not serving yet", which is the truth, and the code is
 * `remote_unauthenticated` rather than §8.2's `remote_unavailable` so a client
 * cannot confuse it with the listener being in `waiting`.
 */
import type { HttpResult, Middleware, RequestContext, ResponseTools } from '../../http/types.js';

/** The error code M3's placeholder answers with. Replaced by M4's auth chain. */
export const REMOTE_UNAUTHENTICATED = 'remote_unauthenticated';

export const REMOTE_UNAUTHENTICATED_MESSAGE =
  'The remote listener is bound but not yet serving: bearer-token authentication arrives in ' +
  'remote milestone M4, and an authenticated API is the only kind this listener will ever expose ' +
  '(architecture D5). Every request is refused until then.';

/**
 * Refuses every request reaching the remote listener.
 *
 * @param log called once per refusal, so the refusals are visible in `core.log`
 *   while the placeholder is in place.
 */
export function denyEveryRequest(log?: (request: RequestContext) => void): Middleware {
  return (request: RequestContext, response: ResponseTools): HttpResult => {
    log?.(request);
    return response.error(503, REMOTE_UNAUTHENTICATED, REMOTE_UNAUTHENTICATED_MESSAGE);
  };
}
