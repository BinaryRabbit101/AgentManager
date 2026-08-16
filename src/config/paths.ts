/**
 * Locating the two roots the loader needs (foundation DESIGN.md §1.2).
 *
 * The install root holds the read-only shipped layers (1 and 2); the data root
 * holds the machine-local layer (3). The data root must be resolved *before*
 * layer 3 is read, because it is what locates it — which is why
 * `AGENTMANAGER_HOME` "is the one setting that cannot live in a config file"
 * (§2.1).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError } from './errors.js';
import type { ConfigLayer } from './types.js';

/** Relative path that identifies an install root; also layer 1 itself. */
export const DEFAULTS_FILE = join('config', 'defaults.json');

export function editionFileName(edition: string): string {
  return join('config', `edition.${edition}.json`);
}

/** `<dataRoot>/config/config.json` — layer 3 (DESIGN §1.2). */
export function machineConfigFile(dataRoot: string): string {
  return join(dataRoot, 'config', 'config.json');
}

/**
 * Walks up from `startDir` looking for `config/defaults.json`.
 *
 * One rule covers all three layouts: installed (`<install>/app/config/paths.js`
 * → `<install>`), built from source (`<repo>/dist/config/paths.js` → `<repo>`)
 * and under vitest (`<repo>/src/config/paths.ts` → `<repo>`). The marker is the
 * file, not a directory called `config`, precisely because `src/config` and
 * `dist/config` are directories called `config`.
 */
export function findInstallRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, DEFAULTS_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new ConfigError(
        'install-root-not-found',
        `Could not locate the install root: no "${DEFAULTS_FILE}" found in or above "${startDir}".`,
      );
    }
    dir = parent;
  }
}

/** The install root for the running build. */
export function defaultInstallRoot(): string {
  return findInstallRoot(dirname(fileURLToPath(import.meta.url)));
}

/** `%LOCALAPPDATA%\AgentManager` (DESIGN §1.2), with non-Windows fallbacks for tests and CI. */
export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env['LOCALAPPDATA'];
  if (localAppData !== undefined && localAppData !== '') return join(localAppData, 'AgentManager');

  const userProfile = env['USERPROFILE'];
  if (userProfile !== undefined && userProfile !== '') {
    return join(userProfile, 'AppData', 'Local', 'AgentManager');
  }
  return join(homedir(), '.agentmanager');
}

export interface ResolvedDataRoot {
  readonly path: string;
  /** The layer that decided it; `defaults` means the platform default was used. */
  readonly layer: ConfigLayer;
  readonly origin: string;
}
