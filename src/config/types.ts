/**
 * Shared vocabulary for the configuration loader (foundation DESIGN.md §2.1).
 *
 * The five layers, the per-key source attribution they produce, and the
 * non-fatal warnings the loader returns as data. Warnings are values rather
 * than log calls on purpose: configuration resolves before the logger exists
 * (M3), so the loader must have no dependency on it.
 */

/** The five configuration layers, lowest precedence first. */
export const CONFIG_LAYERS = ['defaults', 'edition', 'machine', 'env', 'cli'] as const;

export type ConfigLayer = (typeof CONFIG_LAYERS)[number];

/** Which layer won a key, and the concrete thing within that layer that set it. */
export interface ConfigSource {
  readonly layer: ConfigLayer;
  /** File path, `env:VAR_NAME`, `cli:--flag`, or `registry:<owner>`. */
  readonly origin: string;
}

/** Per-key attribution, keyed by dotted path (`http.port`). Feeds `GET /api/config/effective`. */
export type ConfigSourceMap = Readonly<Record<string, ConfigSource>>;

export type ConfigWarningCode =
  /** No layer set `edition`; it fell back to `work` (DESIGN §2.2, fail closed). */
  | 'edition-defaulted'
  /** `<dataRoot>/config/config.json` does not exist. */
  | 'config-file-missing'
  /** `<install>/config/edition.<edition>.json` does not exist. */
  | 'edition-file-missing'
  /** An `AGENTMANAGER_*` variable matched no key in the composed schema. */
  | 'unknown-env-var'
  /** An `AGENTMANAGER_*` variable matched more than one key; it was ignored. */
  | 'ambiguous-env-var'
  /** `AGENTMANAGER_HOME` and `AGENTMANAGER_DATAROOT` disagree. */
  | 'data-root-conflict'
  /** `config.json` sets a `dataRoot` other than the one it was itself found under. */
  | 'data-root-ignored-for-config-location';

export interface ConfigWarning {
  readonly code: ConfigWarningCode;
  readonly message: string;
  /** Dotted config key or environment variable name the warning is about, when there is one. */
  readonly key?: string;
}

/** One layer's contribution: the values it sets and where they came from. */
export interface ConfigPatch {
  readonly values: Readonly<Record<string, unknown>>;
  readonly source: ConfigSource;
}
