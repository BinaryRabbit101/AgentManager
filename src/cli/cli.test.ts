/**
 * The M10 CLI verbs (DESIGN §4.4) against a real temp data root.
 *
 * Acceptance covered here — the halves of foundation IMPLEMENTATION §10 that
 * are about *capability* rather than about a Windows logon session:
 *
 * - "data root created and ACL'd, config written with the chosen edition,
 *   schema migrated" — the `migrate` describe block.
 * - "Re-running `Install-AgentManager.ps1` is idempotent … and no write inside
 *   `library/` beyond creating and ACLing the directory itself" — `migrate` is
 *   the step that creates the tree, so its idempotence and its hands-off
 *   treatment of `library/` are proven here and again end to end in
 *   `scripts.test.ts`.
 * - "`Setup-Auth.ps1` stores a working token with the value never appearing in
 *   the console, the PowerShell history, the process command line, or any log
 *   file" — the console and command-line halves are properties of this verb and
 *   are asserted here; the PowerShell halves are in `scripts.test.ts`.
 * - "`Test-AgentManagerHealth.ps1` produces a single readable report covering
 *   edition, ports, task state, DB check, secret provider, `ANTHROPIC_API_KEY`
 *   presence, and a log tail" — every non-Windows item on that list comes from
 *   `agentmanager health`, asserted here.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findInstallRoot } from '../config/index.js';

import { createCliContext, runCommand, type CliContext } from './index.js';
import { normaliseSecretInput } from './secrets.js';
import type { HealthReportPayload } from './health.js';
import type { MigrateReport } from './migrate.js';

const repoRoot = findInstallRoot(dirname(fileURLToPath(import.meta.url)));
const version = '0.0.0-test';

/** A data root that no test outside this file can reach, torn down every time. */
let dataRoot: string;

/** The URL a `fetch` call was made against, whichever of the three input shapes it used. */
function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function capture(): {
  lines: string[];
  errors: string[];
  out: (l: string) => void;
  err: (l: string) => void;
} {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => void lines.push(l), err: (l) => void errors.push(l) };
}

interface InvokeOptions {
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly dataRoot?: string;
  /** `--edition`/`--data-root`/`--set`, handed to the loader untouched. */
  readonly config?: readonly string[];
}

/**
 * Runs a verb exactly as `main.ts` would, with every process-shaped effect
 * injected: no real ACL is mutated, no console is written, and the only stdin is
 * the string the test supplies.
 */
async function invoke(
  argv: readonly string[],
  options: InvokeOptions = {},
): Promise<{ code: number; lines: string[]; errors: string[] }> {
  const io = capture();
  const overrides: Partial<CliContext> = {
    io,
    env: options.env ?? { ...process.env, ANTHROPIC_API_KEY: '' },
    stdin: async () => Promise.resolve(options.stdin ?? ''),
    installRoot: repoRoot,
    dataRoot: options.dataRoot ?? dataRoot,
    migrationsDir: join(repoRoot, 'migrations'),
    // The two ACL seams: a temp root must not be re-ACL'd, and `icacls` must
    // not run in a test suite.
    tightenAcl: false,
    storageAcl: { run: () => undefined },
    secretsAcl: { platform: 'linux' },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };

  const words = argv.filter((token) => !token.startsWith('-'));
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq === -1) flags.set(token, true);
    else flags.set(token.slice(0, eq), token.slice(eq + 1));
  }

  const code = await runCommand(
    { words, flags, config: options.config ?? [], ctx: createCliContext(overrides) },
    version,
  );
  return { code, lines: io.lines, errors: io.errors };
}

beforeEach(() => {
  dataRoot = mkdtempSync(resolve(tmpdir(), 'agentmanager-cli-'));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

describe('agentmanager migrate', () => {
  it('creates the whole DESIGN §1.2 tree and a migrated database', async () => {
    const result = await invoke(['migrate', '--json']);
    expect(result.code).toBe(0);

    const report = JSON.parse(result.lines.join('\n')) as MigrateReport;
    expect(report.dataRoot).toBe(resolve(dataRoot));
    expect(report.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(report.changed).toBe(true);
    expect(report.applied.length).toBeGreaterThan(0);

    for (const relative of [
      'config',
      'library',
      'state',
      join('state', 'backups'),
      join('state', 'transcripts'),
      join('state', 'logs'),
      join('state', 'secrets'),
      'worktrees',
      'run',
      'cache',
    ]) {
      expect(existsSync(join(dataRoot, relative))).toBe(true);
    }
    expect(existsSync(join(dataRoot, 'state', 'agentmanager.db'))).toBe(true);
  });

  it('is idempotent: a second run applies nothing and writes no second backup', async () => {
    await invoke(['migrate', '--json']);
    const backupsAfterFirst = readdirSync(join(dataRoot, 'state', 'backups'));

    const second = await invoke(['migrate', '--json']);
    const report = JSON.parse(second.lines.join('\n')) as MigrateReport;
    expect(second.code).toBe(0);
    expect(report.applied).toEqual([]);
    expect(report.changed).toBe(false);
    expect(report.backupPath).toBeUndefined();
    expect(readdirSync(join(dataRoot, 'state', 'backups'))).toEqual(backupsAfterFirst);
  });

  it('leaves the library directory created but empty — its contents are the roster’s', async () => {
    await invoke(['migrate']);
    expect(existsSync(join(dataRoot, 'library'))).toBe(true);
    expect(readdirSync(join(dataRoot, 'library'))).toEqual([]);

    // And a re-run still does not reach inside it.
    writeFileSync(join(dataRoot, 'library', 'roster.json'), '{"schemaVersion":1}\n', 'utf8');
    await invoke(['migrate']);
    expect(readFileSync(join(dataRoot, 'library', 'roster.json'), 'utf8')).toContain(
      '"schemaVersion":1',
    );
  });

  it('closes the database, leaving no WAL siblings behind for the core to recover', async () => {
    await invoke(['migrate']);
    const state = readdirSync(join(dataRoot, 'state'));
    expect(state).toContain('agentmanager.db');
    expect(state).not.toContain('agentmanager.db-wal');
  });

  it('reports the edition the configuration resolved to', async () => {
    const result = await invoke(['migrate', '--json']);
    const report = JSON.parse(result.lines.join('\n')) as MigrateReport;
    // No config.json is written by this verb, so the fail-closed default stands.
    expect(report.edition).toBe('work');
  });
});

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

describe('agentmanager secrets set --stdin', () => {
  const token = 'sk-ant-oat01-TESTTOKENVALUE-abcdefghijklmnop';

  async function store(
    value = token,
  ): Promise<{ code: number; lines: string[]; errors: string[] }> {
    return invoke(['secrets', 'set', 'claude.oauthToken', '--stdin'], {
      stdin: `${value}\n`,
      // The env provider would write nothing; keyfile keeps the test off DPAPI
      // (which is real on this host) while still exercising the envelope.
      env: { ...process.env, AGENTMANAGER_SECRETS__PROVIDER: 'keyfile', ANTHROPIC_API_KEY: '' },
    });
  }

  it('stores a value read from standard input', async () => {
    const result = await store();
    expect(result.code).toBe(0);
    const envelope = readFileSync(join(dataRoot, 'state', 'secrets', 'secrets.json'), 'utf8');
    expect(envelope).toContain('claude.oauthToken');
  });

  it('never echoes the value, or any part of it, on stdout or stderr', async () => {
    const result = await store();
    const printed = [...result.lines, ...result.errors].join('\n');
    expect(printed).not.toContain(token);
    // Not even the four-character preview `list()` is allowed to show.
    expect(printed).not.toContain(token.slice(-4));
    expect(printed).toContain('stored secret "claude.oauthToken"');
  });

  it('never writes the plaintext into the envelope it stores', async () => {
    await store();
    const envelope = readFileSync(join(dataRoot, 'state', 'secrets', 'secrets.json'), 'utf8');
    expect(envelope).not.toContain(token);
  });

  it('writes nothing to the log directory, so no redactor has to catch it', async () => {
    await store();
    const logs = join(dataRoot, 'state', 'logs');
    const files = existsSync(logs) ? readdirSync(logs) : [];
    for (const file of files) {
      expect(readFileSync(join(logs, file), 'utf8')).not.toContain(token);
    }
  });

  it('refuses a value passed as an argument, because it would be in the command line', async () => {
    const result = await invoke(['secrets', 'set', 'claude.oauthToken', token, '--stdin'], {
      stdin: '',
    });
    expect(result.code).toBe(2);
    expect(result.errors.join('\n')).toContain('never passed as an argument');
    expect(existsSync(join(dataRoot, 'state', 'secrets', 'secrets.json'))).toBe(false);
  });

  it('requires --stdin rather than guessing where the value came from', async () => {
    const result = await invoke(['secrets', 'set', 'claude.oauthToken'], { stdin: token });
    expect(result.code).toBe(2);
    expect(result.errors.join('\n')).toContain('--stdin is required');
  });

  it('refuses an empty stdin instead of storing a blank secret', async () => {
    const result = await invoke(['secrets', 'set', 'claude.oauthToken', '--stdin'], {
      stdin: '   \r\n',
    });
    expect(result.code).toBe(2);
    expect(result.errors.join('\n')).toContain('nothing was read from standard input');
  });

  it('rejects a key outside the §3.3 namespace', async () => {
    const result = await invoke(['secrets', 'set', 'not a key!', '--stdin'], { stdin: token });
    expect(result.code).toBe(2);
    expect(result.errors.join('\n')).toContain('not a valid secret key');
  });

  it('strips the BOM and the trailing newline a PowerShell pipe adds', () => {
    expect(normaliseSecretInput('\uFEFFtoken\r\n')).toBe('token');
    expect(normaliseSecretInput('token\n')).toBe('token');
    expect(normaliseSecretInput('  token  ')).toBe('token');
    expect(normaliseSecretInput('\r\n')).toBe('');
  });
});

describe('agentmanager secrets list', () => {
  it('lists key names and metadata without decrypting anything', async () => {
    const token = 'sk-ant-oat01-LISTTOKEN-0123456789';
    await invoke(['secrets', 'set', 'claude.oauthToken', '--stdin'], {
      stdin: token,
      env: { ...process.env, AGENTMANAGER_SECRETS__PROVIDER: 'keyfile', ANTHROPIC_API_KEY: '' },
    });

    const result = await invoke(['secrets', 'list']);
    expect(result.code).toBe(0);
    const printed = result.lines.join('\n');
    expect(printed).toContain('claude.oauthToken');
    expect(printed).not.toContain(token);
  });

  it('reports an empty store without creating anything', async () => {
    const result = await invoke(['secrets', 'list']);
    expect(result.code).toBe(0);
    expect(result.lines.join('\n')).toContain('No secrets stored');
    // The critical property: listing must not construct a store, because under
    // `auto` that can create a master key as a side effect.
    expect(existsSync(join(dataRoot, 'state', 'secrets', 'master.key'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

describe('agentmanager health', () => {
  it('reports every non-Windows item Test-AgentManagerHealth.ps1 needs', async () => {
    await invoke(['migrate']);
    const result = await invoke(['health', '--json']);
    expect(result.code).toBe(0);

    const report = JSON.parse(result.lines.join('\n')) as HealthReportPayload;
    expect(report.edition).toBe('work');
    expect(report.dataRoot).toBe(resolve(dataRoot));
    expect(report.database.quickCheck).toBe('ok');
    expect(report.database.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(report.secrets.configured).toBeTruthy();
    expect(report.auth.mode).toBeTruthy();
    expect(report.auth.anthropicApiKeyPresent).toBe(false);
    expect(report.logs.directory).toBe(join(resolve(dataRoot), 'state', 'logs'));
    expect(report.core.running).toBe(false);
  });

  it('prints a single readable report when not asked for JSON', async () => {
    await invoke(['migrate']);
    const result = await invoke(['health']);
    const printed = result.lines.join('\n');
    for (const label of ['edition', 'data root', 'core', 'database', 'secrets', 'auth', 'logs']) {
      expect(printed).toContain(label);
    }
  });

  it('flags ANTHROPIC_API_KEY, which silently overrides subscription auth', async () => {
    await invoke(['migrate']);
    const result = await invoke(['health', '--json'], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-something' },
      config: ['--set', 'auth.mode=subscription'],
    });
    const report = JSON.parse(result.lines.join('\n')) as HealthReportPayload;
    expect(report.auth.anthropicApiKeyPresent).toBe(true);
    expect(report.warnings.join('\n')).toContain('ANTHROPIC_API_KEY');
  });

  it('reports a database that does not exist yet rather than creating one', async () => {
    const result = await invoke(['health', '--json']);
    const report = JSON.parse(result.lines.join('\n')) as HealthReportPayload;
    expect(report.database.exists).toBe(false);
    expect(report.database.quickCheck).toBe('missing');
    expect(existsSync(join(dataRoot, 'state', 'agentmanager.db'))).toBe(false);
  });

  it('calls a port file stale when nothing answers /healthz there (§4.2)', async () => {
    await invoke(['migrate']);
    writeFileSync(
      join(dataRoot, 'run', 'core.port'),
      JSON.stringify({
        port: 65500,
        pid: 4242,
        startedAt: '2026-01-01T00:00:00.000Z',
        edition: 'work',
      }),
      'utf8',
    );

    const result = await invoke(['health', '--json'], {
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const report = JSON.parse(result.lines.join('\n')) as HealthReportPayload;
    expect(report.core.portFilePresent).toBe(true);
    expect(report.core.running).toBe(false);
    expect(report.core.stalePortFile).toBe(true);
    expect(report.warnings.join('\n')).toContain('stale');
  });

  it('reports a running core from the port file plus a /healthz answer', async () => {
    await invoke(['migrate']);
    writeFileSync(
      join(dataRoot, 'run', 'core.port'),
      JSON.stringify({
        port: 7477,
        pid: 99,
        startedAt: '2026-01-01T00:00:00.000Z',
        edition: 'work',
      }),
      'utf8',
    );

    const answering: typeof globalThis.fetch = (input) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            requestUrl(input).includes('/healthz')
              ? { status: 'ok', version, edition: 'work', uptime: 1, phase: 'ready' }
              : { status: 'ok', modules: [], conditions: [] },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const result = await invoke(['health', '--json'], { fetch: answering });
    const report = JSON.parse(result.lines.join('\n')) as HealthReportPayload;
    expect(report.core.running).toBe(true);
    expect(report.core.url).toBe('http://127.0.0.1:7477');
    expect(report.core.api).toBeDefined();
  });

  it('--wait exits non-zero when the core never answers, which is the installer’s gate', async () => {
    await invoke(['migrate']);
    let now = 1_000_000;
    const result = await invoke(['health', '--json', '--wait=2'], {
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
      clock: () => new Date(now),
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    expect(result.code).toBe(1);
    expect(result.errors.join('\n')).toContain('did not answer /healthz');
  });

  it('--wait exits 0 as soon as the core answers', async () => {
    await invoke(['migrate']);
    writeFileSync(
      join(dataRoot, 'run', 'core.port'),
      JSON.stringify({
        port: 7477,
        pid: 99,
        startedAt: '2026-01-01T00:00:00.000Z',
        edition: 'work',
      }),
      'utf8',
    );

    let attempts = 0;
    let now = 1_000_000;
    const flaky: typeof globalThis.fetch = (input) => {
      attempts += 1;
      if (attempts < 3) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(
        new Response(
          JSON.stringify(
            requestUrl(input).includes('/healthz')
              ? { status: 'ok', version, edition: 'work', uptime: 1, phase: 'ready' }
              : { status: 'ok', modules: [], conditions: [] },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };

    const result = await invoke(['health', '--json', '--wait=30'], {
      fetch: flaky,
      clock: () => new Date(now),
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.lines.join('\n')) as HealthReportPayload;
    expect(report.core.running).toBe(true);
  });
});

describe('agentmanager <unknown>', () => {
  it('exits 2 and prints the command list', async () => {
    const result = await invoke(['nonsense']);
    expect(result.code).toBe(2);
    expect(result.errors.join('\n')).toContain('unknown command');
  });
});
