/**
 * The fatal configuration error (foundation DESIGN.md §2.1).
 *
 * "Validation failure is fatal at boot with a per-key error report — a service
 * that starts on a malformed config is worse than one that refuses to." The
 * loader therefore never returns a partially valid config: it throws this,
 * carrying one issue per offending key plus the layer that supplied it, and the
 * caller turns `exitCode` into a process exit. Nothing is started in between.
 */
import type { ConfigLayer, ConfigSourceMap } from './types.js';

/** `EX_CONFIG` from sysexits.h — a configuration problem, not a usage or runtime error. */
export const CONFIG_EXIT_CODE = 78;

export type ConfigErrorCode =
  /** The merged config failed schema validation or a cross-key invariant. */
  | 'invalid-config'
  /** A config file exists but could not be read or parsed as JSON. */
  | 'unreadable-config'
  /** A `--set` / `--edition` / `--data-root` flag was malformed. */
  | 'invalid-cli'
  /** No `config/defaults.json` was found by walking up from the running module. */
  | 'install-root-not-found';

export interface ConfigIssue {
  /** Dotted config key, or `''` when the problem is with the document as a whole. */
  readonly key: string;
  readonly message: string;
  /** The layer that supplied the offending value, when it is known. */
  readonly layer?: ConfigLayer;
  /** The concrete origin within that layer (file path, `env:VAR`, `cli:--flag`). */
  readonly origin?: string;
}

function padTo(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly code: ConfigErrorCode;
  readonly issues: readonly ConfigIssue[];
  /** Non-zero, so `process.exit(err.exitCode)` is always a refusal to start. */
  readonly exitCode = CONFIG_EXIT_CODE;

  constructor(code: ConfigErrorCode, message: string, issues: readonly ConfigIssue[] = []) {
    super(message);
    this.code = code;
    this.issues = issues;
  }

  /**
   * A human-readable, one-line-per-key report. This is what a refusing boot
   * prints to stderr; it names the key, the problem, and which layer set it, so
   * the reader knows which of the five files or flags to go and fix.
   */
  report(): string {
    const lines = [this.message];
    if (this.issues.length > 0) {
      const width = Math.min(
        40,
        Math.max(...this.issues.map((issue) => (issue.key === '' ? 9 : issue.key.length))),
      );
      for (const issue of this.issues) {
        const key = issue.key === '' ? '<config>' : issue.key;
        const where =
          issue.layer === undefined
            ? ''
            : `  [${issue.layer}${issue.origin === undefined ? '' : `: ${issue.origin}`}]`;
        lines.push(`  ${padTo(key, width)}  ${issue.message}${where}`);
      }
    }
    return lines.join('\n');
  }
}

/** Attaches layer attribution to issues, so the report names the file or flag to fix. */
export function attributeIssues(
  issues: readonly Omit<ConfigIssue, 'layer' | 'origin'>[],
  sources: ConfigSourceMap,
): ConfigIssue[] {
  return issues.map((issue) => {
    const source = sources[issue.key];
    return source === undefined
      ? { key: issue.key, message: issue.message }
      : { key: issue.key, message: issue.message, layer: source.layer, origin: source.origin };
  });
}
