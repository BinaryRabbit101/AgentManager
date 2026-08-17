/**
 * A booted core, and the frontend's own client pointed at it.
 *
 * Two ui criteria are explicitly about the whole stack, and neither is provable
 * in jsdom:
 *
 * - **the solo launch** (IMPLEMENTATION §3): "drag→type→Enter … reach a running
 *   session";
 * - **the question answer round-trip** (§5): "Answering inside runner's hold
 *   resolves the pending tool call **inline** and the session continues in the
 *   same turn."
 *
 * So these boot `src/main.ts` exactly as `module.test.ts` does — the real
 * composition root, real storage, a real listener on an ephemeral port, roster's
 * library on disk — with only `BootOptions.runner.query` scripted. Nothing else
 * is faked.
 *
 * The frontend talks to it through its **own** `ApiClient`, with one substitution:
 * `fetch` prefixes the listener's origin. §1.3 pins that every call is
 * same-origin and relative and that there is no base URL to configure, so the
 * base cannot live in the client — and putting it in the seam the client already
 * exposes means the path building, the `/api` prefix, the status-code mapping and
 * the typed outcomes of §3.1 are all still under test.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findInstallRoot } from '../../src/config/index.js';
import { boot, type BootOptions, type BootedService } from '../../src/main.js';
import { ApiClient } from '../src/api/client';

export const repoRoot = findInstallRoot(dirname(fileURLToPath(import.meta.url)));

export interface TempDir {
  readonly path: string;
  cleanup(): void;
}

export function makeTempDir(prefix: string): TempDir {
  const path = mkdtempSync(resolve(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true, maxRetries: 5 }) };
}

export interface BootedCore {
  readonly service: BootedService;
  readonly base: string;
  /** The frontend's client, origin-prefixed. Everything else is production. */
  readonly client: ApiClient;
  /** Every path the client requested, in order — the request-count assertions. */
  readonly calls: string[];
  shutdown(): Promise<void>;
}

export async function bootCore(options: BootOptions = {}): Promise<BootedCore> {
  const dataRoot = makeTempDir('agentmanager-ui-e2e-data-');
  const booted = await boot({
    installRoot: repoRoot,
    dataRoot: dataRoot.path,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fixture' },
    pretty: false,
    tightenAcl: false,
    acl: { run: () => {} },
    exit: () => {},
    ...options,
    http: { port: 0, heartbeatMs: 0, ...options.http },
    argv: ['--set', 'secrets.provider=env', ...(options.argv ?? [])],
  });
  const base = booted.url();
  if (base === undefined) throw new Error('the listener did not bind');

  const calls: string[] = [];
  const client = new ApiClient({
    fetch: ((input: string, init: RequestInit) => {
      calls.push(input);
      return fetch(`${base}${input}`, init);
    }) as unknown as typeof globalThis.fetch,
    tokens: { get: () => null, set: () => undefined },
  });

  return {
    service: booted,
    base,
    client,
    calls,
    shutdown: async () => {
      await booted.shutdown();
      dataRoot.cleanup();
    },
  };
}

/** Registers a folder as a project, through the route quick-add uses (§8.1). */
export async function seedProject(
  core: BootedCore,
  workspace: string,
  name: string,
): Promise<string> {
  const folder = join(workspace, name);
  mkdirSync(folder, { recursive: true });
  const created = await core.client.request<{ id: string }>('/projects', {
    method: 'POST',
    body: { localPath: folder },
  });
  if (created.kind !== 'ok') throw new Error(`project refused: ${created.message}`);
  return created.value.id;
}

/** Creates a real agent definition on disk, through roster's own route. */
export async function seedAgent(core: BootedCore, name: string): Promise<string> {
  const created = await core.client.request<{ definition: { id: string } }>('/roster/agents', {
    method: 'POST',
    body: {
      name,
      specialty: 'feature-implementation',
      capabilities: { roles: ['implementer'] },
      personaText: `# ${name}\n\nDo the one thing asked.\n`,
    },
  });
  if (created.kind !== 'ok') throw new Error(`agent refused: ${created.message}`);
  return created.value.definition.id;
}

/** Polls runner's own route until the session leaves the live statuses. */
export async function untilTerminal(
  core: BootedCore,
  sessionId: string,
  timeoutMs = 30_000,
): Promise<{ status: string; exitReason: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await core.client.request<{
      session: { status: string; exitReason: string | null };
    }>(`/sessions/${sessionId}`);
    if (
      answer.kind === 'ok' &&
      !['queued', 'running', 'paused'].includes(answer.value.session.status)
    ) {
      return answer.value.session;
    }
    if (Date.now() > deadline) throw new Error(`session ${sessionId} did not settle`);
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

/** Waits for a predicate, so a test never sleeps a fixed amount. */
export async function until<T>(
  read: () => Promise<T> | T,
  ok: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error('the condition never became true');
    await new Promise((settle) => setTimeout(settle, 25));
  }
}
