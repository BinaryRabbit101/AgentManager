/**
 * Reading the individual layers (foundation DESIGN.md §2.1).
 *
 * Layers 1–3 are JSON files; layer 4 is the environment; layer 5 is the command
 * line. Layers 4 and 5 address keys by dotted path rather than by nesting, and
 * both parse a value "as JSON when the value parses as JSON, otherwise as a
 * string" — so `--set http.port=7480` is the number 7480 while
 * `AGENTMANAGER_HTTP_BIND=127.0.0.1` stays a string.
 */
import { readFileSync } from 'node:fs';

import { ConfigError } from './errors.js';
import { isPlainObject, setAtPath } from './merge.js';
import type { ConfigPatch, ConfigWarning } from './types.js';

/** Prefix for the environment layer (DESIGN §2.1 layer 4). */
export const ENV_PREFIX = 'AGENTMANAGER_';

/** The one environment variable that is not a generic key path (DESIGN §1.2, §2.1). */
export const ENV_DATA_ROOT = 'AGENTMANAGER_HOME';

/**
 * "Parsed as JSON when the value parses as JSON, otherwise as a string."
 * A Windows path, a bind address and a model alias all fail `JSON.parse` and so
 * survive as strings; numbers, booleans and `null` come through typed.
 */
export function parseScalarValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** Reads a JSON layer file. Returns `undefined` when absent; throws when unreadable. */
export function readJsonLayer(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError('unreadable-config', `Could not read config file "${path}".`, [
      { key: '', message: (cause as Error).message },
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ConfigError('unreadable-config', `Config file "${path}" is not valid JSON.`, [
      { key: '', message: (cause as Error).message },
    ]);
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError('unreadable-config', `Config file "${path}" is not valid JSON.`, [
      { key: '', message: 'Expected the file to contain a JSON object.' },
    ]);
  }
  return parsed;
}

export interface ParsedCli {
  /** One patch per flag, so each key's source names the exact flag that set it. */
  readonly patches: readonly ConfigPatch[];
  /** `--data-root`, needed before layer 3 is located. */
  readonly dataRoot?: string;
  /** `--edition`, needed before layer 2 is chosen. */
  readonly edition?: string;
}

function requireValue(flag: string, inline: string | undefined, next: string | undefined): string {
  const value = inline ?? next;
  if (value === undefined || value.startsWith('--')) {
    throw new ConfigError('invalid-cli', `Flag ${flag} requires a value.`, [
      {
        key: '',
        message: `${flag} was given without a value.`,
        layer: 'cli',
        origin: `cli:${flag}`,
      },
    ]);
  }
  return value;
}

/**
 * Parses the configuration flags out of an argument list: `--set key=value`,
 * `--edition <home|work>` and `--data-root <path>`, each also accepted in
 * `--flag=value` form.
 *
 * Arguments this loader does not own (`--version`, `--help`, …) are ignored
 * rather than rejected: the CLI surface belongs to `main.ts`, and the loader
 * must be callable on a real `process.argv` without duplicating its parser.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCli {
  const patches: ConfigPatch[] = [];
  let dataRoot: string | undefined;
  let edition: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const consumeNext = (): string => {
      const value = requireValue(flag, inline, argv[i + 1]);
      if (inline === undefined) i += 1;
      return value;
    };

    switch (flag) {
      case '--set': {
        const assignment = consumeNext();
        const split = assignment.indexOf('=');
        if (split <= 0) {
          throw new ConfigError(
            'invalid-cli',
            `--set expects key=value, received "${assignment}".`,
            [
              {
                key: '',
                message: `"${assignment}" is not a key=value assignment.`,
                layer: 'cli',
                origin: `cli:--set ${assignment}`,
              },
            ],
          );
        }
        const key = assignment.slice(0, split);
        const values: Record<string, unknown> = {};
        setAtPath(values, key, parseScalarValue(assignment.slice(split + 1)));
        patches.push({ values, source: { layer: 'cli', origin: `cli:--set ${assignment}` } });
        break;
      }
      case '--edition': {
        edition = consumeNext();
        patches.push({
          values: { edition },
          source: { layer: 'cli', origin: `cli:--edition ${edition}` },
        });
        break;
      }
      case '--data-root': {
        dataRoot = consumeNext();
        patches.push({
          values: { dataRoot },
          source: { layer: 'cli', origin: `cli:--data-root ${dataRoot}` },
        });
        break;
      }
      default:
        break;
    }
  }

  return {
    patches,
    ...(dataRoot === undefined ? {} : { dataRoot }),
    ...(edition === undefined ? {} : { edition }),
  };
}

function normalizeSegment(text: string): string {
  return text.toLowerCase().replaceAll('_', '');
}

/**
 * Resolves the underscore-separated tail of an `AGENTMANAGER_*` name against the
 * known key tree, returning every path that matches.
 *
 * The mapping is not a mechanical transform: DESIGN §2.1 gives
 * `AGENTMANAGER_RUNNER_MAXCONCURRENT` for `runner.maxConcurrent`, so matching is
 * case-insensitive and underscore-insensitive against the composed inventory.
 * Segments are also matched greedily in groups, which is how an `agentEnv` key
 * that itself contains underscores (`CLAUDE_CODE_DISABLE_AUTO_MEMORY`) resolves.
 */
export function resolveEnvKeyPath(tree: unknown, segments: readonly string[]): string[][] {
  if (segments.length === 0) return [[]];
  if (!isPlainObject(tree)) return [];

  const matches: string[][] = [];
  for (let take = 1; take <= segments.length; take += 1) {
    const candidate = normalizeSegment(segments.slice(0, take).join('_'));
    for (const key of Object.keys(tree)) {
      if (normalizeSegment(key) !== candidate) continue;
      for (const rest of resolveEnvKeyPath(tree[key], segments.slice(take))) {
        matches.push([key, ...rest]);
      }
    }
  }
  return matches;
}

export interface EnvLayer {
  readonly patches: readonly ConfigPatch[];
  readonly warnings: readonly ConfigWarning[];
  /** `AGENTMANAGER_HOME`, needed before layer 3 is located. */
  readonly dataRoot?: string;
  /** `AGENTMANAGER_EDITION`, needed before layer 2 is chosen. */
  readonly edition?: string;
}

/**
 * Builds layer 4 from the process environment, resolving each variable against
 * `keyTree` (the composed defaults, i.e. the inventory of what is configurable).
 *
 * A variable that matches nothing is a warning, not a failure: an unrelated
 * `AGENTMANAGER_*` variable in the user's environment must not stop the service,
 * but a typo that silently does nothing must still be visible.
 */
export function buildEnvLayer(env: NodeJS.ProcessEnv, keyTree: Record<string, unknown>): EnvLayer {
  const patches: ConfigPatch[] = [];
  const warnings: ConfigWarning[] = [];
  let dataRoot: string | undefined;
  let edition: string | undefined;
  let dataRootFromAlias: string | undefined;

  // Sorted so AGENTMANAGER_DATAROOT is seen before AGENTMANAGER_HOME and the
  // documented spelling ends up last, and therefore wins, in the patch order.
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith(ENV_PREFIX)) continue;
    const raw = env[name];
    if (raw === undefined) continue;

    if (name === ENV_DATA_ROOT) {
      if (dataRootFromAlias !== undefined && dataRootFromAlias !== raw) {
        warnings.push({
          code: 'data-root-conflict',
          key: ENV_DATA_ROOT,
          message:
            `${ENV_PREFIX}DATAROOT ("${dataRootFromAlias}") disagrees with ${ENV_DATA_ROOT} ` +
            `("${raw}"); ${ENV_DATA_ROOT} wins.`,
        });
      }
      dataRoot = raw;
      patches.push({ values: { dataRoot: raw }, source: { layer: 'env', origin: `env:${name}` } });
      continue;
    }

    const tail = name.slice(ENV_PREFIX.length);
    if (tail === '') continue;
    const resolved = resolveEnvKeyPath(keyTree, tail.split('_'));

    if (resolved.length === 0) {
      warnings.push({
        code: 'unknown-env-var',
        key: name,
        message: `Environment variable ${name} does not match any configuration key; it was ignored.`,
      });
      continue;
    }
    if (resolved.length > 1) {
      warnings.push({
        code: 'ambiguous-env-var',
        key: name,
        message:
          `Environment variable ${name} matches more than one configuration key ` +
          `(${resolved.map((path) => path.join('.')).join(', ')}); it was ignored.`,
      });
      continue;
    }

    const path = (resolved[0] ?? []).join('.');
    const value = parseScalarValue(raw);
    if (path === 'edition' && typeof value === 'string') edition = value;
    if (path === 'dataRoot' && typeof value === 'string') {
      dataRootFromAlias = value;
      dataRoot ??= value;
    }

    const values: Record<string, unknown> = {};
    setAtPath(values, path, value);
    patches.push({ values, source: { layer: 'env', origin: `env:${name}` } });
  }

  return {
    patches,
    warnings,
    ...(dataRoot === undefined ? {} : { dataRoot }),
    ...(edition === undefined ? {} : { edition }),
  };
}
