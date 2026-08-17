/**
 * **Remote M10, the process-level half — the built bundle, watched from outside.**
 *
 * Two of §10's criteria are about what an operating system reports about a *process*,
 * and neither can be honestly proven from inside the test runner:
 *
 * > "Work edition boots with zero non-loopback listeners …"
 * > (and remote M3) "`netstat`-equivalent socket enumeration shows exactly one
 * > non-loopback listener and its address is the Tailscale one."
 *
 * `boundary.test.ts` proves those in-process, from `process._getActiveHandles()` —
 * which is the same source foundation's §6.3 assertion reads. That is a strong check
 * and a *self-referential* one: if the handle walk ever stopped seeing a socket, the
 * assertion and the test would go blind together. So this file spawns
 * `node dist/main.js` and asks **Windows** which sockets that PID is listening on,
 * via `netstat -ano`. Two independent observers of one fact, which is the same
 * discipline §9.1 #2 applies to the bind itself.
 *
 * ## The four rows of the boot matrix
 *
 * | Spawned as | Expected, per netstat |
 * |---|---|
 * | work edition | every LISTENING socket owned by the PID is loopback |
 * | home edition, `modules.remote.enabled: false` | identical to the work edition |
 * | home edition, remote enabled, no tailnet | identical again — `waiting` means *no socket* |
 * | home edition, proxy mode on this host's LAN address | **exactly one** non-loopback socket, and it is the declared address |
 *
 * The last row is D5's amendment proven end to end: a real core, a real socket on a
 * real interface, and the operating system agreeing that it is the one address
 * `remote.proxy.bind` names. It is skipped on a host with no LAN address.
 *
 * The suite needs `dist/`, so it is skipped when the bundle is absent — `npm run ci`
 * builds before it tests, which is the path that gates a merge. It complements
 * `src/lifecycle/process.test.ts`, which spawns the same bundle for M9's fatal-bind
 * criteria; nothing here repeats those.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isLoopback, normaliseAddress } from '../../lifecycle/bind.js';
import { probeCore } from '../../lifecycle/index.js';
import { repoRoot } from '../__tests__/helpers.js';

const bundle = join(repoRoot, 'dist', 'main.js');

const READY_TIMEOUT_MS = 40_000;
const TEST_TIMEOUT_MS = 90_000;

/** True when `netstat` answers at all — the only reason to skip on a non-Windows box. */
function netstatAvailable(): boolean {
  const probe = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 20_000 });
  return (
    probe.status === 0 && typeof probe.stdout === 'string' && probe.stdout.includes('LISTENING')
  );
}

interface NetstatListener {
  readonly address: string;
  readonly port: number;
}

/**
 * Every TCP socket the operating system says `pid` is LISTENING on.
 *
 * Lines look like `TCP  127.0.0.1:7477  0.0.0.0:0  LISTENING  12345`, and IPv6 local
 * addresses are bracketed (`[::1]:7477`), so the address is everything before the
 * final colon with the brackets stripped.
 */
function netstatListeners(pid: number): readonly NetstatListener[] {
  const output = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 30_000 }).stdout ?? '';
  const found: NetstatListener[] = [];

  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 5) continue;
    if (!/^TCP/iu.test(fields[0] ?? '')) continue;
    if ((fields[3] ?? '').toUpperCase() !== 'LISTENING') continue;
    if (Number(fields[4]) !== pid) continue;

    const local = fields[1] ?? '';
    const split = local.lastIndexOf(':');
    if (split <= 0) continue;
    found.push({
      address: normaliseAddress(local.slice(0, split).replace(/^\[|\]$/gu, '')),
      port: Number(local.slice(split + 1)),
    });
  }

  return found;
}

function nonLoopback(listeners: readonly NetstatListener[]): readonly NetstatListener[] {
  return listeners.filter((entry) => !isLoopback(entry.address));
}

interface Core {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
  readonly port: number;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
}

let dataRoot: string;
const running: Core[] = [];

/** The environment minus anything that would redirect the child's data root. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTMANAGER_')) delete env[key];
  return env;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => void server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => void server.close(() => done()));
  return port;
}

function coreArgs(port: number, extra: readonly string[] = []): string[] {
  return [
    bundle,
    '--data-root',
    dataRoot,
    '--set',
    `http.port=${String(port)}`,
    '--set',
    'secrets.provider=env',
    '--set',
    'service.shutdownGraceSeconds=5',
    ...extra,
  ];
}

function spawnCore(args: readonly string[], port: number): Core {
  const child = spawn(process.execPath, [...args], { env: childEnv(), stdio: 'pipe' });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => void (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => void (err += chunk.toString('utf8')));
  const exited = new Promise<number | null>(
    (done) => void child.once('exit', (code) => done(code)),
  );

  const core: Core = {
    child,
    pid: child.pid ?? -1,
    port,
    stdout: () => out,
    stderr: () => err,
    exited,
  };
  running.push(core);
  return core;
}

/** Spawns a core and waits until `/healthz` answers. */
async function startCore(extra: readonly string[] = []): Promise<Core> {
  const port = await freePort();
  const core = spawnCore(coreArgs(port, extra), port);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let alive = true;
  void core.exited.then(() => void (alive = false));

  while (Date.now() < deadline) {
    const probe = await probeCore(port, { timeoutMs: 500 });
    if (probe?.status === 'ok') return core;
    if (!alive) break;
    await new Promise((done) => setTimeout(done, 150));
  }

  throw new Error(
    `the core did not answer /healthz on port ${String(port)}.\n` +
      `stdout: ${core.stdout()}\nstderr: ${core.stderr()}`,
  );
}

/** Writes layer 3, `<dataRoot>/config/config.json`. */
function writeConfigJson(value: unknown): void {
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(join(dataRoot, 'config', 'config.json'), JSON.stringify(value, null, 2), 'utf8');
}

function localLanAddress(): string | undefined {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return undefined;
}

const lanAddress = localLanAddress();
const runnable = existsSync(bundle) && netstatAvailable();

beforeEach(() => {
  dataRoot = mkdtempSync(resolve(tmpdir(), 'agentmanager-boundary-proc-'));
});

afterEach(async () => {
  for (const core of running.splice(0)) {
    core.child.kill('SIGKILL');
    await core.exited;
  }
  rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10 });
});

describe.runIf(runnable)('M10 process — the boot matrix, as the operating system sees it', () => {
  it(
    'gives the work edition zero non-loopback listeners, per netstat',
    async () => {
      const core = await startCore();
      const listeners = netstatListeners(core.pid);

      // The scan found the core's own listener, so an empty result cannot be
      // mistaken for a clean bill of health.
      expect(listeners.map((entry) => entry.port)).toContain(core.port);
      expect(nonLoopback(listeners)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'gives the home edition with remote disabled exactly the same answer',
    async () => {
      const core = await startCore(['--edition', 'home', '--set', 'modules.remote.enabled=false']);
      const listeners = netstatListeners(core.pid);

      expect(listeners.map((entry) => entry.port)).toContain(core.port);
      expect(nonLoopback(listeners)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'gives the home edition with remote enabled and no tailnet the same answer again',
    async () => {
      // `waiting` means **no socket exists** (DESIGN §2.3) — not a socket bound to
      // something harmless. This is the row that proves it from outside the process,
      // on a host that has no Tailscale interface to detect.
      const core = await startCore(['--edition', 'home']);
      const listeners = netstatListeners(core.pid);

      expect(listeners.map((entry) => entry.port)).toContain(core.port);
      expect(nonLoopback(listeners)).toEqual([]);

      // And the module is loaded, degraded, and honest about why.
      const health = (await (
        await fetch(`http://127.0.0.1:${String(core.port)}/api/health`)
      ).json()) as {
        modules: { id: string; status: string }[];
      };
      const remote = health.modules.find((module) => module.id === 'remote');
      expect(remote?.status).toBe('degraded');
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(lanAddress === undefined)(
    'gives home edition proxy mode exactly one non-loopback listener, and it is the declared address',
    async () => {
      // D5 as amended, proven by the operating system: one socket, on the one
      // interface `remote.proxy.bind` names, and nothing else beyond loopback.
      const remotePort = await freePort();
      const core = await startCore([
        '--edition',
        'home',
        '--set',
        'remote.bind=proxy',
        '--set',
        `remote.port=${String(remotePort)}`,
        '--set',
        `remote.proxy=${JSON.stringify({
          bind: lanAddress,
          // A peer nobody is: the socket exists to be enumerated, not to serve.
          allowedPeers: ['192.0.2.9'],
        })}`,
      ]);

      const listeners = netstatListeners(core.pid);
      expect(nonLoopback(listeners)).toEqual([{ address: lanAddress, port: remotePort }]);

      // The core's own claim agrees with what netstat reported — the same two
      // independent observations §6.3 compares, one of them from outside.
      const status = (await (
        await fetch(`http://127.0.0.1:${String(core.port)}/api/remote/status`)
      ).json()) as {
        state: string;
        mode: string;
        boundAddress: { address: string; port: number; source: string } | null;
      };
      expect(status.mode).toBe('proxy');
      expect(status.state).toBe('listening');
      expect(status.boundAddress).toEqual({
        address: lanAddress,
        port: remotePort,
        source: 'proxy',
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to start at all when config.json puts the work edition and remote together',
    async () => {
      // Criterion 2 at process level: the real file, the real bundle, a non-zero
      // exit and no listener of any kind — "fails config validation **and does not
      // start**".
      writeConfigJson({ edition: 'work', modules: { remote: { enabled: true } } });
      const port = await freePort();
      const core = spawnCore(coreArgs(port), port);

      const code = await core.exited;

      expect(code).not.toBe(0);
      expect(core.stderr()).toMatch(/remote/iu);
      expect(netstatListeners(core.pid)).toEqual([]);
      expect(existsSync(join(dataRoot, 'run', 'core.port'))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
