/**
 * The agent definition schema (roster DESIGN.md §3), schema version 1.
 *
 * One Zod schema validates disk loads, HTTP writes and imports — §3: "the same
 * schema validates disk loads, HTTP writes, and imports. Unknown top-level keys
 * are **rejected**, not ignored, so a newer export cannot silently lose fields
 * on an older build." Every object here is a `strictObject` for that reason,
 * not only the top level: a typo in `capabilities.overser` is exactly as
 * lossy as one in the root.
 *
 * Two rules in this file are load-bearing security decisions rather than
 * validation hygiene, and both are enforced here because a schema is the
 * earliest possible moment:
 *
 * - `permissions.mode` cannot be `bypassPermissions` (§6.1) — and, on the SDK
 *   version pinned in M0, cannot be `auto` either (SDK-NOTES D1). Neither is
 *   representable, so no later layer has to defend against them.
 * - a credential-shaped `env` / `headers` key must carry a `secretRef`
 *   (§10) — see `credentialKeys.ts`.
 *
 * Imports reach *into* foundation rather than at its barrels on purpose:
 * `storage/time.js` and `secrets/keys.js` are the definitions of the timestamp
 * shape and the secret-key namespace, while `storage/index.js` would drag the
 * SQLite binding into what is a pure, dependency-free schema module.
 *
 * This module has **no dependency on the Claude Agent SDK** (M1's acceptance).
 * The SDK's option shapes appear in exactly one place, the option compiler of
 * §13, which is M4.
 */
import { z } from 'zod';

import { isSecretKey } from '../../secrets/keys.js';
import { isIsoTimestamp } from '../../storage/time.js';

import { credentialShapedKeyMessage, isCredentialShapedKey } from './credentialKeys.js';
import { agentIdProblem, RESERVED_AGENT_IDS } from './ids.js';

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/** The `schemaVersion` this build writes and is the newest it can read (§3). */
export const AGENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const nonEmpty = z.string().min(1);

/** A trimmed, single-line human string — a name, a tagline, a reason. */
const line = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value, 'must not have leading or trailing whitespace')
  .refine((value) => !/[\r\n]/.test(value), 'must be a single line');

export const agentIdSchema = z.string().superRefine((value, ctx) => {
  const problem = agentIdProblem(value);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
});

/** ISO-8601 UTC with milliseconds — foundation's one timestamp shape. */
const isoTimestamp = z
  .string()
  .refine(isIsoTimestamp, 'must be an ISO-8601 UTC timestamp (2026-08-16T10:35:00.000Z)');

/**
 * A file inside the agent folder: a bare name, no separators, no traversal.
 *
 * The folder is the unit of copy, export and version control (§2.1), so a
 * definition that could point outside it would make `.agentpack` export either
 * lossy or a directory-traversal primitive.
 */
const folderRelativeFile = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a plain file name inside the agent folder')
  .refine((value) => !value.includes('..'), 'must not contain ".."');

/**
 * A permission rule as Claude Code writes them: `Read`, `Bash(npm run test:*)`,
 * `mcp__gmail__read_*`.
 *
 * Deliberately shallow validation. The rule grammar belongs to the SDK, and
 * this module does not depend on it (§M1); what is checked is the shape that
 * would silently never match — an empty rule, stray whitespace, an unbalanced
 * scope — because a rule that never matches is a permission that was believed
 * to be in force and was not.
 */
export const permissionRuleSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value, 'must not have leading or trailing whitespace')
  .refine((value) => {
    const open = value.indexOf('(');
    return open === -1 ? !value.includes(')') : value.endsWith(')') && open > 0;
  }, 'a scoped rule must look like Tool(pattern)');

/**
 * Exported for the one caller outside a definition parse: §6's
 * `POST /api/roster/agents/:id/permissions/allow`, which takes a single rule
 * from a question card and must judge it by exactly the grammar an `agent.json`
 * is judged by. A second, laxer check on that route is how a rule the editor
 * would reject ends up in `permissions.allow` anyway.
 */
export type PermissionRule = z.infer<typeof permissionRuleSchema>;

const ruleList = z.array(permissionRuleSchema);

// ---------------------------------------------------------------------------
// Secret references (§10)
// ---------------------------------------------------------------------------

/**
 * A pointer into foundation's secret store (foundation §3.3), never a value.
 *
 * The ref format is foundation's, checked with foundation's own predicate so
 * a ref that passes validation here cannot fail to resolve for being malformed
 * at launch.
 */
export const secretRefSchema = z.strictObject({
  secretRef: nonEmpty.refine(
    isSecretKey,
    'must be a secret key: dot-separated groups of letters, digits and hyphens (mcp.gmail.token)',
  ),
});
export type SecretRef = z.infer<typeof secretRefSchema>;

/** Either a literal, or a ref — subject to the credential rule below. */
export const secretValueSchema = z.union([z.string(), secretRefSchema]);
export type SecretValue = z.infer<typeof secretValueSchema>;

/** True for the ref form; the narrowing every consumer of a value needs. */
export function isSecretRef(value: SecretValue): value is SecretRef {
  return typeof value === 'object';
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * `env` / `headers`: literal-or-ref values, with §10's credential rule applied
 * per key.
 *
 * Both the name check and the credential check run in one refinement over the
 * whole record, rather than as a key schema, for a reason worth stating: Zod
 * reports a failing *key schema* as "Invalid key in record", and a rejection
 * whose message does not say what is wrong with the key is a rejection the
 * author has to guess at. Doing both here also means a badly-named key still
 * gets its credential verdict instead of short-circuiting before it.
 */
function credentialAwareRecord(kind: 'environment variable' | 'HTTP header', pattern: RegExp) {
  return z.record(z.string(), secretValueSchema).superRefine((record, ctx) => {
    for (const [key, value] of Object.entries(record)) {
      if (!pattern.test(key) || key.length > 128) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `"${key}" is not a valid ${kind} name`,
        });
      }
      if (isCredentialShapedKey(key) && typeof value === 'string') {
        ctx.addIssue({ code: 'custom', path: [key], message: credentialShapedKeyMessage(key) });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Avatar (§3.2)
// ---------------------------------------------------------------------------

/**
 * Three kinds "so the UI never has to handle a missing image" (§3.2). The
 * `file` kind names a file inside the agent folder — never a path the API
 * could hand to a browser.
 */
export const avatarSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('emoji'),
    /** One glyph; emoji with modifiers and ZWJ sequences run long in code units. */
    value: z.string().min(1).max(16),
  }),
  z.strictObject({
    kind: z.literal('file'),
    value: folderRelativeFile,
  }),
  z.strictObject({
    kind: z.literal('initials'),
    value: z.string().regex(/^[A-Za-z0-9]{1,3}$/, 'must be one to three letters or digits'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour'),
  }),
]);
export type Avatar = z.infer<typeof avatarSchema>;

// ---------------------------------------------------------------------------
// Specialty and roles (§3.1, §11)
// ---------------------------------------------------------------------------

/** Closed in v1 (§3.1): the board colour-codes by it and the wizard must pick
 *  one. Free-form specialisation goes in `tags`. Adding a member is a schema
 *  version bump. */
export const SPECIALTIES = [
  'bug-patching',
  'feature-implementation',
  'code-review',
  'testing',
  'documentation',
  'research',
  'email-response',
  'overseer',
  'general',
] as const;
export const specialtySchema = z.enum(SPECIALTIES);
export type Specialty = z.infer<typeof specialtySchema>;

/** The closed v1 collaboration vocabulary (§3, foundation §1.4). */
export const ROLES = ['implementer', 'architect', 'skeptic', 'reviewer', 'overseer'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

// ---------------------------------------------------------------------------
// Persona (§4, §5)
// ---------------------------------------------------------------------------

export const PERSONA_MODES = ['append', 'replace'] as const;
export const personaModeSchema = z.enum(PERSONA_MODES);
export type PersonaMode = z.infer<typeof personaModeSchema>;

/** The default persona file name; §2.1 fixes the folder layout. */
export const DEFAULT_PERSONA_FILE = 'persona.md';

export const personaSchema = z.strictObject({
  /** `append` onto the `claude_code` preset by default (§5). */
  mode: personaModeSchema.default('append'),
  file: folderRelativeFile.default(DEFAULT_PERSONA_FILE),
});
export type Persona = z.infer<typeof personaSchema>;

// ---------------------------------------------------------------------------
// Model (§8)
// ---------------------------------------------------------------------------

/**
 * Aliases the wizard produces (§8). **Not** an allow-list: validation is
 * warn-not-block, "because a model released after this build ships must not
 * make an agent unloadable". The list exists so M4 can raise the diagnostic;
 * the schema accepts any non-empty string.
 */
export const MODEL_ALIASES = ['default', 'best', 'opus', 'sonnet', 'haiku', 'opusplan'] as const;

/** `EffortLevel` in the pinned SDK (SDK-NOTES §5), duplicated as a literal
 *  union so this module keeps its no-SDK-import promise. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const effortSchema = z.enum(EFFORT_LEVELS);
export type Effort = z.infer<typeof effortSchema>;

export const modelSelectionSchema = z.strictObject({
  primary: nonEmpty.max(100),
  fallback: nonEmpty.max(100).optional(),
  effort: effortSchema.optional(),
});
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

// ---------------------------------------------------------------------------
// Permissions (§6)
// ---------------------------------------------------------------------------

/**
 * The four modes roster can express, **ordered least to most permissive**:
 * `plan < dontAsk < default < acceptEdits` (§6.2). The order is load-bearing —
 * composition takes the minimum — so it is encoded as the array order and read
 * from it by {@link permissionModeRank}, rather than being restated anywhere.
 *
 * The pinned SDK declares two further members that are deliberately absent:
 * `bypassPermissions` (§6.1 — "not selectable from the roster schema at all")
 * and `auto` (SDK-NOTES D1 — a model classifier decides, so it has no place on
 * a ladder ordered by what a *human* can gate).
 */
export const PERMISSION_MODES = ['plan', 'dontAsk', 'default', 'acceptEdits'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

const UNREPRESENTABLE_MODES: Readonly<Record<string, string>> = {
  bypassPermissions:
    '"bypassPermissions" is not selectable from the roster schema: scoped deny rules are the only defence against it, and v1 provides no escape hatch (DESIGN §6.1, §16)',
  auto: '"auto" is not selectable from the roster schema: it lets a model classifier approve tool calls, which no rung of the plan < dontAsk < default < acceptEdits ladder describes (SDK-NOTES D1)',
};

export const permissionModeSchema = z.enum(PERMISSION_MODES, {
  error: (issue) => {
    const input = typeof issue.input === 'string' ? issue.input : undefined;
    const banned = input === undefined ? undefined : UNREPRESENTABLE_MODES[input];
    if (banned !== undefined) return banned;
    return `permission mode must be one of ${PERMISSION_MODES.join(' | ')}`;
  },
});

/** Position on the §6.2 ladder; `0` is the least permissive. */
export function permissionModeRank(mode: PermissionMode): number {
  return PERMISSION_MODES.indexOf(mode);
}

/**
 * A layer of permission rules — the roster baseline, a project override, or an
 * assignment scope (§6.2). Every field is optional because an override that
 * says nothing must mean "change nothing"; the compiler, not the schema,
 * decides what an absent field composes to.
 */
export const permissionSetSchema = z.strictObject({
  mode: permissionModeSchema.optional(),
  /** Auto-approve, never a restriction (§6.1) — restriction is `deny`. */
  allow: ruleList.optional(),
  deny: ruleList.optional(),
  ask: ruleList.optional(),
});
export type PermissionSet = z.infer<typeof permissionSetSchema>;

// ---------------------------------------------------------------------------
// Setting sources (§7.3)
// ---------------------------------------------------------------------------

/**
 * `project` only.
 *
 * §7.3: `user` and `local` "would load the *host machine owner's* personal
 * Claude Code configuration into every agent: their memory, their hooks, their
 * MCP servers, their output styles. That is config leakage across an identity
 * boundary and is never what the roster means." `[]` stays legal for agents
 * that must be hermetic.
 */
export const settingSourceSchema = z.enum(['project'], {
  error: (issue) => {
    const input = issue.input;
    if (input === 'user' || input === 'local') {
      return `"${input}" is rejected: it would load the host machine owner's own Claude Code configuration into this agent (DESIGN §7.3)`;
    }
    return 'the only permitted setting source is "project"';
  },
});
export type SettingSource = z.infer<typeof settingSourceSchema>;

export const DEFAULT_SETTING_SOURCES: readonly SettingSource[] = ['project'];

// ---------------------------------------------------------------------------
// Skills (§7)
// ---------------------------------------------------------------------------

const skillName = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'must be a folder name under skills/: lower-case and hyphens',
  );

export const SKILL_MODES = ['declared', 'all', 'none'] as const;
export const skillModeSchema = z.enum(SKILL_MODES);
export type SkillMode = z.infer<typeof skillModeSchema>;

/**
 * §7.2 maps `mode` onto the SDK's `skills` option. `names` must be exact —
 * "no wildcards, no padding — or the SDK throws before the process starts" —
 * so a `declared` set with nothing in it is a definition that cannot mean what
 * it says, and an unused `names` list beside `all` / `none` is a lie about what
 * the agent will load.
 */
export const skillsSchema = z
  .strictObject({
    mode: skillModeSchema,
    names: z.array(skillName).optional(),
  })
  .superRefine((value, ctx) => {
    const count = value.names?.length ?? 0;
    if (value.mode === 'declared' && count === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['names'],
        message: 'skills.mode "declared" requires at least one name',
      });
    }
    if (value.mode !== 'declared' && count > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['names'],
        message: `skills.names is only meaningful with mode "declared" (mode is "${value.mode}")`,
      });
    }
  });
export type Skills = z.infer<typeof skillsSchema>;

// ---------------------------------------------------------------------------
// Integrations (§10)
// ---------------------------------------------------------------------------

/**
 * The server name becomes the `mcp__<server>__<tool>` prefix (§10), which is
 * what permission rules match on, so the character set is the one that survives
 * that encoding unambiguously — in particular a name containing `__` would
 * make `mcp__gmail__x__y` ambiguous about where the server name ends, and the
 * ambiguity would land in a permission rule.
 */
export function integrationNameProblem(name: string): string | undefined {
  if (name.length < 1 || name.length > 64) return 'integration name must be 1–64 characters';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    return `"${name}" must be lower-case letters, digits, "-" or "_"`;
  }
  if (name.includes('__')) {
    return `"${name}" must not contain "__" — that is the MCP tool-name separator (mcp__<server>__<tool>)`;
  }
  return undefined;
}

/**
 * Why `value` is not a usable connector id, or `undefined` when it is one
 * (§10.3, WO3).
 *
 * The **integration-name rules verbatim**, because a connector id is what the
 * editor offers as the default server name for an agent that attaches it — a
 * library entry whose id could not be a server name would be a connector nobody
 * could attach under its own name. Two additions, both from the id also being a
 * folder name under `connectors/` and a segment of `/api/roster/connectors/:id`:
 * the reserved set (`nul` is not a directory on Windows; `import` collides with
 * a route), and nothing else — the character set already forbids `.`, `/` and
 * `\`, so there is no traversal to check for.
 */
export function connectorIdProblem(value: string): string | undefined {
  const problem = integrationNameProblem(value);
  if (problem !== undefined) return problem;
  if (RESERVED_AGENT_IDS.has(value)) return `connector id "${value}" is reserved`;
  return undefined;
}

/** Display-only, derived on write (§3); never read back as truth. */
const toolPrefixHint = z
  .string()
  .max(80)
  .regex(/^mcp__[a-z0-9][a-z0-9_-]*__$/, 'must look like mcp__<server>__');

const remoteUrl = z
  .url()
  .refine(
    (value) => value.startsWith('https://') || value.startsWith('http://'),
    'must be an http(s) URL',
  );

/**
 * §10's OAuth auth mode — remote transports only (WO6).
 *
 * `auth: "oauth"` is a **declaration of intent, not a credential**: it says this
 * server authorises the human through the MCP OAuth flow rather than through a
 * header this machine holds. Nothing is compiled from it, because there is
 * nothing to compile to — the SDK's `McpHttpServerConfig` / `McpSSEServerConfig`
 * carry `url`, `headers`, `tools`, `timeout` and `alwaysLoad` and no auth field
 * whatsoever (`sdk.d.ts:1037`, `:1152`), and the CLI's own MCP client performs
 * discovery and authorisation when the server answers a challenge.
 *
 * What the flag buys is that the rest of the system can *tell the two apart*. A
 * headers-bearing server whose `secretRef` will not resolve is a broken install
 * that a launch should refuse; an OAuth server with no grant yet is one human
 * tap from working. Those are different sentences, and preflight
 * (`integrations.ts`) says them differently instead of showing one "needs
 * credential" badge for both.
 */
export const INTEGRATION_AUTH_MODES = ['oauth'] as const;
export const integrationAuthSchema = z.enum(INTEGRATION_AUTH_MODES);
export type IntegrationAuth = z.infer<typeof integrationAuthSchema>;

/**
 * "OAuth means no credential of ours travels with this server."
 *
 * The rule is *credential-bearing* headers rather than headers at all: an
 * `X-Tenant: acme` routing header is not a credential, and forbidding it would
 * make the mode unusable for the servers that need one. What is refused is
 * exactly what §10 already calls a credential — a credential-shaped key, or any
 * `{ secretRef }` — because an OAuth server that also carries a bearer token is
 * two auth mechanisms whose failure modes cannot be told apart, and the whole
 * point of the mode is that there is nothing on this machine worth scavenging
 * for.
 */
function refuseCredentialHeaders(
  value: {
    readonly auth?: IntegrationAuth | undefined;
    readonly headers?: Record<string, SecretValue> | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.auth !== 'oauth') return;
  for (const [key, entry] of Object.entries(value.headers ?? {})) {
    const isRef = typeof entry === 'object' && entry !== null && 'secretRef' in entry;
    if (!isRef && !isCredentialShapedKey(key)) continue;
    ctx.addIssue({
      code: 'custom',
      path: ['headers', key],
      message:
        `auth "oauth" and a credential header are mutually exclusive: "${key}" ` +
        `${isRef ? 'carries a secretRef' : 'is credential-shaped'}. An OAuth integration ` +
        'carries no secretRef and no literal credential (DESIGN §10).',
    });
  }
}

export const integrationConfigSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('stdio'),
    command: nonEmpty.max(500),
    args: z.array(z.string()).optional(),
    env: credentialAwareRecord('environment variable', ENV_NAME_PATTERN).optional(),
    toolPrefixHint: toolPrefixHint.optional(),
    /**
     * Refused with a sentence rather than by omission. `strictObject` would
     * reject the key anyway, as "unrecognized", which is the right outcome
     * described in the wrong words: a stdio server is a child process this
     * machine starts, so there is no HTTP challenge for an authorization server
     * to answer and `auth: "oauth"` on one is not a stricter config but a config
     * that cannot mean anything.
     */
    auth: z
      .never({
        error:
          'auth "oauth" applies to remote MCP servers only (transport "http" or "sse"): a stdio ' +
          'server is a local child process with no OAuth challenge to answer (DESIGN §10)',
      })
      .optional(),
  }),
  z
    .strictObject({
      transport: z.literal('sse'),
      url: remoteUrl,
      headers: credentialAwareRecord('HTTP header', HEADER_NAME_PATTERN).optional(),
      toolPrefixHint: toolPrefixHint.optional(),
      auth: integrationAuthSchema.optional(),
    })
    .superRefine(refuseCredentialHeaders),
  z
    .strictObject({
      /** `http` only: `streamable-http` is a `.mcp.json` alias the programmatic
       *  option does not accept (§10, confirmed in SDK-NOTES §3). */
      transport: z.literal('http'),
      url: remoteUrl,
      headers: credentialAwareRecord('HTTP header', HEADER_NAME_PATTERN).optional(),
      toolPrefixHint: toolPrefixHint.optional(),
      auth: integrationAuthSchema.optional(),
    })
    .superRefine(refuseCredentialHeaders),
]);
export type IntegrationConfig = z.infer<typeof integrationConfigSchema>;

/**
 * The third shape a `integrations` entry may take: a reference into the
 * connector library (§10.3, WO3).
 *
 * `strictObject` with one key and nothing beside it. A ref that also carried,
 * say, an `env` would be an override — and an override is a second place the
 * connector is defined, which is the exact problem the library exists to remove.
 * The record **key** is still the agent-local server name, so an agent may mount
 * the same library entry under a different tool prefix by naming it differently;
 * what it cannot do is disagree with the library about what the server *is*.
 */
export const connectorIdSchema = z.string().superRefine((value, ctx) => {
  const problem = connectorIdProblem(value);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
});

export const connectorRefSchema = z.strictObject({ connector: connectorIdSchema });
export type ConnectorRef = z.infer<typeof connectorRefSchema>;

/** What an agent may attach under one server name: a config, or a reference. */
export type IntegrationAttachment = IntegrationConfig | ConnectorRef;

/** True when this attachment points at the library rather than declaring a
 *  server itself. The narrowing every resolver starts from. */
export function isConnectorRef(value: IntegrationAttachment): value is ConnectorRef {
  return 'connector' in value;
}

/** Whether a *raw* entry is shaped like a ref, before anything has validated
 *  it — which is what decides **which** schema is allowed to judge it. */
function looksLikeConnectorRef(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'connector' in value
  );
}

/**
 * One entry, judged by the schema its shape names.
 *
 * Deliberately **not** `z.union([connectorRefSchema, integrationConfigSchema])`.
 * A Zod union reports a failure as one `invalid_union` issue against the entry
 * itself, carrying both branches' complaints as nested detail — so a literal in
 * a credential-shaped `env` key would stop being an issue at
 * `integrations.gmail.env.GMAIL_TOKEN` and become one at `integrations.gmail`
 * with prose about connectors underneath it. §2.3's whole claim is that a bad
 * definition names the field that is wrong, and a UI cannot deep-link at a path
 * that is no longer reported. Dispatching on the presence of `connector` keeps
 * every existing message and every existing path exactly where they were, and
 * gives a mistyped ref the connector schema's complaint rather than three
 * transports' worth of it.
 */
function parseIntegrationAttachment(value: unknown): z.ZodSafeParseResult<IntegrationAttachment> {
  return looksLikeConnectorRef(value)
    ? connectorRefSchema.safeParse(value)
    : integrationConfigSchema.safeParse(value);
}

export type Integrations = Record<string, IntegrationAttachment>;

export const integrationsSchema = z
  .record(z.string(), z.unknown())
  .transform((record, ctx): Integrations => {
    const out: Record<string, IntegrationAttachment> = {};
    for (const [name, value] of Object.entries(record)) {
      const problem = integrationNameProblem(name);
      if (problem !== undefined) ctx.addIssue({ code: 'custom', path: [name], message: problem });
      const parsed = parseIntegrationAttachment(value);
      if (!parsed.success) {
        // Re-emitted rather than summarised: the code travels too, so
        // `issuesFromZod` still expands an `unrecognized_keys` into one issue
        // per offending key (§3).
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [name, ...issue.path] });
        }
        continue;
      }
      out[name] = parsed.data;
    }
    return out;
  });

// ---------------------------------------------------------------------------
// Capabilities (§11)
// ---------------------------------------------------------------------------

/**
 * §11: `capabilities.overseer` is the switch, and an overseer needs `overseer`
 * in `roles` — "keeps role matching uniform rather than special-casing the
 * flag". Enforced here so orchestrator never has to ask the question twice.
 */
export const capabilitiesSchema = z
  .strictObject({
    overseer: z.boolean().default(false),
    roles: z.array(roleSchema).default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<Role>();
    value.roles.forEach((role, index) => {
      if (seen.has(role)) {
        ctx.addIssue({
          code: 'custom',
          path: ['roles', index],
          message: `duplicate role "${role}"`,
        });
      }
      seen.add(role);
    });
    if (value.overseer && !seen.has('overseer')) {
      ctx.addIssue({
        code: 'custom',
        path: ['roles'],
        message: 'an agent with capabilities.overseer must list "overseer" in roles (DESIGN §11)',
      });
    }
  });
export type Capabilities = z.infer<typeof capabilitiesSchema>;

// ---------------------------------------------------------------------------
// Defaults and meta (§3)
// ---------------------------------------------------------------------------

export const agentDefaultsSchema = z.strictObject({
  maxTurns: z.number().int().min(1).max(1000).optional(),
  maxBudgetUsd: z.number().positive().max(1000).optional(),
  /** A hint to runner's concurrency cap; 1 unless heavy (§3). */
  concurrencyWeight: z.number().int().min(1).max(10).optional(),
});
export type AgentDefaults = z.infer<typeof agentDefaultsSchema>;

export const ORIGINS = ['drafted', 'manual', 'duplicated', 'imported', 'seed'] as const;
export const originSchema = z.enum(ORIGINS);
export type Origin = z.infer<typeof originSchema>;

export const agentMetaSchema = z
  .strictObject({
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    origin: originSchema,
    /** Set by duplicate (§9.2); `null` for every other origin. */
    duplicatedFrom: agentIdSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.origin === 'duplicated' && (value.duplicatedFrom ?? null) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['duplicatedFrom'],
        message: 'meta.origin "duplicated" requires meta.duplicatedFrom (DESIGN §9.2)',
      });
    }
  });
export type AgentMeta = z.infer<typeof agentMetaSchema>;

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

/**
 * `agent.json` (§3). Also the wire format of the HTTP API, which is why the
 * field names here are the field names there.
 *
 * Required: `schemaVersion`, `id`, `name`, `specialty`, `meta` — identity and
 * provenance. Everything else is optional, and the two fields DESIGN gives a
 * stated default (`persona`, `settingSources`) get it here so that a
 * hand-written minimal `agent.json` loads with the behaviour §5 and §7.3
 * describe rather than with nothing.
 *
 * `skills`, `permissions` and `capabilities` deliberately have **no** schema
 * default: what an absent permission set or an absent skill set compiles to is
 * a §6/§7.2 decision belonging to the option compiler, and a default here would
 * make it look settled.
 */
export const agentDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_SCHEMA_VERSION),
  id: agentIdSchema,
  name: line,
  avatar: avatarSchema.optional(),
  specialty: specialtySchema,
  tagline: line.optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  persona: personaSchema.prefault({}),
  model: modelSelectionSchema.optional(),
  permissions: permissionSetSchema.optional(),
  settingSources: z
    .array(settingSourceSchema)
    .max(1)
    .default([...DEFAULT_SETTING_SOURCES]),
  skills: skillsSchema.optional(),
  integrations: integrationsSchema.optional(),
  capabilities: capabilitiesSchema.optional(),
  defaults: agentDefaultsSchema.optional(),
  meta: agentMetaSchema,
});

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

/** The id type other elements join on (§1: "Every other element joins on `agentId`"). */
export type AgentId = AgentDefinition['id'];

// ---------------------------------------------------------------------------
// Immutability (§3, §9.3)
// ---------------------------------------------------------------------------

/**
 * Fields that may never change once written.
 *
 * `id` because it is the folder name and the join key every session,
 * assignment and transcript stores (§2.2, §9.3); `meta.createdAt` because
 * provenance that can be rewritten is not provenance. `PATCH /agents/:id`
 * attempting either is a 400 (M3), and this is the one definition of the set.
 */
export const IMMUTABLE_FIELDS = ['id', 'meta.createdAt'] as const;

/** The immutable fields `next` would change, as dotted paths. Empty when the
 *  update is legal. */
export function immutableFieldViolations(
  previous: AgentDefinition,
  next: AgentDefinition,
): string[] {
  const violations: string[] = [];
  if (previous.id !== next.id) violations.push('id');
  if (previous.meta.createdAt !== next.meta.createdAt) violations.push('meta.createdAt');
  return violations;
}
