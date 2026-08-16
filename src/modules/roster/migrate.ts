/**
 * The schema-version seam (roster IMPLEMENTATION M1).
 *
 * `migrate` runs **before** validation, so a v2 document is brought to the
 * shape the current schema knows rather than being rejected by it. In v1 there
 * is nothing to bring forward and the function is the identity — the value of
 * having it now is that the first migration is an entry in {@link MIGRATIONS}
 * and not a redesign of the load path.
 *
 * The one thing it does do is refuse the future: §9.4 — "an import whose
 * `schemaVersion` is newer than the build is refused with the version numbers
 * named, not best-effort-parsed". That applies to a `git pull`ed library
 * (§2.3) exactly as it applies to a pack, so the check lives here rather than
 * in the importer.
 */
import { RosterValidationError } from './errors.js';
import { AGENT_SCHEMA_VERSION } from './schema.js';

/** One step from `from` to `from + 1`. Ordered; applied in sequence. */
export interface AgentMigration {
  readonly from: number;
  readonly migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
}

/** Empty in v1, and that is the point: the shape is here, unused. */
export const MIGRATIONS: readonly AgentMigration[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Brings a raw parsed document up to {@link AGENT_SCHEMA_VERSION}.
 *
 * Returns `unknown`, not `AgentDefinition`: migration produces a *candidate*,
 * and the schema is what turns a candidate into a definition. Splitting the two
 * keeps one validator rather than one per version.
 */
export function migrate(raw: unknown): unknown {
  if (!isRecord(raw)) {
    throw new RosterValidationError('agent definition is not an object', [
      { path: '', message: `expected a JSON object, got ${raw === null ? 'null' : typeof raw}` },
    ]);
  }

  const declared = raw['schemaVersion'];
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1) {
    // Not a version we can reason about — hand it to the schema, which reports
    // `schemaVersion` with the same message it would for any bad field.
    return raw;
  }

  if (declared > AGENT_SCHEMA_VERSION) {
    throw new RosterValidationError('agent definition is from a newer build', [
      {
        path: 'schemaVersion',
        message: `schema version ${String(declared)} is newer than this build understands (${String(
          AGENT_SCHEMA_VERSION,
        )}) — upgrade AgentManager rather than editing the file`,
      },
    ]);
  }

  let current = raw;
  for (const step of MIGRATIONS) {
    if (step.from < declared) continue;
    current = step.migrate(current);
  }
  return current;
}
