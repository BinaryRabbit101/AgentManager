/**
 * `defaults_json` and `retention_json`, in and out (projects DESIGN §1.2, §3.3).
 *
 * Both columns are JSON blobs in a schema that is otherwise typed, so the parse
 * is where the types are re-established. Two rules hold throughout:
 *
 * - **Parsing is total.** No function here throws. A blob written by a newer
 *   build, hand-edited in a DB browser, or truncated by a bad restore must not
 *   make a project unreadable — the registry losing a row because one optional
 *   setting is malformed is a far worse outcome than the setting reverting to
 *   its default. Callers that want to know pass an `onWarning` sink.
 * - **Missing means default**, and the defaults are the ones the design states:
 *   `agentIds: []` for a project with no suggested agents, and §3.3's
 *   `transcriptDays` / `transcriptCapMb` / `keepPinned` for a partial retention
 *   override. `retention_json` being SQL `NULL` is different from it being `{}`:
 *   NULL means "inherit the global settings", which is why
 *   {@link parseRetention} returns `null` for it rather than a filled object.
 *
 * `agentIds` is absent from the serialized defaults on purpose: §1.2 stores the
 * default-agent list relationally in `project_default_agents` so a roster
 * deletion is resolvable without scanning JSON. The repository joins it back on
 * read.
 */
import type {
  EnvEntry,
  PermissionElevation,
  PermissionOverride,
  ProjectDefaults,
  RetentionDefaults,
  RetentionSettings,
} from './types.js';

/** Told about anything a parse had to discard. */
export type ParseWarning = (message: string) => void;

/** A project with nothing configured (§1.2). */
export const EMPTY_PROJECT_DEFAULTS: ProjectDefaults = Object.freeze({
  agentIds: Object.freeze([]),
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Non-string members are dropped: one bad entry must not lose the whole list. */
function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseJson(json: string | null | undefined, warn?: ParseWarning): unknown {
  if (json === null || json === undefined || json.trim().length === 0) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    warn?.(`stored JSON is not parseable and was ignored: ${json.slice(0, 120)}`);
    return undefined;
  }
}

function parsePermissionOverride(value: unknown): PermissionOverride | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  const allow = asStringArray(record['allow']);
  const deny = asStringArray(record['deny']);
  const ask = asStringArray(record['ask']);
  const mode = asNonEmptyString(record['mode']);

  const override: PermissionOverride = {
    ...(allow === undefined ? {} : { allow }),
    ...(deny === undefined ? {} : { deny }),
    ...(ask === undefined ? {} : { ask }),
    ...(mode === undefined ? {} : { mode }),
  };
  return Object.keys(override).length === 0 ? undefined : override;
}

/**
 * An elevation without a non-empty `reason` is dropped rather than kept.
 *
 * §1.2 enforces the reason at write time; enforcing it again on read is what
 * makes a row that got past an older build — or a hand edit — fail closed
 * instead of quietly granting the widening it never justified.
 */
function parseElevation(value: unknown, warn?: ParseWarning): PermissionElevation | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  const allow = asStringArray(record['allow']);
  const reason = asNonEmptyString(record['reason']);
  if (allow === undefined || allow.length === 0) return undefined;
  if (reason === undefined || reason.trim().length === 0) {
    warn?.('permissionElevation without a non-empty reason was dropped (§1.2)');
    return undefined;
  }
  return { allow, reason };
}

function parseEnv(value: unknown, warn?: ParseWarning): readonly EnvEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries: EnvEntry[] = [];
  for (const raw of value) {
    const record = asRecord(raw);
    const name = record === undefined ? undefined : asNonEmptyString(record['name']);
    if (record === undefined || name === undefined) {
      warn?.('an env entry without a name was dropped');
      continue;
    }
    const secretRef = asNonEmptyString(record['secretRef']);
    if (secretRef !== undefined) {
      entries.push({ name, secretRef });
      continue;
    }
    const literal = record['value'];
    if (typeof literal === 'string') {
      entries.push({ name, value: literal });
      continue;
    }
    warn?.(`env entry ${name} carried neither a value nor a secretRef and was dropped`);
  }
  return entries.length === 0 ? undefined : entries;
}

/**
 * Reads `defaults_json` into {@link ProjectDefaults}.
 *
 * `agentIds` always comes back empty: it is the repository's job to fill it from
 * `project_default_agents`.
 */
export function parseProjectDefaults(
  json: string | null | undefined,
  warn?: ParseWarning,
): ProjectDefaults {
  const record = asRecord(parseJson(json, warn));
  if (record === undefined) return EMPTY_PROJECT_DEFAULTS;

  const overseerAgentId = asNonEmptyString(record['overseerAgentId']);
  const permissions = parsePermissionOverride(record['permissions']);
  const permissionElevation = parseElevation(record['permissionElevation'], warn);
  const env = parseEnv(record['env'], warn);
  const setupCommand = asNonEmptyString(record['setupCommand']);
  const instructionsPath = asNonEmptyString(record['instructionsPath']);

  return {
    agentIds: [],
    ...(overseerAgentId === undefined ? {} : { overseerAgentId }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(permissionElevation === undefined ? {} : { permissionElevation }),
    ...(env === undefined ? {} : { env }),
    ...(setupCommand === undefined ? {} : { setupCommand }),
    ...(instructionsPath === undefined ? {} : { instructionsPath }),
  };
}

/**
 * Writes {@link ProjectDefaults} back to the column, **without `agentIds`**.
 *
 * Absent optional keys are omitted rather than written as `null`, so a default
 * that was never set leaves no trace in the column and the JSON stays readable
 * in a DB browser.
 */
export function serializeProjectDefaults(defaults: ProjectDefaults): string {
  const { agentIds: _agentIds, ...rest } = defaults;
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    record[key] = value;
  }
  return JSON.stringify(record);
}

/**
 * Reads `retention_json` (§3.3).
 *
 * @returns `null` when the column is NULL — "inherit the global settings" — and
 *   a fully populated object otherwise, with every field the blob omitted taken
 *   from `globals`.
 */
export function parseRetention(
  json: string | null | undefined,
  globals: RetentionDefaults,
  warn?: ParseWarning,
): RetentionSettings | null {
  if (json === null || json === undefined || json.trim().length === 0) return null;

  const record = asRecord(parseJson(json, warn));
  if (record === undefined) return { ...globals };

  const days = record['transcriptDays'];
  const cap = record['transcriptCapMb'];
  const pinned = record['keepPinned'];

  return {
    transcriptDays:
      typeof days === 'number' && Number.isFinite(days) && days > 0 ? days : globals.transcriptDays,
    transcriptCapMb:
      typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : globals.transcriptCapMb,
    keepPinned: typeof pinned === 'boolean' ? pinned : globals.keepPinned,
  };
}

/** `null` stays NULL in the column — the inherit-the-globals marker (§3.3). */
export function serializeRetention(retention: RetentionSettings | null | undefined): string | null {
  return retention === null || retention === undefined ? null : JSON.stringify(retention);
}
