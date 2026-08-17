/**
 * Pairing from the QR fragment (DESIGN §3.2, step 2).
 *
 * > "On boot the client reads `location.hash`, extracts `t=`, stores it in
 * > `localStorage` under one key with the server-returned label, and immediately
 * > calls `history.replaceState` to strip the fragment — **before the first
 * > render**, so it cannot be screenshotted from the address bar."
 *
 * Its own module rather than a function inside `main.tsx` for one reason: it has
 * an acceptance criterion of its own ("asserted by reading `location.href` in
 * the first effect"), and `main.tsx` mounts React at import time, so a test that
 * imported it would render the whole app to check one string.
 */

import type { ApiClient } from './client';

/** Just enough of `window` to be driven from a test. */
export type PairingWindow = Pick<Window, 'location' | 'history'>;

/**
 * Claims a bearer from `#t=…`, stores it, and strips the fragment.
 *
 * @returns the token that was claimed, or `null` when the URL carried none.
 */
export function claimTokenFromHash(
  client: Pick<ApiClient, 'setToken'>,
  windowRef: PairingWindow = window,
): string | null {
  const hash = windowRef.location.hash;
  if (!hash.startsWith('#')) return null;
  const token = new URLSearchParams(hash.slice(1)).get('t');
  if (token === null || token === '') return null;
  client.setToken(token);
  // Replace rather than push: a back button that restores the token to the
  // address bar would undo the whole point of stripping it.
  windowRef.history.replaceState(
    null,
    '',
    `${windowRef.location.pathname}${windowRef.location.search}`,
  );
  return token;
}
