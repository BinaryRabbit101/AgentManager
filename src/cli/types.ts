/**
 * The shape every `agentmanager <verb>` implementation is handed.
 *
 * DESIGN §4.4's closing sentence is the whole reason this directory exists:
 * "Scripts do orchestration only — every action they take (create schema, set a
 * secret, check health) is also available through the core's CLI or API, so
 * nothing is PowerShell-only (D1)." These verbs are the other half of that
 * promise, and each one is written so the PowerShell script that calls it is a
 * thin wrapper rather than a second implementation.
 *
 * Every effect a command can have arrives through {@link CliContext}: output,
 * the environment, standard input, the clock, HTTP. That is what lets the whole
 * surface be tested against a temp data root with no console, no network and no
 * real ACL mutation.
 */
import type { TightenAclOptions } from '../storage/index.js';
import type { TightenOptions } from '../secrets/index.js';

import type { RunIo, StdinReader } from './io.js';

export interface CliContext {
  readonly io: RunIo;
  readonly env: NodeJS.ProcessEnv;
  /** The one path a secret value may take into this process (DESIGN §3.5). */
  readonly stdin: StdinReader;
  readonly fetch: typeof globalThis.fetch;
  readonly clock: () => Date;
  /** Overrides install-root discovery; tests point it at the repository root. */
  readonly installRoot?: string;
  /** Programmatic stand-in for `--data-root`; an actual flag wins over it. */
  readonly dataRoot?: string;
  /** Root holding `NNNN_*.sql`. Defaults to the packaged `migrations/`. */
  readonly migrationsDir?: string;
  /** ACL injection for `state/secrets/`, so tests mutate no real ACLs. */
  readonly secretsAcl?: TightenOptions;
  /** ACL injection for the data root itself. */
  readonly storageAcl?: TightenAclOptions;
  /** `false` skips `icacls` on a temp root. */
  readonly tightenAcl?: boolean;
  /** Injectable delay, so `health --wait` does not make the suite wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A parsed command invocation: positional words, recognised flags, config flags. */
export interface CommandInput {
  /** `['secrets', 'set', 'claude.oauthToken']` — the verb and its arguments. */
  readonly words: readonly string[];
  /** Recognised command flags, e.g. `--stdin`, `--json`, `--wait=30`. */
  readonly flags: ReadonlyMap<string, string | true>;
  /** `--edition`/`--data-root`/`--set`, passed to the loader untouched. */
  readonly config: readonly string[];
  readonly ctx: CliContext;
}

/** Reads a flag that may carry `=value`, returning `undefined` when absent. */
export function flagValue(input: CommandInput, name: string): string | undefined {
  const raw = input.flags.get(name);
  return raw === undefined || raw === true ? undefined : raw;
}

export function hasFlag(input: CommandInput, name: string): boolean {
  return input.flags.has(name);
}

/** Exit code for a command whose arguments are wrong; matches the flag parser's. */
export const USAGE_EXIT_CODE = 2;

/** Exit code for a command that ran and found the world not as required. */
export const COMMAND_FAILURE_EXIT_CODE = 1;
