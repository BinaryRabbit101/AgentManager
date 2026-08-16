/**
 * The bind-time invariant of DESIGN §6.3 — the assertion that turns D5/D6 from
 * a convention into a startup check.
 *
 * > "After all modules have started, foundation enumerates every listening
 * > socket the process owns and asserts:
 * >
 * > - `edition === 'work'` → **every** listener is bound to a loopback address,
 * >   else the process logs a fatal error and exits.
 * > - `edition === 'home'` → any non-loopback listener must match the address
 * >   and port the remote module **publishes** as its own via
 * >   `ctx.require('remote').boundAddress()`, which returns
 * >   `{ address, port, source } | null`. The assertion does not re-derive or
 * >   infer which listener belongs to remote, and does not itself go looking for
 * >   the Tailscale interface."
 *
 * ## Why the enumeration goes to the runtime, not to the modules
 *
 * §6.3's point is that the check compares **two independently produced claims
 * about the same socket**: what the OS says is listening, and what the module
 * says it bound. Asking the `http` service and the `remote` service where they
 * bound would be one claim compared with itself — a listener nobody remembered
 * to declare would be invisible, which is precisely the leak the assertion
 * exists to catch. {@link observeListeners} therefore walks the process's live
 * libuv handles: every `net.Server` this process owns is there whether or not
 * any module admits to it.
 *
 * `process._getActiveHandles` is undocumented; the documented
 * `process.getActiveResourcesInfo()` returns type names without addresses,
 * which cannot answer "bound to what?". When the handle list is unavailable the
 * observation reports `unavailable` rather than an empty list, so the caller can
 * fall back to the modules' own claims *and say that it did* — a silent empty
 * list would turn the security assertion into a no-op.
 */
import { Server } from 'node:net';

import type { Edition } from '../config/index.js';

/** The service name the remote module publishes on the registry (§6.3, remote §11). */
export const REMOTE_SERVICE = 'remote';

/**
 * Remote's published claim about its own listener.
 *
 * This is the contract §6.3 reads. The remote element implements it; foundation
 * only compares it against the sockets the process actually owns, and never
 * derives it. `source` names *how* remote decided on the address (`tailscale`,
 * `hostnameHint`, …) and is carried into the fatal message so a mismatch is
 * diagnosable.
 */
export interface BoundAddress {
  readonly address: string;
  readonly port: number;
  readonly source: string;
}

/** What `ctx.require('remote')` yields, as far as §6.3 is concerned. */
export interface RemoteService {
  /** The address remote bound, or `null` when it has no listener. */
  boundAddress(): BoundAddress | null;
}

/** One listening socket, as the process itself reports it. */
export interface ObservedListener {
  readonly address: string;
  readonly port: number;
  readonly family: string;
}

export interface ListenerObservation {
  readonly listeners: readonly ObservedListener[];
  /**
   * `handles` — enumerated from the process's own libuv handles.
   * `fallback` — the caller's list, because handles could not be enumerated.
   */
  readonly source: 'handles' | 'fallback';
}

/** Exit code for a violated bind invariant. `EX_PROTOCOL` from sysexits.h. */
export const BIND_INVARIANT_EXIT_CODE = 76;

/**
 * A listener exists that the edition does not allow.
 *
 * Fatal by §6.3 — "the process logs a fatal error and exits" — and carried as
 * its own type so the composition root can exit with
 * {@link BIND_INVARIANT_EXIT_CODE} and report it on stderr as well as in the
 * log: a security boundary that fails must be visible without opening a file.
 */
export class BindInvariantError extends Error {
  override readonly name = 'BindInvariantError';
  readonly exitCode = BIND_INVARIANT_EXIT_CODE;
  readonly edition: Edition;
  readonly offending: readonly ObservedListener[];

  constructor(message: string, edition: Edition, offending: readonly ObservedListener[]) {
    super(message);
    this.edition = edition;
    this.offending = offending;
  }
}

/** Strips an IPv6 zone id and the IPv4-mapped IPv6 prefix, and lowercases. */
export function normaliseAddress(address: string): string {
  const withoutZone = address.split('%')[0] ?? address;
  const lowered = withoutZone.toLowerCase();
  return lowered.startsWith('::ffff:') && lowered.includes('.')
    ? lowered.slice('::ffff:'.length)
    : lowered;
}

/**
 * True for the addresses §6.4 calls "loopback" — the ones only a process on
 * this machine, running as this user, can reach.
 *
 * The wildcards `0.0.0.0` and `::` are deliberately **not** loopback: binding
 * them exposes every interface the host has, which is the exact failure §6.3
 * refuses in the work edition.
 */
export function isLoopback(address: string): boolean {
  const value = normaliseAddress(address);
  if (value === '::1' || value === 'localhost') return true;
  return /^127\./.test(value);
}

/**
 * Every listening socket this process owns, from the runtime's own handle list.
 *
 * @param fallback used when the handle list cannot be read; reported as such.
 */
export function observeListeners(fallback: readonly ObservedListener[] = []): ListenerObservation {
  const handles = (
    process as unknown as { _getActiveHandles?: () => readonly unknown[] }
  )._getActiveHandles?.();

  if (handles === undefined) return { listeners: fallback, source: 'fallback' };

  const listeners: ObservedListener[] = [];
  for (const handle of handles) {
    if (!(handle instanceof Server)) continue;
    if (!handle.listening) continue;
    const address = handle.address();
    // A string address is a pipe or a Unix socket: no interface to leak.
    if (address === null || typeof address === 'string') continue;
    listeners.push({ address: address.address, port: address.port, family: address.family });
  }
  return { listeners, source: 'handles' };
}

export interface BindInvariantInput {
  readonly edition: Edition;
  readonly listeners: readonly ObservedListener[];
  /**
   * Remote's published claim, or `undefined` when no remote module is present.
   *
   * `undefined` and `null` mean the same thing here — nothing is claimed — and
   * that is the case §6.3 makes fatal for a non-loopback socket. It is also why
   * a home edition whose remote module binds nothing (the placeholder, or
   * `modules.remote.enabled: false`) behaves exactly like the work edition.
   */
  readonly remote?: BoundAddress | null;
}

export interface BindInvariantReport {
  readonly edition: Edition;
  readonly listeners: readonly ObservedListener[];
  readonly loopback: readonly ObservedListener[];
  readonly nonLoopback: readonly ObservedListener[];
  readonly remote: BoundAddress | null;
  /** Non-fatal oddities worth a `warn` — e.g. a claim with no matching socket. */
  readonly warnings: readonly string[];
}

function describe(listener: ObservedListener): string {
  return `${listener.address}:${String(listener.port)}`;
}

function matches(claim: BoundAddress, listener: ObservedListener): boolean {
  return (
    claim.port === listener.port &&
    normaliseAddress(claim.address) === normaliseAddress(listener.address)
  );
}

/**
 * Asserts §6.3 against an observed set of listeners.
 *
 * Pure: it takes the two claims and returns a report or throws. The process
 * concerns — enumerating handles, logging, exiting — belong to the composition
 * root, which is what makes every branch of this testable without a socket.
 *
 * @throws BindInvariantError when a listener is not allowed by the edition.
 */
export function assertBindInvariant(input: BindInvariantInput): BindInvariantReport {
  const claim = input.remote ?? null;
  const loopback = input.listeners.filter((listener) => isLoopback(listener.address));
  const nonLoopback = input.listeners.filter((listener) => !isLoopback(listener.address));
  const warnings: string[] = [];

  if (input.edition === 'work' && nonLoopback.length > 0) {
    throw new BindInvariantError(
      `The work edition may only bind loopback addresses, but ${String(nonLoopback.length)} ` +
        `listener(s) are bound elsewhere: ${nonLoopback.map(describe).join(', ')}. ` +
        'The work edition never opens a listener beyond this machine (architecture D6, DESIGN §6.3), ' +
        'so the process is exiting rather than serving on it. Check `http.bind` and any module that ' +
        'binds a socket of its own.',
      input.edition,
      nonLoopback,
    );
  }

  if (input.edition === 'home') {
    const unclaimed = nonLoopback.filter((listener) => claim === null || !matches(claim, listener));
    if (unclaimed.length > 0) {
      throw new BindInvariantError(
        `Non-loopback listener(s) ${unclaimed.map(describe).join(', ')} are not claimed by the ` +
          'remote module. ' +
          (claim === null
            ? 'No module published a bound address through ctx.require("remote").boundAddress(), ' +
              'so nothing owns them.'
            : `Remote claims ${claim.address}:${String(claim.port)} (source "${claim.source}"), ` +
              'which is not the socket that is actually bound.') +
          ' Only the remote listener may leave this machine, and only on the address it published ' +
          '(architecture D5, DESIGN §6.3), so the process is exiting.',
        input.edition,
        unclaimed,
      );
    }

    if (claim !== null && !input.listeners.some((listener) => matches(claim, listener))) {
      warnings.push(
        `The remote module claims ${claim.address}:${String(claim.port)} (source "${claim.source}"), ` +
          'but no listening socket of this process is bound there.',
      );
    }
  }

  return {
    edition: input.edition,
    listeners: input.listeners,
    loopback,
    nonLoopback,
    remote: claim,
    warnings,
  };
}
