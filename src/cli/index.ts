/**
 * The `agentmanager` command verbs of DESIGN §4.4.
 *
 * > "Scripts do orchestration only — every action they take (create schema, set
 * > a secret, check health) is also available through the core's CLI or API, so
 * > nothing is PowerShell-only (D1)."
 *
 * Three verbs, one per action that sentence names:
 *
 * | Verb | Called by | DESIGN |
 * |---|---|---|
 * | `secrets set <key> --stdin` | `Setup-Auth.ps1` | §3.5, §4.4 |
 * | `migrate` | `Install-AgentManager.ps1` | §1.2, §1.3, §4.4 |
 * | `health [--json] [--wait <s>]` | `Install-AgentManager.ps1`, `Test-AgentManagerHealth.ps1` | §4.2, §4.4 |
 *
 * `secrets list` rides along because `Setup-Auth.ps1` has to confirm the key it
 * just stored is there, and confirming it by reading it back would defeat the
 * point.
 *
 * Dispatch lives here rather than in `main.ts` so the composition root keeps
 * one job. `main.ts` parses arguments and decides *whether* a verb was asked
 * for; this decides which, and nothing here can start a service.
 */
import { ConfigError } from '../config/index.js';
import { StorageError } from '../storage/index.js';
import { SecretError } from '../secrets/index.js';

import { defaultIo, defaultStdin } from './io.js';
import { runHealthCommand } from './health.js';
import { runMigrateCommand } from './migrate.js';
import { runSecretsCommand } from './secrets.js';
import {
  COMMAND_FAILURE_EXIT_CODE,
  USAGE_EXIT_CODE,
  type CliContext,
  type CommandInput,
} from './types.js';

export { defaultIo, defaultStdin } from './io.js';
export type { RunIo, StdinReader } from './io.js';
export type { CliContext, CommandInput } from './types.js';
export { COMMAND_FAILURE_EXIT_CODE, USAGE_EXIT_CODE } from './types.js';
export { normaliseSecretInput } from './secrets.js';
export type { MigrateReport } from './migrate.js';
export type { HealthReportPayload } from './health.js';

/** The verbs `parseArgs` recognises as a command rather than as a stray token. */
export const COMMANDS = ['health', 'migrate', 'secrets'] as const;
export type CommandName = (typeof COMMANDS)[number];

export function isCommandName(word: string): word is CommandName {
  return (COMMANDS as readonly string[]).includes(word);
}

/** Flags a verb may carry. Anything else beginning with `--` is an error. */
export const COMMAND_FLAGS = new Set(['--stdin', '--json', '--wait']);

/** Flags that take a value, `--wait 30` or `--wait=30`. */
export const VALUED_COMMAND_FLAGS = new Set(['--wait']);

export function commandHelp(): readonly string[] {
  return [
    'Commands:',
    '  migrate                        Create the data root tree and apply the core schema',
    '  health [--json] [--wait <s>]   Report install state; --wait polls /healthz',
    '  secrets set <key> --stdin      Store a secret read from standard input',
    '  secrets list [--json]          List stored secret keys (metadata only)',
  ];
}

/** Fills in the process-shaped defaults for anything the caller did not inject. */
export function createCliContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    io: overrides.io ?? defaultIo,
    env: overrides.env ?? process.env,
    stdin: overrides.stdin ?? defaultStdin,
    fetch: overrides.fetch ?? globalThis.fetch,
    clock: overrides.clock ?? ((): Date => new Date()),
    ...(overrides.installRoot === undefined ? {} : { installRoot: overrides.installRoot }),
    ...(overrides.dataRoot === undefined ? {} : { dataRoot: overrides.dataRoot }),
    ...(overrides.migrationsDir === undefined ? {} : { migrationsDir: overrides.migrationsDir }),
    ...(overrides.secretsAcl === undefined ? {} : { secretsAcl: overrides.secretsAcl }),
    ...(overrides.storageAcl === undefined ? {} : { storageAcl: overrides.storageAcl }),
    ...(overrides.tightenAcl === undefined ? {} : { tightenAcl: overrides.tightenAcl }),
    ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
  };
}

/**
 * Runs a verb, returning its exit code.
 *
 * The three fatal shapes a verb can hit — an invalid configuration, a corrupt
 * or unmigratable database, a secret store that will not open — are reported
 * here with the same words `boot` would use, because the owner reading them has
 * the same problem either way. Anything else is reported as an unexpected
 * failure rather than swallowed; a verb that exits 0 on a surprise is what turns
 * a failed install into a mysterious one.
 */
export async function runCommand(input: CommandInput, version: string): Promise<number> {
  const verb = input.words[0];
  try {
    switch (verb) {
      case 'migrate':
        return runMigrateCommand(input);
      case 'health':
        return await runHealthCommand(input, version);
      case 'secrets':
        return await runSecretsCommand(input);
      default:
        input.ctx.io.err(`agentmanager: unknown command ${JSON.stringify(verb ?? '')}.`);
        for (const line of commandHelp()) input.ctx.io.err(line);
        return USAGE_EXIT_CODE;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      input.ctx.io.err(`agentmanager ${verb ?? ''}: ${error.report()}`);
      return error.exitCode;
    }
    if (error instanceof StorageError || error instanceof SecretError) {
      input.ctx.io.err(`agentmanager ${verb ?? ''}: ${error.message}`);
      return COMMAND_FAILURE_EXIT_CODE;
    }
    input.ctx.io.err(
      `agentmanager ${verb ?? ''}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return COMMAND_FAILURE_EXIT_CODE;
  }
}
