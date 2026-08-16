/**
 * Validation failure for an agent definition.
 *
 * Shaped after foundation's `ConfigError` (config/errors.ts): one issue per
 * offending path, and a `report()` that prints them one per line. The reason is
 * roster DESIGN.md §2.3 — a definition that fails validation "is kept out of
 * the registry and surfaced as a `RosterDiagnostic` the UI can display on the
 * board — never a crash, never a silent drop". A UI can only display *which
 * field* is wrong if the error carries the path, so every issue here names one.
 *
 * Unlike `ConfigError` this is **not** fatal and carries no exit code: one
 * unloadable agent must never stop the service.
 */
import type { z } from 'zod';

import type { Diagnostic } from './contracts.js';

/** One entry of `ZodError.issues`, named without depending on a zod subpath. */
type ZodIssue = z.ZodError['issues'][number];

export interface RosterIssue {
  /**
   * Dotted path into the definition, array indices in brackets:
   * `integrations.gmail.env.GMAIL_TOKEN`, `settingSources[0]`. Empty string
   * when the problem is with the document as a whole (not an object, not JSON).
   */
  readonly path: string;
  readonly message: string;
}

/** Renders a Zod issue path the way a human would point at the field. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`;
    else if (out === '') out = String(segment);
    else out += `.${String(segment)}`;
  }
  return out;
}

/**
 * Flattens a Zod error into one issue per offending path.
 *
 * `unrecognized_keys` is expanded into one issue per key: Zod reports it
 * against the *parent* object, but "unknown top-level keys are rejected"
 * (§3) is only actionable if the message names the key that has to go.
 */
export function issuesFromZod(issues: readonly ZodIssue[]): RosterIssue[] {
  const out: RosterIssue[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        out.push({
          path: formatIssuePath([...issue.path, key]),
          message: `unknown key "${key}" — the schema is strict, so a newer export cannot silently lose fields on an older build (DESIGN §3)`,
        });
      }
      continue;
    }
    out.push({ path: formatIssuePath(issue.path), message: issue.message });
  }
  return out;
}

export class RosterValidationError extends Error {
  override readonly name = 'RosterValidationError';
  readonly issues: readonly RosterIssue[];
  /** Where the definition came from — a file path, an agent id, `import`. */
  readonly source: string | undefined;

  constructor(message: string, issues: readonly RosterIssue[], source?: string) {
    super(message);
    this.issues = issues;
    this.source = source;
  }

  /** One line per offending path; what a diagnostic or a 400 body carries. */
  report(): string {
    const head = this.source === undefined ? this.message : `${this.message} (${this.source})`;
    return [
      head,
      ...this.issues.map((i) => `  ${i.path === '' ? '<document>' : i.path}: ${i.message}`),
    ].join('\n');
  }

  /** The §2.3 board diagnostic for a definition that would not load. */
  toDiagnostic(agentId?: string): Diagnostic {
    const first = this.issues[0];
    return {
      level: 'error',
      code: 'roster.invalid-definition',
      message: this.report(),
      ...(agentId === undefined ? {} : { agentId }),
      ...(first === undefined || first.path === '' ? {} : { path: first.path }),
    };
  }
}
