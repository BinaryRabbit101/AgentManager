/**
 * The boot sequence and its diagnostic screen (DESIGN §3.5, IMPLEMENTATION §1).
 *
 * "`GET /api/config/effective` + `GET /api/health` → edition, module list,
 * policy flags, health warnings → then render. **A failed boot renders a
 * diagnostic screen with the core URL and the log path, never a blank page.**"
 *
 * Both facts are learned once, up front, and never by probing for a 404
 * (remote §12.6). Nothing is rendered before they arrive, because half the app
 * changes shape on `edition` and on which modules are present, and a frame that
 * flickers between two shapes is worse than one that waits.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

import type { ApiClient } from '../api/client';
import { fetchBootFacts } from '../api/queries';
import { failureOf } from '../api/result';
import type { ApiFailure } from '../api/result';
import { PairingScreen } from '../remote/PairingScreen';

import type { BootFacts } from './AppContext';

type BootPhase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly facts: BootFacts }
  /** §3.2: reached **only** by a `401`, and never at loopback or in Electron. */
  | { readonly kind: 'pairing' }
  | { readonly kind: 'failed'; readonly failure: ApiFailure };

export interface BootGateProps {
  readonly client: ApiClient;
  readonly children: (facts: BootFacts) => ReactNode;
}

export function BootGate({ client, children }: BootGateProps): ReactElement {
  const [phase, setPhase] = useState<BootPhase>({ kind: 'loading' });
  const cancelled = useRef(false);

  const run = useCallback(() => {
    setPhase({ kind: 'loading' });
    void fetchBootFacts(client).then(
      (facts) => {
        if (!cancelled.current) setPhase({ kind: 'ready', facts });
      },
      (error: unknown) => {
        if (cancelled.current) return;
        // §3.1: a `401` has already cleared the stored token. There is nothing
        // to retry and nothing to diagnose — the device is simply not paired.
        if (failureOf(error)?.kind === 'unauthorized') {
          setPhase({ kind: 'pairing' });
          return;
        }
        setPhase({
          kind: 'failed',
          failure: failureOf(error) ?? {
            kind: 'offline',
            message: error instanceof Error ? error.message : String(error),
            cause: error instanceof Error ? error : new Error(String(error)),
          },
        });
      },
    );
  }, [client]);

  useEffect(() => {
    cancelled.current = false;
    run();
    return () => {
      cancelled.current = true;
    };
  }, [run]);

  if (phase.kind === 'ready') return <>{children(phase.facts)}</>;
  if (phase.kind === 'pairing') return <PairingScreen client={client} onPaired={run} />;
  if (phase.kind === 'failed') return <BootDiagnostic failure={phase.failure} onRetry={run} />;
  return (
    <div className="boot-screen" role="status" aria-live="polite">
      <h1>AgentManager</h1>
      <p>Reaching the core…</p>
    </div>
  );
}

/**
 * Where the core is, from the page's own address.
 *
 * Not configured anywhere: §1.3 pins that every call is same-origin and relative,
 * so the origin the app was loaded from *is* the core URL — including in
 * Electron, which loads `http://127.0.0.1:<port>` rather than `file://` for
 * exactly this reason (§1.5).
 */
export function coreUrl(location: Pick<Location, 'origin'> = globalThis.location): string {
  return location.origin;
}

/**
 * The log path, named rather than linked.
 *
 * §4 forbids the UI reading the filesystem, so this is the documented default
 * location from foundation §5.3 and not something the app went and looked up —
 * and when the core is unreachable there is no endpoint to ask anyway. It is
 * printed so a user with no working app still knows where to look.
 */
export const LOG_PATH_HINT = '%LOCALAPPDATA%\\AgentManager\\logs\\core.log';

export interface BootDiagnosticProps {
  readonly failure: ApiFailure;
  readonly onRetry: () => void;
}

export function BootDiagnostic({ failure, onRetry }: BootDiagnosticProps): ReactElement {
  return (
    <div className="boot-screen" role="alert">
      <h1>AgentManager cannot reach its core</h1>
      {/* The server's own words, never paraphrased (§3.1). */}
      <p className="boot-screen__detail">{failure.message}</p>
      <dl>
        <dt>Core URL</dt>
        <dd>{coreUrl()}</dd>
        <dt>Log file</dt>
        <dd>{LOG_PATH_HINT}</dd>
        <dt>Reason</dt>
        <dd>{failure.kind}</dd>
      </dl>
      <p>
        The core runs as a separate service. If it is stopped, start it and try again — nothing in
        the app can start it from here.
      </p>
      <button type="button" className="button" data-variant="primary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
