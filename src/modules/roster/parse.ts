/**
 * Reading and writing `agent.json`.
 *
 * Two guarantees the rest of the element leans on:
 *
 * 1. **One validator.** Disk loads, HTTP writes and imports all go through
 *    {@link parseAgentDefinition}, so there is no path into the registry that
 *    skips a rule (§3).
 * 2. **One byte-form.** {@link serialiseAgentDefinition} is canonical: keys in
 *    schema order, records sorted, two-space indent, LF, trailing newline. The
 *    library is a git repo the user is invited to hand-edit and `git pull`
 *    (§2.1, §2.3), so a write that reorders keys would produce a diff nobody
 *    made — and `parse → serialise → parse` would not be stable, which is how
 *    an "external edit" watcher ends up fighting itself.
 */
import { RosterValidationError, issuesFromZod } from './errors.js';
import { migrate } from './migrate.js';
import { agentDefinitionSchema, isConnectorRef } from './schema.js';
import type { AgentDefinition, Avatar, IntegrationAttachment, SecretValue } from './schema.js';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type ParseResult =
  | { readonly ok: true; readonly value: AgentDefinition }
  | { readonly ok: false; readonly error: RosterValidationError };

/**
 * Validates a raw document, migrating it first.
 *
 * Never throws — the registry loads a whole directory and one bad file must
 * cost exactly one agent (§2.3).
 */
export function safeParseAgentDefinition(raw: unknown, source?: string): ParseResult {
  let candidate: unknown;
  try {
    candidate = migrate(raw);
  } catch (error) {
    if (error instanceof RosterValidationError) {
      return {
        ok: false,
        error:
          source === undefined
            ? error
            : new RosterValidationError(error.message, error.issues, source),
      };
    }
    throw error;
  }

  const result = agentDefinitionSchema.safeParse(candidate);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: new RosterValidationError(
      'agent definition is not valid',
      issuesFromZod(result.error.issues),
      source,
    ),
  };
}

/** {@link safeParseAgentDefinition}, throwing {@link RosterValidationError}. */
export function parseAgentDefinition(raw: unknown, source?: string): AgentDefinition {
  const result = safeParseAgentDefinition(raw, source);
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * Parses the text of an `agent.json`.
 *
 * A leading byte-order mark is stripped: the library is meant to be edited by
 * hand on Windows, and several editors write one. A BOM would otherwise fail as
 * a JSON syntax error whose message points at character 0 of a file that looks
 * perfectly fine.
 */
export function parseAgentDefinitionJson(text: string, source?: string): AgentDefinition {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch (error) {
    throw new RosterValidationError(
      'agent definition is not valid JSON',
      [{ path: '', message: error instanceof Error ? error.message : String(error) }],
      source,
    );
  }
  return parseAgentDefinition(raw, source);
}

// ---------------------------------------------------------------------------
// Canonical serialisation
// ---------------------------------------------------------------------------

/** Drops absent optional fields, keeping insertion order. `null` survives —
 *  `meta.duplicatedFrom: null` is a stated value, not a missing one. */
function compact(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out;
}

/** Records are keyed by author-chosen names (`env`, `headers`, integration
 *  names), so their order is sorted rather than declared. */
function sortedRecord<T, R>(
  record: Readonly<Record<string, T>>,
  map: (value: T) => R,
): Record<string, R> {
  const out: Record<string, R> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value !== undefined) out[key] = map(value);
  }
  return out;
}

function canonicalSecretValue(value: SecretValue): unknown {
  return typeof value === 'string' ? value : { secretRef: value.secretRef };
}

function canonicalAvatar(avatar: Avatar): Record<string, unknown> {
  return avatar.kind === 'initials'
    ? { kind: avatar.kind, value: avatar.value, color: avatar.color }
    : { kind: avatar.kind, value: avatar.value };
}

/**
 * One `integrations` entry in canonical form.
 *
 * Exported because `connector.json` holds the *same* config object (§10.3), and
 * a library connector whose bytes were ordered differently from the identical
 * inline integration would produce a diff that says nothing.
 */
export function canonicalIntegration(integration: IntegrationAttachment): Record<string, unknown> {
  // A reference has exactly one key, and no branch below can be reached with
  // one — resolution happens at compile and preflight, never at serialisation
  // (§10.3): what an agent authored is what its `agent.json` says.
  if (isConnectorRef(integration)) return { connector: integration.connector };
  if (integration.transport === 'stdio') {
    return compact({
      transport: integration.transport,
      command: integration.command,
      args: integration.args,
      env:
        integration.env === undefined
          ? undefined
          : sortedRecord(integration.env, canonicalSecretValue),
      toolPrefixHint: integration.toolPrefixHint,
    });
  }
  return compact({
    transport: integration.transport,
    url: integration.url,
    headers:
      integration.headers === undefined
        ? undefined
        : sortedRecord(integration.headers, canonicalSecretValue),
    toolPrefixHint: integration.toolPrefixHint,
  });
}

/** The definition as a plain object in canonical order — the shape
 *  {@link serialiseAgentDefinition} stringifies, exposed for tests and for the
 *  export writer (§9.4). */
export function canonicaliseAgentDefinition(definition: AgentDefinition): Record<string, unknown> {
  return compact({
    schemaVersion: definition.schemaVersion,
    id: definition.id,
    name: definition.name,
    avatar: definition.avatar === undefined ? undefined : canonicalAvatar(definition.avatar),
    specialty: definition.specialty,
    tagline: definition.tagline,
    tags: definition.tags,
    persona: { mode: definition.persona.mode, file: definition.persona.file },
    model:
      definition.model === undefined
        ? undefined
        : compact({
            primary: definition.model.primary,
            fallback: definition.model.fallback,
            effort: definition.model.effort,
          }),
    permissions:
      definition.permissions === undefined
        ? undefined
        : compact({
            mode: definition.permissions.mode,
            allow: definition.permissions.allow,
            deny: definition.permissions.deny,
            ask: definition.permissions.ask,
          }),
    settingSources: definition.settingSources,
    skills:
      definition.skills === undefined
        ? undefined
        : compact({ mode: definition.skills.mode, names: definition.skills.names }),
    integrations:
      definition.integrations === undefined
        ? undefined
        : sortedRecord(definition.integrations, canonicalIntegration),
    capabilities:
      definition.capabilities === undefined
        ? undefined
        : { overseer: definition.capabilities.overseer, roles: definition.capabilities.roles },
    defaults:
      definition.defaults === undefined
        ? undefined
        : compact({
            maxTurns: definition.defaults.maxTurns,
            maxBudgetUsd: definition.defaults.maxBudgetUsd,
            concurrencyWeight: definition.defaults.concurrencyWeight,
          }),
    meta: compact({
      createdAt: definition.meta.createdAt,
      updatedAt: definition.meta.updatedAt,
      origin: definition.meta.origin,
      duplicatedFrom: definition.meta.duplicatedFrom,
    }),
  });
}

/** The bytes written to `agent.json`: canonical order, two-space indent, LF,
 *  trailing newline. */
export function serialiseAgentDefinition(definition: AgentDefinition): string {
  return `${JSON.stringify(canonicaliseAgentDefinition(definition), null, 2)}\n`;
}
