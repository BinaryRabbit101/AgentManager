/**
 * `run/core.port` — the discovery file of DESIGN §4.2.
 *
 * > "**Discovery**: after binding, the core writes `run/core.port`
 * > (`{port, pid, startedAt, edition}`) and deletes it on graceful exit. A stale
 * > file whose `/healthz` does not answer is ignored and overwritten."
 *
 * Two readers matter and both are outside this process: Electron, which reads
 * the file and probes `/healthz` before deciding whether to spawn a core (§4.1),
 * and `Test-AgentManagerHealth.ps1` (§4.4). {@link readPortFile} and
 * {@link probeCore} are therefore written as *the* discovery procedure, not as
 * private helpers — the same two steps in the same order the design gives them.
 *
 * Unlike `core.lock`, this file has no kernel-backed lifetime: a hard-killed
 * core leaves it behind, pointing at a port nothing is listening on. Staleness
 * is why the probe exists, and why publication is a `write`-then-`rename` so a
 * reader never sees a half-written record.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Edition } from '../config/index.js';

/** `<dataRoot>\run\core.port` (DESIGN §1.2). */
export const PORT_FILENAME = 'core.port';

/** The record §4.2 specifies, exactly. */
export interface PortRecord {
  readonly port: number;
  readonly pid: number;
  readonly startedAt: string;
  readonly edition: Edition;
}

/** What `/healthz` answered, when it answered (§6.4's payload). */
export interface CoreProbe {
  readonly status: string;
  readonly version?: string;
  readonly edition?: string;
  readonly phase?: string;
}

/** Parses `run/core.port`, returning `undefined` for missing or malformed files. */
export function readPortFile(path: string): PortRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const { port, pid, startedAt, edition } = parsed as Record<string, unknown>;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid)) return undefined;
  if (typeof startedAt !== 'string') return undefined;
  if (edition !== 'home' && edition !== 'work') return undefined;

  return { port, pid, startedAt, edition };
}

/**
 * Publishes the record, replacing whatever was there.
 *
 * Written to a sibling temp file and renamed, because `rename` is atomic for a
 * reader: Electron polling this file during a restart sees the old record or
 * the new one, never a truncated one.
 */
export function writePortFile(path: string, record: PortRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${String(record.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

/** Deletes the file on graceful exit. Never throws — it may already be gone. */
export function removePortFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export interface ProbeOptions {
  /** Defaults to 127.0.0.1: a core bound to any interface also answers on loopback. */
  readonly host?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Long enough for a busy core, short enough that a start-up never stalls on it. */
export const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

/**
 * Every probe asks for the connection to be closed rather than pooled.
 *
 * A probe is one request from a process that is about to exit — a CLI verb, the
 * Electron shell's readiness wait — so the keep-alive socket `fetch` leaves in
 * the global dispatcher's pool has nothing left to serve. On Node 25 it is worse
 * than useless: a pooled socket still open when the process exits aborts the
 * process during teardown with
 *
 * ```
 * Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
 * ```
 *
 * exit code 127, **after** the command has printed its output and decided its
 * exit code. That is how it was found: `agentmanager health` printed a perfect
 * report and then aborted, which made `Install-AgentManager.ps1`'s "wait for
 * /healthz" step report failure against a core that was healthy the whole time
 * (measured 2026-08-17: 3/3 aborts with pooling, 3/3 clean without).
 *
 * Closing the connection is the fix rather than a workaround: it removes the
 * handle instead of racing it, and a diagnostic that runs once has no use for a
 * pooled connection.
 */
export const PROBE_REQUEST_HEADERS: Readonly<Record<string, string>> = { connection: 'close' };

/**
 * `GET /healthz` against a published port — §4.1's readiness probe and §4.2's
 * staleness test, which are the same request.
 *
 * Resolves `undefined` for "nothing usable answered": connection refused,
 * timeout, a non-200, or a body that is not a `/healthz` payload (some other
 * program may hold the port now, and it is not a core).
 */
export async function probeCore(
  port: number,
  options: ProbeOptions = {},
): Promise<CoreProbe | undefined> {
  const host = options.host ?? '127.0.0.1';
  const request = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => void controller.abort(),
    options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  );

  try {
    const response = await request(`http://${host}:${String(port)}/healthz`, {
      signal: controller.signal,
      headers: { ...PROBE_REQUEST_HEADERS },
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return undefined;
    const payload = body as Record<string, unknown>;
    if (typeof payload['status'] !== 'string') return undefined;
    return {
      status: payload['status'],
      ...(typeof payload['version'] === 'string' ? { version: payload['version'] } : {}),
      ...(typeof payload['edition'] === 'string' ? { edition: payload['edition'] } : {}),
      ...(typeof payload['phase'] === 'string' ? { phase: payload['phase'] } : {}),
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The line a second instance prints before exiting 0 (§4.2).
 *
 * The port is the payload: whoever started this process wanted to reach a core,
 * and the one that is already running is at this port.
 */
export function alreadyRunningMessage(record: PortRecord | undefined, lockPath: string): string {
  if (record === undefined) {
    return (
      `agentmanager is already running: ${lockPath} is held by another process, ` +
      'but no port has been published yet (it may still be starting). Nothing to do.'
    );
  }
  return (
    `agentmanager is already running on port ${String(record.port)} ` +
    `(pid ${String(record.pid)}, ${record.edition} edition) at http://127.0.0.1:${String(record.port)}. ` +
    'Nothing to do.'
  );
}
