/**
 * Writing per-project settings (projects DESIGN §1.2, §1.3, §1.4; IMPLEMENTATION M4).
 *
 * `defaults.ts` reads the JSON column and is deliberately **total** — a blob
 * that will not parse must never make a project unreadable. This file is the
 * other half, and it is deliberately the opposite: a `PATCH` that carries a bad
 * value is refused, with the field named, before anything is written.
 *
 * The asymmetry is the point. A stored value that has already been accepted is
 * repaired on read because the alternative is losing the row; a value arriving
 * from a form is refused because the alternative is storing something whose
 * meaning nobody checked. Two of the refusals here exist for reasons bigger than
 * tidiness:
 *
 * - **`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` as project env names.**
 *   Architecture D2: a stray API key silently overrides subscription auth. That
 *   is a change to how the whole session authenticates, arriving through a
 *   project settings form, and it is refused at the point of writing rather than
 *   diagnosed at the point of launching.
 * - **`permissionElevation` without a reason.** §1.2: "an elevation nobody had
 *   to justify is the failure mode the reason string exists to prevent."
 *
 * What this file does **not** do is judge permission *rules*. `allow` / `deny` /
 * `ask` / `mode` are roster's vocabulary (§1.3, §7.6); the checks here are
 * shape-only — arrays of non-empty strings, a string mode — because a project
 * that validated the vocabulary would be a second, divergent definition of it.
 */
import {
  InvalidRequestError,
  ForbiddenEnvNameError,
  MissingElevationReasonError,
} from './errors.js';
import {
  isWorkspacePolicy,
  type EnvEntry,
  type PermissionElevation,
  type PermissionOverride,
  type Project,
  type ProjectDefaults,
  type RetentionSettings,
  type WorkspacePolicy,
} from './types.js';

/**
 * Environment variable names a project may never set (§1.4, D2).
 *
 * Compared case-insensitively: Windows environment lookups are, so accepting
 * `Anthropic_Api_Key` would be accepting `ANTHROPIC_API_KEY` with extra steps.
 */
export const FORBIDDEN_ENV_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

/** What `PATCH /api/projects/:id` accepts (§5). Every key is optional. */
export interface ProjectPatchRequest {
  readonly name?: string;
  readonly notes?: string;
  readonly workspacePolicy?: WorkspacePolicy;
  /** Already merged onto the project's current defaults and validated. */
  readonly defaults?: ProjectDefaults;
  /** `null` is a real instruction: go back to inheriting the globals (§3.3). */
  readonly retention?: RetentionSettings | null;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRequestError(`"${field}" must be an object.`, field);
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new InvalidRequestError(`"${field}" must be a string.`, field);
  }
  return value;
}

/** A rule list, checked for shape only — never for roster's vocabulary (§1.3). */
function readRuleList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new InvalidRequestError(`"${field}" must be an array of strings.`, field);
  }
  return value.map((entry, index) => {
    const rule = readString(entry, `${field}[${String(index)}]`);
    if (rule.trim().length === 0) {
      throw new InvalidRequestError(`"${field}[${String(index)}]" must not be empty.`, field);
    }
    return rule;
  });
}

/**
 * `allow` / `deny` / `ask` / `mode` in roster's shape (§1.3).
 *
 * `mode` is accepted as any non-empty string on purpose: roster ranks the modes
 * and drops an unknown one with a diagnostic (`permissions.ts`'s `readMode`),
 * and a copy of somebody else's ladder here would be a copy to keep in sync.
 */
export function readPermissionOverride(value: unknown, field: string): PermissionOverride {
  const record = asRecord(value, field);
  const known = new Set(['allow', 'deny', 'ask', 'mode']);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new InvalidRequestError(
        `"${field}.${key}" is not part of the permission override shape (allow, deny, ask, mode).`,
        `${field}.${key}`,
      );
    }
  }

  const allow =
    record['allow'] === undefined ? undefined : readRuleList(record['allow'], `${field}.allow`);
  const deny =
    record['deny'] === undefined ? undefined : readRuleList(record['deny'], `${field}.deny`);
  const ask = record['ask'] === undefined ? undefined : readRuleList(record['ask'], `${field}.ask`);
  let mode: string | undefined;
  if (record['mode'] !== undefined) {
    mode = readString(record['mode'], `${field}.mode`);
    if (mode.trim().length === 0) {
      throw new InvalidRequestError(`"${field}.mode" must not be empty.`, `${field}.mode`);
    }
  }

  return {
    ...(allow === undefined ? {} : { allow }),
    ...(deny === undefined ? {} : { deny }),
    ...(ask === undefined ? {} : { ask }),
    ...(mode === undefined ? {} : { mode }),
  };
}

/**
 * The one widening path (§1.2), with its mandatory reason.
 *
 * The empty `allow` list is refused too: an elevation that widens nothing is
 * either a mistake or a leftover, and storing one would put "this project has an
 * elevation" in the UI's launch warning for no grant at all.
 */
export function readPermissionElevation(value: unknown, field: string): PermissionElevation {
  const record = asRecord(value, field);
  const allow = readRuleList(record['allow'] ?? [], `${field}.allow`);
  if (allow.length === 0) {
    throw new InvalidRequestError(
      `"${field}.allow" must list at least one rule; an elevation that widens nothing is not an elevation.`,
      `${field}.allow`,
    );
  }
  const reason = record['reason'];
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new MissingElevationReasonError();
  }
  return { allow, reason };
}

/**
 * The ordered env list (§1.4).
 *
 * Order is preserved exactly as posted, because roster's single merge (§13)
 * applies the list in order and later wins — so the position of a duplicate name
 * inside the project layer is a decision the user made, not noise to normalise.
 */
export function readEnvEntries(value: unknown, field: string): readonly EnvEntry[] {
  if (!Array.isArray(value)) {
    throw new InvalidRequestError(
      `"${field}" must be an array of { name, value | secretRef }.`,
      field,
    );
  }

  return value.map((raw, index) => {
    const at = `${field}[${String(index)}]`;
    const record = asRecord(raw, at);
    const name = readString(record['name'], `${at}.name`);
    if (name.trim().length === 0) {
      throw new InvalidRequestError(`"${at}.name" must not be empty.`, `${at}.name`);
    }
    if (FORBIDDEN_ENV_NAMES.includes(name.trim().toUpperCase())) {
      throw new ForbiddenEnvNameError(name);
    }

    const hasValue = record['value'] !== undefined;
    const hasRef = record['secretRef'] !== undefined;
    if (hasValue && hasRef) {
      throw new InvalidRequestError(
        `"${at}" carries both a value and a secretRef; an entry is one or the other (DESIGN §1.4).`,
        at,
      );
    }
    if (hasRef) {
      const secretRef = readString(record['secretRef'], `${at}.secretRef`);
      if (secretRef.trim().length === 0) {
        throw new InvalidRequestError(`"${at}.secretRef" must not be empty.`, `${at}.secretRef`);
      }
      // Deliberately not resolved here. §1.4: refs stay refs until roster's
      // option compiler, which is the authorized reveal site.
      return { name, secretRef };
    }
    if (!hasValue) {
      throw new InvalidRequestError(
        `"${at}" must carry either a value or a secretRef (DESIGN §1.4).`,
        at,
      );
    }
    return { name, value: readString(record['value'], `${at}.value`) };
  });
}

/** Ordered roster agent ids (§1.2). Unknown ids are accepted and dropped lazily
 *  on read — roster deletions are not this endpoint's business. */
export function readAgentIds(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new InvalidRequestError(`"${field}" must be an array of agent ids.`, field);
  }
  return value.map((entry, index) => {
    const id = readString(entry, `${field}[${String(index)}]`);
    if (id.trim().length === 0) {
      throw new InvalidRequestError(`"${field}[${String(index)}]" must not be empty.`, field);
    }
    return id;
  });
}

/**
 * A repository-relative path to a project brief (§1.2).
 *
 * Absolute paths and `..` escapes are refused: the brief is part of the project,
 * and a settings field that can name `C:\Users\owner\.ssh\id_rsa` is a file-read
 * primitive on an API that is reachable from the tailnet (D5).
 */
export function readInstructionsPath(value: unknown, field: string): string {
  const raw = readString(value, field).trim();
  if (raw.length === 0) {
    throw new InvalidRequestError(
      `"${field}" must not be empty; omit it or send null instead.`,
      field,
    );
  }
  const normalised = raw.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(normalised) || normalised.startsWith('/') || normalised.startsWith('//')) {
    throw new InvalidRequestError(
      `"${field}" must be relative to the project folder, not an absolute path.`,
      field,
    );
  }
  if (normalised.split('/').includes('..')) {
    throw new InvalidRequestError(
      `"${field}" must stay inside the project folder ("..") is not allowed.`,
      field,
    );
  }
  return raw;
}

function readRetention(value: unknown, field: string): RetentionSettings | null {
  if (value === null) return null;
  const record = asRecord(value, field);
  const number = (key: string, fallback: number): number => {
    const raw = record[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      throw new InvalidRequestError(
        `"${field}.${key}" must be a positive number.`,
        `${field}.${key}`,
      );
    }
    return raw;
  };
  const keepPinned = record['keepPinned'];
  if (keepPinned !== undefined && typeof keepPinned !== 'boolean') {
    throw new InvalidRequestError(
      `"${field}.keepPinned" must be a boolean.`,
      `${field}.keepPinned`,
    );
  }
  return {
    transcriptDays: number('transcriptDays', 90),
    transcriptCapMb: number('transcriptCapMb', 500),
    keepPinned: keepPinned ?? true,
  };
}

/**
 * Merges a `defaults` patch onto the project's current defaults.
 *
 * Three states per key, and all three are meaningful: **absent** leaves the
 * current value alone, **`null`** clears it, and a value replaces it. Without
 * the clear case there would be no way to remove a `permissionElevation` short
 * of deleting the project, and without the absent case a UI that edits one field
 * would silently wipe the rest.
 */
export function mergeDefaults(current: ProjectDefaults, patch: unknown): ProjectDefaults {
  const record = asRecord(patch, 'defaults');
  const known = new Set([
    'agentIds',
    'overseerAgentId',
    'permissions',
    'permissionElevation',
    'env',
    'setupCommand',
    'instructionsPath',
  ]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new InvalidRequestError(
        `"defaults.${key}" is not a project default.`,
        `defaults.${key}`,
      );
    }
  }

  /** Absent → keep, `null` → clear, value → `read` it. */
  function apply<T>(
    key: string,
    current: T | undefined,
    read: (value: unknown) => T,
  ): T | undefined {
    if (!(key in record)) return current;
    const value = record[key];
    if (value === null) return undefined;
    return read(value);
  }

  const agentIds =
    'agentIds' in record
      ? record['agentIds'] === null
        ? []
        : readAgentIds(record['agentIds'], 'defaults.agentIds')
      : current.agentIds;

  const overseerAgentId = apply('overseerAgentId', current.overseerAgentId, (value) => {
    const id = readString(value, 'defaults.overseerAgentId').trim();
    if (id.length === 0) {
      throw new InvalidRequestError(
        '"defaults.overseerAgentId" must not be empty; send null to clear it.',
        'defaults.overseerAgentId',
      );
    }
    return id;
  });
  const permissions = apply('permissions', current.permissions, (value) =>
    readPermissionOverride(value, 'defaults.permissions'),
  );
  const permissionElevation = apply('permissionElevation', current.permissionElevation, (value) =>
    readPermissionElevation(value, 'defaults.permissionElevation'),
  );
  const env = apply('env', current.env, (value) => readEnvEntries(value, 'defaults.env'));
  const setupCommand = apply('setupCommand', current.setupCommand, (value) => {
    const command = readString(value, 'defaults.setupCommand').trim();
    if (command.length === 0) {
      throw new InvalidRequestError(
        '"defaults.setupCommand" must not be empty; send null to clear it.',
        'defaults.setupCommand',
      );
    }
    return command;
  });
  const instructionsPath = apply('instructionsPath', current.instructionsPath, (value) =>
    readInstructionsPath(value, 'defaults.instructionsPath'),
  );

  return {
    agentIds,
    ...(overseerAgentId === undefined ? {} : { overseerAgentId }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(permissionElevation === undefined ? {} : { permissionElevation }),
    ...(env === undefined ? {} : { env }),
    ...(setupCommand === undefined ? {} : { setupCommand }),
    ...(instructionsPath === undefined ? {} : { instructionsPath }),
  };
}

/** Validates a whole `PATCH /api/projects/:id` body against the current row. */
export function readProjectPatch(body: unknown, current: Project): ProjectPatchRequest {
  const record = asRecord(body ?? {}, 'body');
  const known = new Set(['name', 'notes', 'defaults', 'workspacePolicy', 'retention']);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new InvalidRequestError(
        `"${key}" is not patchable here. PATCH accepts name, notes, defaults, workspacePolicy and retention (DESIGN §5).`,
        key,
      );
    }
  }

  let name: string | undefined;
  if (record['name'] !== undefined) {
    name = readString(record['name'], 'name').trim();
    if (name.length === 0) {
      throw new InvalidRequestError('"name" must not be empty.', 'name');
    }
  }

  const notes = record['notes'] === undefined ? undefined : readString(record['notes'], 'notes');

  let workspacePolicy: WorkspacePolicy | undefined;
  if (record['workspacePolicy'] !== undefined) {
    if (!isWorkspacePolicy(record['workspacePolicy'])) {
      throw new InvalidRequestError(
        '"workspacePolicy" must be auto, shared or worktree.',
        'workspacePolicy',
      );
    }
    workspacePolicy = record['workspacePolicy'];
  }

  const defaults =
    record['defaults'] === undefined
      ? undefined
      : mergeDefaults(current.defaults, record['defaults']);

  const retention =
    'retention' in record ? readRetention(record['retention'], 'retention') : undefined;

  return {
    ...(name === undefined ? {} : { name }),
    ...(notes === undefined ? {} : { notes }),
    ...(workspacePolicy === undefined ? {} : { workspacePolicy }),
    ...(defaults === undefined ? {} : { defaults }),
    ...(retention === undefined ? {} : { retention }),
  };
}
