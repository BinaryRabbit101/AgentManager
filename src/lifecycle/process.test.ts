/**
 * The process-level acceptance criteria of milestone M9 (DESIGN §4.2, §6.3),
 * run against **the built bundle in a real child process**.
 *
 * These five criteria are about what a *process* does — hold a kernel lock,
 * survive a hard kill, exit on a signal, refuse to serve a socket — and none of
 * them can be honestly proven inside the test runner's own process. Each one is
 * therefore `node dist/main.js` with a temp data root and an ephemeral port:
 *
 * - "A second `node dist/main.js` prints the running port and exits 0 without
 *   touching the DB."
 * - "Killing the core hard leaves a stale `run/core.port`; the next start
 *   detects it, overwrites it, and boots normally."
 * - "Graceful shutdown completes within `shutdownGraceSeconds`, checkpoints
 *   WAL, removes `run/core.port`, and releases the lock."
 * - "Work edition with a forced non-loopback bind exits fatally with a clear
 *   message; home edition with a non-loopback bind not owned by the remote
 *   module does the same."
 *
 * The suite needs `dist/`, so it is skipped when the bundle is absent — `npm run
 * ci` builds before it tests, which is the path that gates a merge.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findInstallRoot } from '../config/index.js';

import { BIND_INVARIANT_EXIT_CODE } from './bind.js';
import { LOCK_FILENAME } from './lock.js';
import { PORT_FILENAME, probeCore, readPortFile } from './portFile.js';

const repoRoot = findInstallRoot(resolve(import.meta.dirname, '..'));
const bundle = join(repoRoot, 'dist', 'main.js');

/** Long enough for a first-run migration on a cold cache. */
const READY_TIMEOUT_MS = 40_000;
const TEST_TIMEOUT_MS = 90_000;
/** Small, so an overrun is visible in seconds rather than at the design default of 20. */
const GRACE_SECONDS = 5;

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

interface Core {
  readonly child: ChildProcessWithoutNullStreams;
  readonly args: readonly string[];
  readonly port: number;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
}

let dataRoot: string;
const running: Core[] = [];

beforeEach(() => {
  dataRoot = mkdtempSync(resolve(tmpdir(), 'agentmanager-proc-'));
});

afterEach(async () => {
  for (const core of running.splice(0)) {
    core.child.kill('SIGKILL');
    await core.exited;
  }
  rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10 });
});

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
    `service.shutdownGraceSeconds=${String(GRACE_SECONDS)}`,
    ...extra,
  ];
}

/** Spawns the bundle. Does not wait for readiness. */
function spawnCore(args: readonly string[], port: number): Core {
  const child = spawn(process.execPath, [...args], { env: childEnv(), stdio: 'pipe' });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => void (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => void (err += chunk.toString('utf8')));

  const exited = new Promise<number | null>((done) => {
    child.once('exit', (code) => done(code));
  });

  const core: Core = { child, args, port, stdout: () => out, stderr: () => err, exited };
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

function paths(): {
  run: string;
  lock: string;
  port: string;
  db: string;
  wal: string;
  log: string;
} {
  const run = join(dataRoot, 'run');
  return {
    run,
    lock: join(run, LOCK_FILENAME),
    port: join(run, PORT_FILENAME),
    db: join(dataRoot, 'state', 'agentmanager.db'),
    wal: join(dataRoot, 'state', 'agentmanager.db-wal'),
    log: join(dataRoot, 'state', 'logs', 'core.log'),
  };
}

describe.runIf(existsSync(bundle))('the core as a process (M9)', () => {
  it(
    'publishes run/core.port for the port it actually bound',
    async () => {
      const core = await startCore();
      const record = readPortFile(paths().port);

      expect(record).toBeDefined();
      expect(record?.port).toBe(core.port);
      expect(record?.pid).toBe(core.child.pid);
      expect(record?.edition).toBe('work');
      expect(Date.parse(record?.startedAt ?? '')).not.toBeNaN();
      expect(existsSync(paths().lock)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'has a second instance print the running port and exit 0 without touching the database',
    async () => {
      const core = await startCore();
      const { db, log } = paths();

      const dbBefore = statSync(db);
      const logBefore = statSync(log).size;

      // The same command line again — exactly what a double-click, a second
      // Electron launch or the scheduled task racing the user produces.
      const second = spawnSync(process.execPath, coreArgs(core.port), {
        env: childEnv(),
        encoding: 'utf8',
        timeout: 30_000,
      });

      expect(second.status).toBe(0);
      expect(second.stdout).toContain('already running');
      expect(second.stdout).toContain(String(core.port));

      // "without touching the DB": storage is opened after the lock is taken,
      // so a refused instance leaves the database and even the log untouched.
      const dbAfter = statSync(db);
      expect(dbAfter.mtimeMs).toBe(dbBefore.mtimeMs);
      expect(dbAfter.size).toBe(dbBefore.size);
      expect(statSync(log).size).toBe(logBefore);

      // And the first core is still serving.
      await expect(probeCore(core.port)).resolves.toMatchObject({ status: 'ok' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'detects a stale run/core.port left by a hard-killed core, overwrites it, and boots normally',
    async () => {
      const first = await startCore();
      const stale = readPortFile(paths().port);
      expect(stale?.port).toBe(first.port);

      // No handler, no cleanup — the case the port file cannot survive and the
      // lock can.
      first.child.kill('SIGKILL');
      await first.exited;

      expect(existsSync(paths().port)).toBe(true);
      expect(readPortFile(paths().port)?.pid).toBe(first.child.pid);
      await expect(probeCore(first.port, { timeoutMs: 500 })).resolves.toBeUndefined();

      const second = await startCore();
      const record = readPortFile(paths().port);

      expect(second.port).not.toBe(first.port);
      expect(record?.port).toBe(second.port);
      expect(record?.pid).toBe(second.child.pid);
      expect(readFileSync(paths().log, 'utf8')).toContain(`stale ${PORT_FILENAME}`);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shuts down gracefully within the budget, checkpointing the WAL and clearing run/',
    async () => {
      const core = await startCore();
      const { lock, port, wal, db } = paths();

      expect(existsSync(wal)).toBe(true);

      const started = Date.now();
      const response = await fetch(`http://127.0.0.1:${String(core.port)}/api/service/shutdown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'test' }),
      });
      expect(response.status).toBe(202);

      const code = await core.exited;
      const elapsed = Date.now() - started;

      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(GRACE_SECONDS * 1000);
      // "WAL checkpoint and close the DB → release lock and delete
      // run/core.port" — all three, observable from outside the process.
      expect(existsSync(wal)).toBe(false);
      expect(existsSync(db)).toBe(true);
      expect(existsSync(port)).toBe(false);
      expect(existsSync(lock)).toBe(false);

      // The lock really is free: a fresh core takes it and serves.
      const next = await startCore();
      await expect(probeCore(next.port)).resolves.toMatchObject({ status: 'ok' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits fatally in the work edition when forced to bind a non-loopback address',
    async () => {
      const port = await freePort();
      const core = spawnCore(coreArgs(port, ['--set', 'http.bind=0.0.0.0']), port);

      const code = await core.exited;

      expect(code).toBe(BIND_INVARIANT_EXIT_CODE);
      expect(core.stderr()).toContain('work edition');
      expect(core.stderr()).toContain('0.0.0.0');
      expect(readFileSync(paths().log, 'utf8')).toContain('refusing to start');
      // Nothing is published for a core that refused to run.
      expect(existsSync(paths().port)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits fatally in the home edition when a non-loopback listener is claimed by nobody',
    async () => {
      // The remote module is loaded here (home edition, remote enabled) but is
      // still a placeholder that binds nothing and publishes no claim — so the
      // socket belongs to no one, which §6.3 makes fatal.
      const port = await freePort();
      const core = spawnCore(
        coreArgs(port, ['--edition', 'home', '--set', 'http.bind=0.0.0.0']),
        port,
      );

      const code = await core.exited;

      expect(code).toBe(BIND_INVARIANT_EXIT_CODE);
      expect(core.stderr()).toContain('not claimed by the remote module');
      expect(existsSync(paths().port)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
