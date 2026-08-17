/**
 * The remote module's construction surface, kept **in its own file with no side
 * effects**.
 *
 * `index.ts` calls `noteModuleLoaded('remote')` at evaluation, because foundation
 * §6.2's guarantee — "in the work edition its code is never evaluated, its routes
 * never registered, its sockets never created" — is asserted by that counter. The
 * composition root needs this options *type* in order to declare
 * `BootOptions.remote`, and a `import type` is erased at compile time — but the
 * boundary is worth more than that reassurance, so the type lives here, where
 * even a bundler that resolved the edge would find nothing that runs.
 *
 * Everything here is a seam rather than a setting. Configuration lives in
 * `config.ts` and reaches the module through `ctx.config.remote`; this file
 * carries only what the composition root supplies (the access-log stream) and what
 * a test replaces (detection, timers, jitter, the port).
 */
import type { Logger } from 'pino';

import type { GrantStore } from './grants.js';
import type { RemoteListener, RemoteTimers } from './listener.js';
import type { AddressProver } from './proxy.js';
import type { StreamRegistry } from './streams.js';
import type { TailscaleDetectorDeps } from './tailscale.js';
import type { TicketStore } from './tickets.js';
import type { RemoteTokenService } from './tokens.js';

/** What only the composition root can supply. */
export interface RemoteModuleDeps {
  /**
   * `access.log`'s logger (foundation §5.1).
   *
   * It is not on `ModuleContext` — modules get `ctx.logger`, which writes
   * `core.log` — and remote is the second listener, so it needs the same access
   * stream the first one writes to. Passed down from the composition root rather
   * than re-derived, so there is one `access.log` and one redaction chain.
   */
  readonly accessLogger: Logger;
}

/** What the module built, handed to {@link RemoteModuleOptions.onReady}. */
export interface RemoteInternals {
  readonly detector: AddressProver;
  readonly listener: RemoteListener;
  /**
   * §4's credential store.
   *
   * Handed out so a test can mint a token against the *real* module — the same
   * service the middleware verifies against — instead of reaching through an HTTP
   * route it is also trying to test.
   */
  readonly tokens: RemoteTokenService;
  /** §3.4's ticket store, so a test can assert single use from both sides. */
  readonly tickets: TicketStore;
  /** §4.5's connection map, so a leak is a number a test can read. */
  readonly streams: StreamRegistry;
  /** §6.1's grant rows, so a test drives the real store rather than settings. */
  readonly grants: GrantStore;
  /**
   * Runs one heartbeat tick now instead of on its timer; returns how many
   * half-open connections it reaped. The same seam `listener.poll()` is.
   */
  heartbeat(): number;
  /** Runs §6.3's sweep now; returns the agent ids whose grants expired. */
  sweepGrants(): readonly string[];
}

export interface RemoteModuleOptions {
  /**
   * Replaces the address prover wholesale. Tests that assert on the state machine
   * inject one of these; tests that assert on proving itself use `detect`.
   */
  readonly detector?: AddressProver;
  /** Pins a stream ticket's bytes, so a test can assert on the exact value. */
  readonly ticketBytes?: (size: number) => Buffer;
  /** Injected into the default detector — the CLI probe and interface enumeration. */
  readonly detect?: TailscaleDetectorDeps;
  /**
   * Overrides `remote.port`; `0` asks the OS for an ephemeral one.
   *
   * The escape hatch is here rather than in configuration for the same reason
   * `http`'s is (foundation `BootOptions.http`): the schema requires a real port
   * number, and rightly so.
   */
  readonly port?: number;
  /** Deterministic backoff and polling. */
  readonly timers?: RemoteTimers;
  /** Backoff jitter. */
  readonly random?: () => number;
  /** Receives what the module built, so a test can drive it through `init`. */
  readonly onReady?: (internals: RemoteInternals) => void;
}
