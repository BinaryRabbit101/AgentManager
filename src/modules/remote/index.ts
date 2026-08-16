/**
 * The remote module — **placeholder**, owned by the remote element.
 *
 * This file exists so the edition gate of DESIGN §6.2 is real and testable
 * before the remote element is built:
 *
 * ```ts
 * if (config.edition === 'home' && config.modules.remote.enabled) {
 *   modules.push((await import('./modules/remote/index.js')).default);   // dynamic import
 * }
 * ```
 *
 * The import is dynamic so that in the work edition "its code is never
 * evaluated, its routes never registered, its sockets never created". The
 * {@link noteModuleLoaded} call below is what lets a test assert exactly that —
 * it runs at module evaluation, so its absence proves the file was not loaded.
 *
 * ## What the remote element replaces
 *
 * Everything below the load probe. In particular it must:
 *
 * - bind a second HTTP/WS listener to the Tailscale address only (D5, §6.4),
 *   mounting **foundation's existing route table**, not a second surface;
 * - put bearer-token middleware in front of it, verifying against
 *   `remote_tokens.token_hash` (§3.4) and refusing routes registered
 *   `remote: 'deny'` (§6.4);
 * - `ctx.provide('remote', …)` an API exposing `boundAddress(): {address,
 *   port, source} | null`, which M9's bind-time invariant reads to match the
 *   OS's view of the socket against the module's own claim (§6.3). That
 *   contract is now a type — `RemoteService` in `src/lifecycle/bind.ts`, published
 *   under the service name `REMOTE_SERVICE`. Until it is implemented, a
 *   non-loopback socket in the home edition is fatal at start-up, exactly as it
 *   is in the work edition;
 * - keep `dependsOn` honest once it needs `http`.
 *
 * The load probe should stay: it is what M11's boundary suite asserts on.
 */
import { noteModuleLoaded } from '../loadProbe.js';
import type { Module } from '../types.js';

/** The module id, used by `dependsOn`, the registry and `migrations/remote/`. */
export const REMOTE_MODULE_ID = 'remote';

// Runs on evaluation of this file, and only then — the whole point of the gate.
noteModuleLoaded(REMOTE_MODULE_ID);

/**
 * Not `critical`: a remote listener that fails to start must leave the local
 * service running, so the owner can reach the UI at `127.0.0.1` and fix it.
 */
const remoteModule: Module = {
  id: REMOTE_MODULE_ID,
  dependsOn: [],
  init(ctx) {
    ctx.logger.info(
      { edition: ctx.config.edition, bind: ctx.config.remote.bind, port: ctx.config.remote.port },
      'remote module placeholder initialised: no listener is bound and no service is provided yet',
    );
    return {
      health: () => ({
        status: 'degraded' as const,
        message:
          'The remote module is a placeholder: remote access is configured but not implemented yet.',
        conditions: [
          {
            id: 'remote.placeholder',
            level: 'warn' as const,
            message:
              'Remote access is enabled in configuration, but the remote element is not built yet, ' +
              'so no remote listener exists. Nothing is reachable from the tailnet.',
          },
        ],
      }),
    };
  },
};

export default remoteModule;
