/**
 * The pairing screen (DESIGN §3.2, §13.4's first row).
 *
 * > "A `401` shows the pairing screen: scan the QR from the desktop, or paste.
 * > The URL-fragment token is stripped before first render."
 *
 * The fragment half is `api/pairing.ts` and runs in `main.tsx` *before* React
 * mounts, which is the only place it can run and still be true. This screen is
 * the other half: the manual paste that "is always available" (§3.2 step 3),
 * reached **only** by a `401` and never shown in Electron or at loopback.
 *
 * It is deliberately the whole page rather than a dialog over the app: an
 * unpaired client has no data to render behind it, and a modal over an empty
 * board is a worse answer to "why is nothing here" than a screen that says it.
 */

import { useState, type ReactElement } from 'react';

import type { ApiClient } from '../api/client';

export interface PairingScreenProps {
  readonly client: Pick<ApiClient, 'setToken'>;
  /** Called once a token has been stored, so the app can boot again. */
  readonly onPaired: () => void;
}

export function PairingScreen({ client, onPaired }: PairingScreenProps): ReactElement {
  const [token, setToken] = useState('');

  return (
    <main className="pairing" aria-labelledby="pairing-heading">
      <h1 id="pairing-heading">Pair this device</h1>
      <p>
        This browser has no valid access token, so the core will not answer it. Create one on the
        machine running AgentManager —{' '}
        <strong>Settings → Remote access → Create device token</strong> — then scan the QR it shows,
        or paste the token here.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = token.trim();
          if (trimmed === '') return;
          client.setToken(trimmed);
          onPaired();
        }}
      >
        <label className="field">
          <span>Access token</span>
          <input
            value={token}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="button"
          data-variant="primary"
          disabled={token.trim() === ''}
        >
          Pair
        </button>
      </form>
      <p className="empty">
        Tokens are per device (remote §4.3), so pairing a second phone does not disturb this one,
        and losing one is revoked on its own.
      </p>
    </main>
  );
}
