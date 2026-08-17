/**
 * The one place a CLI verb resolves configuration.
 *
 * Every verb needs the same three facts — where the data root is, which edition
 * this install is, and what the `secrets`/`retention` settings say — and all
 * three come from the five-layer loader (DESIGN §2.1), not from a second
 * parser. Passing the caller's `--edition`/`--data-root`/`--set` tokens through
 * verbatim is what keeps `agentmanager migrate --data-root X` and
 * `agentmanager --data-root X` (the service) agreeing about where X is.
 */
import { loadConfig, type LoadedConfig } from '../config/index.js';
import { dataRootPaths, type DataRootPaths } from '../storage/index.js';

import type { CommandInput } from './types.js';

export interface ResolvedInstall {
  readonly loaded: LoadedConfig;
  readonly paths: DataRootPaths;
}

/**
 * Loads configuration and resolves the §1.2 layout under it.
 *
 * Throws `ConfigError` on an invalid configuration, which
 * {@link import('./index.js').runCommand} turns into the same per-key report
 * `boot` prints — a verb must not start on a configuration the service would
 * refuse.
 */
export function resolveInstall(input: CommandInput): ResolvedInstall {
  const loaded = loadConfig({
    argv: input.config,
    env: input.ctx.env,
    ...(input.ctx.installRoot === undefined ? {} : { installRoot: input.ctx.installRoot }),
    ...(input.ctx.dataRoot === undefined ? {} : { dataRootOverride: input.ctx.dataRoot }),
  });

  const { config } = loaded;
  const paths = dataRootPaths(loaded.paths.dataRoot, {
    ...(config.library.root === null ? {} : { libraryRoot: config.library.root }),
    ...(config.projects.worktreesRoot === null
      ? {}
      : { worktreesRoot: config.projects.worktreesRoot }),
  });

  return { loaded, paths };
}
