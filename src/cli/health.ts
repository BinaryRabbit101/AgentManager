/**
 * `agentmanager health` — the machine-readable half of
 * `Test-AgentManagerHealth.ps1` (DESIGN §4.4).
 *
 * The script's list is: "edition, resolved data root, task state and last run
 * result, listening ports, `/healthz` payload, `PRAGMA quick_check`, secret
 * provider in use, presence of `ANTHROPIC_API_KEY`, Tailscale interface
 * detection (home edition), and the last 50 log lines." Everything on that list
 * that is a fact **about the install** rather than about Windows is answered
 * here, because a diagnostic that only PowerShell can produce is a diagnostic
 * the UI and a remote support session cannot. What is left for the script is
 * exactly the Windows-shaped remainder: the scheduled task, the listening-socket
 * table and the tailnet interface.
 *
 * Two design points worth stating:
 *
 * - **It never fabricates a running core.** The discovery procedure is §4.2's,
 *   in §4.2's order — read `run/core.port`, then probe `/healthz` — so a stale
 *   file is reported as stale rather than as a service.
 * - **It touches nothing.** The database is opened read-only, the secrets
 *   directory is *read*, not opened as a store, and no directory is created. A
 *   diagnostic that repairs what it inspects cannot tell you what was wrong.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { OVERRIDING_ENV_VAR, inspectSecretsDirectory } from '../secrets/index.js';
import { quickCheckDatabaseFile, newestBackup } from '../storage/index.js';
import {
  PORT_FILENAME,
  PROBE_REQUEST_HEADERS,
  probeCore,
  readPortFile,
} from '../lifecycle/index.js';

import { resolveInstall } from './resolve.js';
import {
  COMMAND_FAILURE_EXIT_CODE,
  USAGE_EXIT_CODE,
  flagValue,
  hasFlag,
  type CommandInput,
} from './types.js';

/** How often `--wait` re-probes. Short enough to feel instant, long enough not to spin. */
export const WAIT_POLL_INTERVAL_MS = 500;

export interface HealthReportPayload {
  readonly version: string;
  readonly checkedAt: string;
  readonly edition: string;
  readonly dataRoot: string;
  readonly installRoot: string;
  readonly configFile: string | null;
  readonly editionFile: string | null;
  readonly core: {
    /** `/healthz` answered. This, not the port file, is what "running" means (§4.2). */
    readonly running: boolean;
    readonly portFile: string;
    readonly portFilePresent: boolean;
    readonly stalePortFile: boolean;
    readonly port?: number;
    readonly pid?: number;
    readonly startedAt?: string;
    readonly url?: string;
    readonly healthz?: unknown;
    /** `/api/health`'s aggregate, fetched only when `/healthz` answered. */
    readonly api?: unknown;
  };
  readonly database: {
    readonly path: string;
    readonly exists: boolean;
    readonly quickCheck: string;
    readonly schemaVersion: number | null;
    readonly newestBackup: string | null;
  };
  readonly secrets: {
    /** What configuration asked for (`auto` is a selection, never a provider). */
    readonly configured: string;
    /** What actually wrote the entries on disk, when there are any. */
    readonly onDisk: string | null;
    readonly masterKeyPresent: boolean;
    readonly keys: readonly string[];
    readonly envelopeError?: string;
  };
  readonly auth: {
    readonly mode: string;
    /** D2's silent-override hazard, checked whether or not the core is up (§3.5). */
    readonly anthropicApiKeyPresent: boolean;
  };
  readonly remote: {
    readonly moduleEnabled: boolean;
    readonly bind: string;
    readonly port: number;
  };
  readonly logs: {
    readonly directory: string;
    readonly files: readonly { readonly name: string; readonly bytes: number }[];
  };
  readonly warnings: readonly string[];
}

function listLogFiles(directory: string): { name: string; bytes: number }[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith('.log'))
      .map((name) => {
        let bytes = 0;
        try {
          bytes = statSync(join(directory, name)).size;
        } catch {
          bytes = -1;
        }
        return { name, bytes };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function collect(input: CommandInput, version: string): Promise<HealthReportPayload> {
  const { ctx } = input;
  const { loaded, paths } = resolveInstall(input);
  const config = loaded.config;
  const warnings: string[] = loaded.warnings.map((warning) => warning.message);

  // --- §4.2's discovery procedure, in order.
  const portFile = join(paths.run, PORT_FILENAME);
  const record = readPortFile(portFile);
  const probe =
    record === undefined
      ? undefined
      : await probeCore(record.port, { ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }) });

  let api: unknown;
  if (record !== undefined && probe !== undefined) {
    try {
      // `PROBE_REQUEST_HEADERS` for the same reason `probeCore` sends them: this
      // process exits moments from now, and a pooled socket that outlives the
      // command aborts the exit on Node 25.
      const response = await ctx.fetch(`http://127.0.0.1:${String(record.port)}/api/health`, {
        headers: { ...PROBE_REQUEST_HEADERS },
      });
      if (response.ok) api = await response.json();
    } catch {
      warnings.push('/healthz answered but /api/health did not; the core may still be starting.');
    }
  }
  if (record !== undefined && probe === undefined) {
    warnings.push(
      `${portFile} names port ${String(record.port)}, but nothing answers /healthz there. ` +
        'The file is stale and the next core start will overwrite it (DESIGN §4.2).',
    );
  }

  // --- The database, read-only. Skipped while the core holds it only in the
  // sense that read-only takes no lock: this is an observation, not an open.
  const quick = quickCheckDatabaseFile(paths.database);
  const backup = newestBackup(paths.backups);
  if (!quick.ok && quick.detail !== 'missing') {
    warnings.push(
      `PRAGMA quick_check on ${paths.database} reported ${quick.detail}` +
        (backup === undefined ? '' : `; the newest backup is ${backup.path}`),
    );
  }

  const secrets = inspectSecretsDirectory(paths.secrets);
  const anthropicApiKeyPresent = (ctx.env[OVERRIDING_ENV_VAR] ?? '').length > 0;
  if (anthropicApiKeyPresent && config.auth.mode === 'subscription') {
    warnings.push(
      `${OVERRIDING_ENV_VAR} is set in this environment while auth.mode is "subscription"; ` +
        'it silently overrides subscription auth (architecture D2, DESIGN §3.5).',
    );
  }

  return {
    version,
    checkedAt: ctx.clock().toISOString(),
    edition: config.edition,
    dataRoot: paths.dataRoot,
    installRoot: loaded.paths.installRoot,
    configFile: loaded.paths.configFile,
    editionFile: loaded.paths.editionFile,
    core: {
      running: probe !== undefined,
      portFile,
      portFilePresent: record !== undefined,
      stalePortFile: record !== undefined && probe === undefined,
      ...(record === undefined
        ? {}
        : {
            port: record.port,
            pid: record.pid,
            startedAt: record.startedAt,
            url: `http://127.0.0.1:${String(record.port)}`,
          }),
      ...(probe === undefined ? {} : { healthz: probe }),
      ...(api === undefined ? {} : { api }),
    },
    database: {
      path: paths.database,
      exists: existsSync(paths.database),
      quickCheck: quick.detail,
      schemaVersion: quick.schemaVersion ?? null,
      newestBackup: backup?.path ?? null,
    },
    secrets: {
      configured: config.secrets.provider,
      onDisk: secrets.providerOnDisk,
      masterKeyPresent: secrets.masterKeyPresent,
      keys: secrets.entries.map((entry) => entry.key),
      ...(secrets.envelopeError === undefined ? {} : { envelopeError: secrets.envelopeError }),
    },
    auth: { mode: config.auth.mode, anthropicApiKeyPresent },
    remote: {
      moduleEnabled: config.modules.remote.enabled,
      bind: config.remote.bind,
      port: config.remote.port,
    },
    logs: { directory: paths.logs, files: listLogFiles(paths.logs) },
    warnings,
  };
}

function print(report: HealthReportPayload, out: (line: string) => void): void {
  const row = (label: string, value: string): void => out(`${label.padEnd(16)}${value}`);
  out(`agentmanager health — ${report.checkedAt}`);
  row('version', report.version);
  row('edition', report.edition);
  row('data root', report.dataRoot);
  row('install root', report.installRoot);
  row('config file', report.configFile ?? '(none; shipped defaults are in use)');
  row(
    'core',
    report.core.running
      ? `running at ${report.core.url ?? '?'} (pid ${String(report.core.pid ?? 0)})`
      : report.core.stalePortFile
        ? `not running (stale ${PORT_FILENAME} naming port ${String(report.core.port ?? 0)})`
        : 'not running',
  );
  row(
    'database',
    report.database.exists
      ? `${report.database.path} — quick_check ${report.database.quickCheck}, user_version ${String(report.database.schemaVersion ?? 0)}`
      : `${report.database.path} — not created yet`,
  );
  row(
    'secrets',
    `configured ${report.secrets.configured}; on disk ${report.secrets.onDisk ?? '(nothing stored)'}` +
      (report.secrets.masterKeyPresent ? '; master.key present' : ''),
  );
  row('secret keys', report.secrets.keys.length === 0 ? '(none)' : report.secrets.keys.join(', '));
  row(
    'auth',
    `mode ${report.auth.mode}; ${OVERRIDING_ENV_VAR} ${report.auth.anthropicApiKeyPresent ? 'IS SET' : 'not set'}`,
  );
  row(
    'remote',
    report.remote.moduleEnabled
      ? `enabled, bind ${report.remote.bind}, port ${String(report.remote.port)}`
      : 'module disabled',
  );
  row('logs', `${report.logs.directory} (${String(report.logs.files.length)} file(s))`);
  for (const warning of report.warnings) out(`warning: ${warning}`);
}

/**
 * Runs the report, optionally polling until the core answers.
 *
 * `--wait <seconds>` is the installer's "start the core and wait for `/healthz`"
 * step (§4.4). It lives in the CLI rather than as a PowerShell retry loop for
 * the usual reason — Electron waits for exactly the same condition (§4.1), and
 * two implementations of "is it up yet" drift.
 */
export async function runHealthCommand(input: CommandInput, version: string): Promise<number> {
  const { ctx } = input;
  const json = hasFlag(input, '--json');
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  const waitRaw = flagValue(input, '--wait');
  let deadline: number | undefined;
  if (waitRaw !== undefined) {
    const seconds = Number(waitRaw);
    if (!Number.isFinite(seconds) || seconds < 0) {
      ctx.io.err(`agentmanager health: --wait expects a number of seconds, got ${waitRaw}.`);
      return USAGE_EXIT_CODE;
    }
    deadline = ctx.clock().getTime() + seconds * 1000;
  }

  let report = await collect(input, version);
  while (deadline !== undefined && !report.core.running && ctx.clock().getTime() < deadline) {
    await sleep(WAIT_POLL_INTERVAL_MS);
    report = await collect(input, version);
  }

  if (json) ctx.io.out(JSON.stringify(report, null, 2));
  else print(report, ctx.io.out);

  // Exit code carries one fact only: did the wait succeed. Without `--wait` a
  // report is a report — a support diagnostic that exits non-zero because the
  // service it was asked about is down is a diagnostic nobody can script.
  if (deadline !== undefined && !report.core.running) {
    ctx.io.err(`agentmanager health: the core did not answer /healthz within ${waitRaw ?? '0'}s.`);
    return COMMAND_FAILURE_EXIT_CODE;
  }
  return 0;
}
