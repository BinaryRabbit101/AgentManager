/**
 * Configuration and edition resolution — foundation milestone M2, DESIGN.md §2.
 *
 * The public entry point is {@link loadConfig}. It resolves the five layers in
 * precedence order, validates the merged result once against the composed zod
 * schema, and returns a deep-frozen `AppConfig` together with per-key source
 * attribution and any non-fatal warnings.
 *
 * Two deliberate non-dependencies:
 *
 * - **No logger.** Configuration resolves before logging exists (M3), so
 *   warnings come back as data for the caller to log once a logger exists.
 * - **No process exit.** Failure throws {@link ConfigError}, which carries a
 *   per-key report and a non-zero `exitCode`. The composition root (M7) decides
 *   what to do with it; the loader guarantees only that nothing is half-started.
 */
import { resolve as resolvePath } from 'node:path';

import type { z } from 'zod';

import { ConfigError, attributeIssues } from './errors.js';
import type { ConfigIssue } from './errors.js';
import { buildEnvLayer, parseCliArgs, readJsonLayer } from './layers.js';
import { deepFreeze, mergePatches } from './merge.js';
import {
  DEFAULTS_FILE,
  defaultDataRoot,
  defaultInstallRoot,
  editionFileName,
  machineConfigFile,
} from './paths.js';
import type { ConfigSchemaRegistry } from './registry.js';
import { createFoundationRegistry, isEdition } from './schema.js';
import type { AppConfig, Edition } from './schema.js';
import type { ConfigPatch, ConfigSource, ConfigSourceMap, ConfigWarning } from './types.js';

export { ConfigError, CONFIG_EXIT_CODE } from './errors.js';
export type { ConfigErrorCode, ConfigIssue } from './errors.js';
export { ConfigSchemaRegistry } from './registry.js';
export type { ConfigContribution, ConfigInvariant, ConfigInvariantViolation } from './registry.js';
export {
  EDITIONS,
  WORK_EDITION_REMOTE_MESSAGE,
  createFoundationRegistry,
  editionSchema,
  foundationConfigShape,
  isEdition,
} from './schema.js';
export type { AppConfig, Edition } from './schema.js';
export { CONFIG_LAYERS } from './types.js';
export type {
  ConfigLayer,
  ConfigSource,
  ConfigSourceMap,
  ConfigWarning,
  ConfigWarningCode,
} from './types.js';
export { defaultDataRoot, findInstallRoot, machineConfigFile } from './paths.js';
export { deepFreeze } from './merge.js';

export interface LoadConfigOptions {
  /** Arguments after `node main.js`; defaults to `process.argv.slice(2)`. */
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides install-root discovery. Tests point this at a fixture directory. */
  readonly installRoot?: string;
  /** Programmatic stand-in for `--data-root`; an actual flag wins over it. */
  readonly dataRootOverride?: string;
  /** Overrides the composed schema; tests and future module registration use it. */
  readonly registry?: ConfigSchemaRegistry;
}

export interface ResolvedConfigPaths {
  readonly installRoot: string;
  /** The data root layer 3 was located under, already defaulted (never `null`). */
  readonly dataRoot: string;
  /** Layer 3's path, or `null` when no `config.json` exists. */
  readonly configFile: string | null;
  /** Layer 2's path, or `null` when the shipped edition file is missing. */
  readonly editionFile: string | null;
}

export interface LoadedConfig {
  readonly config: AppConfig;
  readonly sources: ConfigSourceMap;
  readonly warnings: readonly ConfigWarning[];
  readonly paths: ResolvedConfigPaths;
}

/** Turns zod's issue list into one entry per offending key. */
function toIssues(error: z.ZodError): Omit<ConfigIssue, 'layer' | 'origin'>[] {
  const issues: Omit<ConfigIssue, 'layer' | 'origin'>[] = [];
  for (const issue of error.issues) {
    const base = issue.path.map((segment) => String(segment));
    if (issue.code === 'unrecognized_keys') {
      // Reported against the parent object; name each unknown key instead, so the
      // report points at the line the reader has to delete.
      for (const key of issue.keys) {
        issues.push({
          key: [...base, key].join('.'),
          message: 'Unrecognised configuration key.',
        });
      }
      continue;
    }
    issues.push({ key: base.join('.'), message: issue.message });
  }
  return issues;
}

/**
 * Resolves configuration from the five layers (DESIGN §2.1), lowest to highest:
 * shipped defaults → edition file → machine-local `config.json` → environment →
 * CLI flags.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const registry = options.registry ?? createFoundationRegistry();
  const installRoot = options.installRoot ?? defaultInstallRoot();
  const warnings: ConfigWarning[] = [];

  // --- Layers 4 and 5 are parsed first: they carry the data root and the
  // edition, which decide *where* layers 2 and 3 are read from.
  const cli = parseCliArgs(options.argv ?? process.argv.slice(2));
  const registryDefaults = registry.composeDefaults();
  const envLayer = buildEnvLayer(env, registryDefaults);
  warnings.push(...envLayer.warnings);

  // AGENTMANAGER_HOME is resolved before layer 3 because it locates layer 3
  // (DESIGN §2.1); it is the one setting that cannot live in a config file.
  const cliDataRoot = cli.dataRoot ?? options.dataRootOverride;
  const dataRoot = resolvePath(cliDataRoot ?? envLayer.dataRoot ?? defaultDataRoot(env));

  // --- Layer 3, read before the merge because it may carry `edition`.
  const configFile = machineConfigFile(dataRoot);
  const machineValues = readJsonLayer(configFile);
  if (machineValues === undefined) {
    warnings.push({
      code: 'config-file-missing',
      key: 'dataRoot',
      message: `No machine-local configuration at "${configFile}"; shipped defaults are in use.`,
    });
  }

  // --- Edition decides which layer-2 file is read. Only layers 3-5 can set it:
  // the shipped defaults are what "unset" falls back to, and the edition files
  // never name themselves.
  const machineEdition = machineValues?.['edition'];
  const declaredEdition =
    cli.edition ??
    envLayer.edition ??
    (typeof machineEdition === 'string' ? machineEdition : undefined);

  let edition: Edition = 'work';
  if (declaredEdition === undefined) {
    // Fail closed (DESIGN §2.2): an unconfigured install must never open a
    // remote listener, so an absent edition resolves to `work` and says so.
    warnings.push({
      code: 'edition-defaulted',
      key: 'edition',
      message:
        'No edition is configured (checked --edition, AGENTMANAGER_EDITION and config.json); ' +
        'defaulting to "work", which never starts a remote listener.',
    });
  } else if (isEdition(declaredEdition)) {
    edition = declaredEdition;
  }
  // An unrecognised edition string is left to fail validation against the
  // `edition` key rather than being silently corrected here.

  // --- Layer 1: shipped defaults. Seeded from the registry so a module can ship
  // a namespace defaults.json does not mention, then overlaid by the file, which
  // is the documented inventory of what is configurable.
  const patches: ConfigPatch[] = registry.contributions.map((contribution) => ({
    values: { [contribution.namespace]: contribution.defaults },
    source: { layer: 'defaults', origin: `registry:${contribution.owner}` },
  }));

  const defaultsPath = resolvePath(installRoot, DEFAULTS_FILE);
  const defaultsValues = readJsonLayer(defaultsPath);
  if (defaultsValues === undefined) {
    throw new ConfigError(
      'unreadable-config',
      `Shipped defaults are missing: "${defaultsPath}" does not exist. The install is incomplete.`,
      [{ key: '', message: 'Expected layer 1 of the configuration (DESIGN §2.1).' }],
    );
  }
  patches.push({
    values: defaultsValues,
    source: { layer: 'defaults', origin: defaultsPath },
  });

  // --- Layer 2: the edition deltas.
  let editionFile: string | null = null;
  if (isEdition(declaredEdition) || declaredEdition === undefined) {
    const candidate = resolvePath(installRoot, editionFileName(edition));
    const editionValues = readJsonLayer(candidate);
    if (editionValues === undefined) {
      warnings.push({
        code: 'edition-file-missing',
        key: 'edition',
        message: `Shipped edition file "${candidate}" is missing; the "${edition}" deltas were not applied.`,
      });
    } else {
      editionFile = candidate;
      patches.push({ values: editionValues, source: { layer: 'edition', origin: candidate } });
    }
  }

  // --- Layers 3, 4 and 5.
  if (machineValues !== undefined) {
    patches.push({ values: machineValues, source: { layer: 'machine', origin: configFile } });
  }
  patches.push(...envLayer.patches);
  if (cli.dataRoot === undefined && options.dataRootOverride !== undefined) {
    patches.push({
      values: { dataRoot: options.dataRootOverride },
      source: { layer: 'cli', origin: 'cli:dataRootOverride' },
    });
  }
  patches.push(...cli.patches);

  const merged = mergePatches(patches);

  const mergedDataRoot = merged.value['dataRoot'];
  if (typeof mergedDataRoot === 'string' && resolvePath(mergedDataRoot) !== dataRoot) {
    warnings.push({
      code: 'data-root-ignored-for-config-location',
      key: 'dataRoot',
      message:
        `dataRoot resolves to "${resolvePath(mergedDataRoot)}", but layer 3 was read from ` +
        `"${configFile}". Use AGENTMANAGER_HOME or --data-root to move the whole data root, ` +
        'since a config file cannot relocate the directory it is found in.',
    });
  }

  const sources: ConfigSourceMap = Object.freeze(
    Object.fromEntries(merged.sources) as Record<string, ConfigSource>,
  );

  // --- One validation of the merged result (DESIGN §2.1). Fatal on failure.
  const parsed = registry.composeSchema().safeParse(merged.value);
  if (!parsed.success) {
    const issues = attributeIssues(toIssues(parsed.error), sources);
    throw new ConfigError(
      'invalid-config',
      `Configuration is invalid (${String(issues.length)} problem${issues.length === 1 ? '' : 's'}); refusing to start.`,
      issues,
    );
  }

  return {
    config: deepFreeze(parsed.data as AppConfig),
    sources,
    warnings,
    paths: {
      installRoot: resolvePath(installRoot),
      dataRoot,
      configFile: machineValues === undefined ? null : configFile,
      editionFile,
    },
  };
}
