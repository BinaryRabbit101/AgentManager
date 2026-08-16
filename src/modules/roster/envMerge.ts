/**
 * The agent environment merge (roster DESIGN.md §13, §10).
 *
 * §13: "The env merge is roster's, in one place, in this order (later wins):
 * base process env (spread, never replaced) → foundation's `agentEnv` → the
 * project's resolved entries → the assignment's."
 *
 * The spread is not a nicety. `Options.env` **replaces** the child environment
 * rather than merging it — confirmed verbatim in the pinned SDK (SDK-NOTES §3:
 * "this value REPLACES the subprocess environment entirely… Spread
 * `process.env` yourself if the subprocess still needs inherited variables like
 * `PATH`"). Losing `PATH` breaks stdio MCP servers in ways that look like MCP
 * bugs, which is why `env` containing the inherited `PATH` is one of M4's named
 * acceptance tests rather than a comment.
 *
 * This is also **the** `secretRef` resolution point for agent environments:
 * foundation §3.2 names exactly two authorized `.reveal()` call sites, and
 * roster's option compiler is one of them. "Any third call site is a review
 * failure, not a judgement call."
 */
import type { SecretResolver } from '../../secrets/index.js';

import type { Diagnostic } from './contracts.js';
import { SessionCompileError } from './sessionOptions.js';

/** Projects' `EnvEntry` (projects/types.ts §1.4), restated structurally so
 *  roster does not import a sibling module's barrel for one union. */
export interface LiteralEnvEntry {
  readonly name: string;
  readonly value: string;
}
export interface SecretEnvEntry {
  readonly name: string;
  readonly secretRef: string;
}
export type EnvEntry = LiteralEnvEntry | SecretEnvEntry;

/** One ordered contribution to the merge; `source` names it in diagnostics. */
export interface EnvLayer {
  readonly source: string;
  readonly entries: readonly EnvEntry[];
}

export interface MergedEnv {
  readonly env: Record<string, string>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface MergeEnvInput {
  /** Spread first, and never replaced. Normally `process.env`. */
  readonly base: Readonly<Record<string, string | undefined>>;
  /** In §13's order; later layers win. */
  readonly layers: readonly EnvLayer[];
  readonly secrets: SecretResolver;
  /** Names the agent in an unresolved-ref failure ("agent Priya needs secret …"). */
  readonly agentName?: string | undefined;
  readonly agentId?: string | undefined;
}

/**
 * Auth variables a later layer must not silently take over.
 *
 * Architecture D2: `ANTHROPIC_API_KEY` "silently overrides subscription auth",
 * and §14 makes it roster's job to ensure "the compiled `env` does not clobber
 * it". Roster does not *refuse* the value — a work-edition project pointing at
 * a workplace key is legitimate (D6) — it makes the override loud.
 */
const AUTH_VARIABLES: readonly string[] = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function isSecretEntry(entry: EnvEntry): entry is SecretEnvEntry {
  return 'secretRef' in entry;
}

/**
 * Merge the environment for an agent child process.
 *
 * `undefined` values in `base` are dropped rather than carried: `process.env` is
 * typed `string | undefined` and an `undefined` in `Options.env` would be
 * serialised as the string `"undefined"` by the subprocess launcher, which is a
 * worse failure than the variable being absent.
 *
 * @throws {SessionCompileError} when a `secretRef` does not resolve (§10).
 */
export async function mergeAgentEnv(input: MergeEnvInput): Promise<MergedEnv> {
  const diagnostics: Diagnostic[] = [];
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(input.base)) {
    if (value !== undefined) env[name] = value;
  }

  const who = input.agentName === undefined ? 'this agent' : `agent ${input.agentName}`;

  for (const layer of input.layers) {
    for (const entry of layer.entries) {
      let value: string;
      if (isSecretEntry(entry)) {
        const secret = await input.secrets.get(entry.secretRef);
        if (secret === undefined) {
          throw new SessionCompileError(
            `${who} needs secret \`${entry.secretRef}\` for environment variable ` +
              `${entry.name} (${layer.source}), and it is not in the secret store`,
            [
              {
                level: 'error',
                code: 'roster.secret.unresolved',
                message: `secret \`${entry.secretRef}\` did not resolve`,
                ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
                path: `${layer.source}.env.${entry.name}`,
              },
            ],
          );
        }
        // The authorized `.reveal()` site (foundation §3.2).
        value = secret.reveal();
      } else {
        value = entry.value;
      }

      if (AUTH_VARIABLES.includes(entry.name) && env[entry.name] !== value) {
        diagnostics.push({
          level: 'warn',
          code: 'roster.env.auth-override',
          message:
            `${layer.source} sets ${entry.name}, overriding the inherited value; ` +
            'it changes how this session authenticates (architecture D2)',
          ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
          path: `${layer.source}.env.${entry.name}`,
        });
      }

      env[entry.name] = value;
    }
  }

  return { env, diagnostics };
}

/**
 * Case-insensitive lookup, because Windows spells it `Path` in `process.env`
 * while everything that documents the variable calls it `PATH`. Exported so the
 * regression guard asserts on the value rather than on a casing accident.
 */
export function lookupEnv(env: Readonly<Record<string, string>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}
