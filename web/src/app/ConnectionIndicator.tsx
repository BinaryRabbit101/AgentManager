/**
 * The connection indicator (DESIGN §3.3).
 *
 * "Connection state is a first-class UI object with three values — `live`,
 * `reconnecting`, `offline` — rendered as a single dot in the top bar with a
 * tooltip, and as a full-width banner when `offline` for more than five seconds."
 *
 * Colour is never the only carrier (§15): the word is beside the dot.
 * **Controls are not disabled while reconnecting** — every runner control verb
 * is idempotent (runner §11.1), and a retry the UI refuses to send is worse than
 * one the server absorbs.
 */

import { useEffect, useState, type ReactElement } from 'react';

import type { ConnectionState } from '../events/EventStream';
import { useAppStore } from '../state/store';

const LABELS: Readonly<Record<ConnectionState, string>> = Object.freeze({
  live: 'live',
  reconnecting: 'reconnecting',
  offline: 'offline',
});

const TOOLTIPS: Readonly<Record<ConnectionState, string>> = Object.freeze({
  live: 'Connected to the core; the board is updating from its event feed.',
  reconnecting: 'The event feed dropped. Reconnecting and replaying what was missed.',
  offline: 'The core is not answering. Controls still work and will report their own failures.',
});

export function ConnectionIndicator(): ReactElement {
  const state = useAppStore((store) => store.connection);
  return (
    <span
      className="connection"
      data-testid="connection"
      data-state={state}
      title={TOOLTIPS[state]}
    >
      <span className="connection__dot" aria-hidden="true" />
      <span>{LABELS[state]}</span>
      <span role="status" aria-live="polite" className="visually-hidden">
        Connection {LABELS[state]}
      </span>
    </span>
  );
}

/** Milliseconds of `offline` before the banner appears (§3.3's "more than five"). */
export const OFFLINE_BANNER_DELAY_MS = 5_000;

export function OfflineBanner(): ReactElement | null {
  const state = useAppStore((store) => store.connection);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (state !== 'offline') {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), OFFLINE_BANNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state]);

  if (!shown) return null;
  return (
    <div className="frame__banner" role="alert">
      The core is not answering. The app is still usable, but nothing on screen is live.
    </div>
  );
}
