/**
 * Foundation's `agentEnv`, with its `null`s resolved (foundation §2.3).
 *
 * Foundation declares `agentEnv: Record<string, string | null>` where **`null`
 * means "compute the default"**, and ships exactly one such key:
 *
 * ```jsonc
 * "agentEnv": {
 *   "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
 *   "CLAUDE_CONFIG_DIR": null            // = <dataRoot>\state\claude-config
 * }
 * ```
 *
 * Nothing resolved them: roster's `CompileSessionInput.agentEnv` takes an
 * already-resolved record and its module note says so ("computing a
 * data-root-relative path is not roster's job… the composition root owes it").
 * Runner is the composition point for a launch, so the debt is settled here, at
 * the child-environment seam next to `attachAuthEnv`.
 *
 * ## Why this is load-bearing rather than tidy
 *
 * `CLAUDE_CONFIG_DIR` decides where the CLI subprocess writes its session JSONL
 * (`$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl`, SDK-NOTES §8
 * and L14). Leave it unresolved and the engine falls back to the user's own
 * `~/.claude`, which puts AgentManager's sessions in the owner's interactive
 * history and — worse — means **`resume` after a core restart looks for state
 * under a directory we do not control** (§9.3). The directory is created here
 * for the same reason: the engine writing into a path that does not exist is a
 * failure mode discovered at the first pause, not at the first launch.
 *
 * ## An unknown `null`
 *
 * A `null` under a key with no computed default is a configuration mistake, not
 * a variable worth guessing at. It is dropped with a warning naming the key,
 * because the alternative — passing the literal string `"null"` into the child
 * environment — is the kind of bug that shows up as an unexplained tool failure
 * three layers down.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Where a `null` value comes from, keyed by variable name (foundation §2.3). */
export const AGENT_ENV_NULL_DEFAULTS: Readonly<Record<string, (paths: AgentEnvPaths) => string>> = {
  CLAUDE_CONFIG_DIR: (paths) => resolve(paths.stateDir, 'claude-config'),
};

/** The data-root paths a computed default may be relative to. */
export interface AgentEnvPaths {
  /** `<dataRoot>\state` — foundation's `DataRootPaths.state`. */
  readonly stateDir: string;
}

export interface ResolveAgentEnvOptions extends AgentEnvPaths {
  /**
   * Creates a directory a computed default points at. Defaults to a recursive
   * `mkdirSync`; injected in tests so a resolver call touches no disk.
   */
  readonly ensureDir?: (path: string) => void;
  readonly onWarn?: (message: string, detail: Record<string, unknown>) => void;
}

/** Variables whose computed default is a directory that must exist. */
const DIRECTORY_KEYS: ReadonlySet<string> = new Set(['CLAUDE_CONFIG_DIR']);

/**
 * `Record<string, string | null>` → `Record<string, string>`, ready for roster's
 * §13 environment merge.
 *
 * Order is preserved, so a caller comparing this against the configured record
 * sees the same keys in the same sequence.
 */
export function resolveAgentEnv(
  agentEnv: Readonly<Record<string, string | null>>,
  options: ResolveAgentEnvOptions,
): Record<string, string> {
  const ensureDir = options.ensureDir ?? defaultEnsureDir;
  const resolved: Record<string, string> = {};

  for (const [name, value] of Object.entries(agentEnv)) {
    if (value !== null) {
      resolved[name] = value;
      continue;
    }

    const computed = AGENT_ENV_NULL_DEFAULTS[name];
    if (computed === undefined) {
      options.onWarn?.(
        `agentEnv."${name}" is null but has no computed default; it is dropped from the agent ` +
          'environment rather than passed through as an empty or literal value (foundation §2.3).',
        { name },
      );
      continue;
    }

    const path = computed(options);
    if (DIRECTORY_KEYS.has(name)) ensureDir(path);
    resolved[name] = path;
  }

  return resolved;
}

function defaultEnsureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
