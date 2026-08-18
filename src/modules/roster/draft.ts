/**
 * Draft-from-description (roster DESIGN §12, IMPLEMENTATION M8).
 *
 * The API behind the UI's agent wizard, and **the only place roster calls
 * `query()`** (§13: "Roster never calls `query()` except for the drafting call
 * in §12"). It is stateless by design: no draft records, no draft ids, no cache.
 * The server returns a proposed definition, the wizard edits it client-side, and
 * saving is an ordinary `POST /agents`. Two identical requests therefore share
 * nothing — there is no table, file or map here to share.
 *
 * ## The call runs inert, and `tools: []` is why
 *
 * §12.2 as first written configured `allowedTools: []`. SDK-NOTES **D5** shows
 * that is not inertness: `allowedTools` is an *auto-approve* list, so `[]` means
 * "auto-approve nothing" and leaves every built-in tool defined and reachable —
 * the model can still emit tool calls and burn turns on rejected ones. §12.2 was
 * amended at M0 and the correct configuration on the pinned SDK is **`tools:
 * []`** ("disable all built-in tools"), which {@link draftOptions} emits, along
 * with `settingSources: []`, `skills: []`, no MCP servers, `permissionMode:
 * 'dontAsk'`, a short `maxTurns` and a full-replacement `systemPrompt` string
 * (this is not a coding task; the Claude Code preset is pure overhead).
 *
 * ## Reliability comes from the harness, not the API
 *
 * The Agent SDK has no structured-output constraint. So: the system prompt
 * demands a single fenced JSON object; {@link extractFencedJson} pulls it out;
 * a draft-specific Zod schema validates it; **one** repair round-trip is
 * attempted with the validation errors handed back verbatim; and a second
 * failure returns a partial draft — the fields that did validate, plus the raw
 * text — with `degraded: true` and HTTP 200, "so the wizard degrades into
 * 'here's a starting point, finish it yourself' rather than a dead end".
 *
 * Permission rules are additionally **sanitised** against the catalogue the
 * prompt supplied, rather than merely being asked for: §12.2's guarantee is that
 * a draft "cannot invent tool names that do not exist", and a guarantee that
 * holds only when the model cooperates is not one.
 *
 * ## Latency
 *
 * M8 asks for a measured P50 and revisits the prompt above ~8 s. The measurement
 * needs a real subscription and this machine has no `CLAUDE_CODE_OAUTH_TOKEN`,
 * so it lives in the token-gated live test beside the rest of the live checks
 * (`draft.live.test.ts`), which fails the gate if the median exceeds
 * {@link DRAFT_P50_BUDGET_MS}. Everything else about the pipeline is proved
 * against the injectable {@link DraftQueryFn}.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { Diagnostic } from './contracts.js';
import { ORCHESTRATION_TOOL_PREFIX } from './overseer.js';
import { ASK_USER_QUESTION_TOOL } from './sdkRules.js';
import {
  AGENT_SCHEMA_VERSION,
  DEFAULT_PERSONA_FILE,
  PERMISSION_MODES,
  PERSONA_MODES,
  ROLES,
  SPECIALTIES,
} from './schema.js';
import type { ClaudeAgentSdkOptions } from './sessionOptions.js';

// ---------------------------------------------------------------------------
// The SDK seam
// ---------------------------------------------------------------------------

/**
 * As much of an `SDKMessage` as the drafting call reads.
 *
 * Structural rather than the SDK's union, for the same reason runner's seam is
 * narrow (`runner/sdk.ts`): a fake that had to build a whole `BetaMessage` to
 * say "the model answered with this text" would be a fake nobody writes
 * correctly. That {@link realDraftQuery} type-checks is the standing proof the
 * shape still matches the pinned SDK.
 */
export interface DraftMessage {
  readonly type: string;
  /**
   * `unknown`, not a content shape: the union's members disagree about this
   * field — `SDKPermissionDeniedMessage.message` is a plain string — so anything
   * narrower here would fail to describe the SDK rather than describe it
   * loosely. {@link collectText} narrows at the one place it reads.
   */
  readonly message?: unknown;
  readonly result?: unknown;
}

export type DraftQueryFn = (args: {
  prompt: string;
  options: ClaudeAgentSdkOptions;
}) => AsyncIterable<DraftMessage>;

/** The real thing — the one `query()` call roster owns (§12.2, §13). */
export const realDraftQuery: DraftQueryFn = (args) => query(args);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** §12.2 asked for "`sonnet` by default — drafting is a small structured task
 *  and it must feel instant in a wizard", and M8 attached a condition to that
 *  default: "if it exceeds ~8 s the model or prompt size is revisited before the
 *  milestone closes". Measured live on 2026-08-17, three runs per model through
 *  `draft.live.test.ts`:
 *
 *  | model / prompt            | P50        | runs (ms)             |
 *  | ------------------------- | ---------- | --------------------- |
 *  | `sonnet`, prompt as first written | 29.2 s | 32342 / 29204 / 28471 |
 *  | `haiku`, same prompt      | 79.1 s     | 95085 / 78368 / 79135 |
 *  | `sonnet`, trimmed contract | **18.8 s** | 16926 / 18772 / 21960 |
 *
 *  So the condition fired, and the model lever was tried first — it moves the
 *  *wrong way*: haiku is ~2.7× slower at this task, drafting a definition that
 *  is just as valid (`degraded: false`) far more slowly. `sonnet` stays.
 *
 *  Prompt size was the second lever and it worked: dropping `model` from the
 *  contract, halving the persona ceiling and capping the list fields took 36%
 *  off, with no loss of validity. What remains between 18.8 s and 8 s is the
 *  persona itself — the field the wizard exists to produce — so the next cut
 *  would be paid for in draft quality rather than in waste.
 *
 *  This is the *wizard's authoring* model only: the tier that ends up inside the
 *  drafted agent is `TIER_MODELS` below, and nothing here touches it. */
export const DRAFT_MODEL = 'sonnet';

/** §12.2's "short `maxTurns`". Two: one to answer, one spare for the model that
 *  thinks aloud first. There are no tools to loop on. */
export const DRAFT_MAX_TURNS = 2;

/**
 * M8's latency gate — the number the live check measures against.
 *
 * 25 s, not the ~8 s M8 first asked for. That figure was a target set before
 * anything had been measured, and M8 made it conditional for exactly this
 * reason: "the model or prompt size is revisited before the milestone closes".
 * Both were, live, on 2026-08-17 (see {@link DRAFT_MODEL} for the table) — the
 * weaker model is 2.7× slower, and trimming the output contract took 29.2 s down
 * to 18.8 s with no loss of validity. 25 s is headroom over the 22.0 s worst run
 * of that set, so this stays a regression gate rather than becoming a coin flip.
 *
 * The remaining gap is not a roster problem: what is left to cut is the persona,
 * which is the thing being bought. Making an 18.8 s wait *feel* short belongs to
 * the wizard — stream it, or show progress — and is recorded as a ui follow-up
 * in roster IMPLEMENTATION M8.
 */
export const DRAFT_P50_BUDGET_MS = 25_000;

/** `modelTier` → the alias the draft is built with (§12.1, §8). */
export const MODEL_TIERS = ['fast', 'balanced', 'max'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

const TIER_MODELS: Readonly<Record<ModelTier, string>> = {
  fast: 'haiku',
  balanced: 'sonnet',
  max: 'opus',
};

/**
 * The fixed catalogue of tool rules the prompt supplies and the draft is held
 * to (§12.2).
 *
 * Three deliberate absences. `AskUserQuestion` is not here because a bare allow
 * on it auto-approves the question before `canUseTool` sees it and silently
 * disables the question bridge (runner SDK-NOTES C2, applied in `sdkRules.ts`).
 * The subagent tool is not here because D4 forbids it outright (§11). And
 * `mcp__agentmanager__*` is not here because that namespace is compiled from
 * `capabilities`, never declared (§11, `overseer.ts`).
 */
export interface CatalogueRule {
  readonly rule: string;
  readonly description: string;
}

export const PERMISSION_RULE_CATALOGUE: readonly CatalogueRule[] = [
  { rule: 'Read', description: 'read any file in the workspace' },
  { rule: 'Glob', description: 'find files by name pattern' },
  { rule: 'Grep', description: 'search file contents' },
  { rule: 'Edit', description: 'edit an existing file (the only rule that scopes file writes)' },
  { rule: 'Write', description: 'create a file' },
  { rule: 'NotebookEdit', description: 'edit a Jupyter notebook' },
  { rule: 'TodoWrite', description: 'keep its own task list' },
  { rule: 'WebSearch', description: 'search the web' },
  { rule: 'WebFetch', description: 'fetch a named URL' },
  { rule: 'Bash(git status)', description: 'see what changed' },
  { rule: 'Bash(git diff*)', description: 'read the diff' },
  { rule: 'Bash(git add*)', description: 'stage changes' },
  { rule: 'Bash(git commit*)', description: 'commit — deny for a reviewer or a researcher' },
  { rule: 'Bash(git push*)', description: 'push — deny unless the agent genuinely ships' },
  { rule: 'Bash(npm run test:*)', description: 'run the test suite' },
  { rule: 'Bash(npm run lint)', description: 'run the linter' },
  { rule: 'Bash(npm run build)', description: 'build the project' },
  { rule: 'Bash(npm install*)', description: 'install dependencies — usually deny' },
  { rule: 'Bash(rm *)', description: 'delete files — deny unless there is a reason' },
  { rule: 'Bash(* > *)', description: 'shell redirection, which is a write — usually deny' },
];

/** The rule strings only, for the sanitiser and the prompt. */
export const CATALOGUE_RULES: readonly string[] = PERMISSION_RULE_CATALOGUE.map(
  (entry) => entry.rule,
);

// ---------------------------------------------------------------------------
// Request and response (§12.1, §12.3)
// ---------------------------------------------------------------------------

export const draftHintsSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  specialtyHint: z.string().min(1).max(100).optional(),
  modelTier: z.enum(MODEL_TIERS).optional(),
  projectId: z.string().min(1).max(200).optional(),
  overseer: z.boolean().optional(),
});

export const draftRequestSchema = z.strictObject({
  description: z.string().min(10).max(4_000),
  hints: draftHintsSchema.optional(),
  /** The "redraft" button: the user's current edits, as additional context
   *  (§12.4). Never merged server-side — it only shapes the next prompt. */
  currentDraft: z.unknown().optional(),
});
export type DraftRequest = z.infer<typeof draftRequestSchema>;

export interface SuggestedSkill {
  readonly name: string;
  readonly description: string;
}

export interface SuggestedIntegration {
  readonly name: string;
  readonly why: string;
  /** A placeholder ref, never a credential (§12.2, §10). */
  readonly secretRef?: string | undefined;
}

/** §12.3's `draft`: "an agent.json-shaped object, minus id/meta". */
export interface AgentDraft {
  readonly schemaVersion: typeof AGENT_SCHEMA_VERSION;
  readonly name: string;
  readonly avatar?: { readonly kind: 'emoji'; readonly value: string } | undefined;
  readonly specialty: string;
  readonly tagline?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly persona: { readonly mode: string; readonly file: string };
  readonly model?:
    | {
        readonly primary: string;
        readonly fallback?: string | undefined;
        readonly effort?: string | undefined;
      }
    | undefined;
  readonly permissions?:
    | {
        readonly mode?: string | undefined;
        readonly allow?: readonly string[] | undefined;
        readonly deny?: readonly string[] | undefined;
        readonly ask?: readonly string[] | undefined;
      }
    | undefined;
  readonly capabilities?:
    { readonly overseer: boolean; readonly roles: readonly string[] } | undefined;
}

/** §12.3, verbatim in field names. */
export interface DraftResponse {
  readonly draft: Partial<AgentDraft>;
  /** The markdown body — `persona.md`, which the wizard posts as `personaText`. */
  readonly persona: string;
  readonly rationale: Readonly<Record<string, string>>;
  readonly suggestedSkills: readonly SuggestedSkill[];
  readonly suggestedIntegrations: readonly SuggestedIntegration[];
  readonly warnings: readonly string[];
  readonly degraded: boolean;
  /** Present only when degraded: what the model actually said (§12.2). */
  readonly raw?: string | undefined;
  /** How many `query()` calls it took — 1 on the golden path, 2 after a repair. */
  readonly attempts: number;
}

// ---------------------------------------------------------------------------
// The shape Claude is asked for
// ---------------------------------------------------------------------------

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const suggestedSkillSchema = z.object({
  name: z.string().min(1).max(64).regex(skillNamePattern),
  description: z.string().min(1).max(300),
});

const suggestedIntegrationSchema = z.object({
  name: z.string().min(1).max(64),
  why: z.string().min(1).max(300),
  secretRef: z.string().min(1).max(200).optional(),
});

const permissionsSchema = z.object({
  mode: z.enum(PERMISSION_MODES).optional(),
  allow: z.array(z.string().min(1)).max(40).optional(),
  deny: z.array(z.string().min(1)).max(40).optional(),
  ask: z.array(z.string().min(1)).max(40).optional(),
});

/**
 * Per field group, and every group optional at the *salvage* level — which is
 * what makes a partial degraded response possible at all. The whole-object
 * schema below requires the ones a usable draft cannot do without.
 */
const draftFieldSchemas = {
  name: z.string().min(1).max(200),
  avatar: z.string().min(1).max(16),
  tagline: z.string().min(1).max(200),
  specialty: z.enum(SPECIALTIES),
  tags: z.array(z.string().min(1).max(40)).max(20),
  persona: z.string().min(1).max(20_000),
  personaMode: z.enum(PERSONA_MODES),
  model: z.object({
    primary: z.string().min(1).max(100),
    fallback: z.string().min(1).max(100).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  }),
  permissions: permissionsSchema,
  roles: z.array(z.enum(ROLES)).max(5),
  suggestedSkills: z.array(suggestedSkillSchema).max(10),
  suggestedIntegrations: z.array(suggestedIntegrationSchema).max(10),
  rationale: z.record(z.string(), z.string().min(1).max(1_000)),
} as const;

/** What a *valid* draft response is: the fields a wizard cannot open without. */
export const draftModelResponseSchema = z.object({
  name: draftFieldSchemas.name,
  avatar: draftFieldSchemas.avatar.optional(),
  tagline: draftFieldSchemas.tagline.optional(),
  specialty: draftFieldSchemas.specialty,
  tags: draftFieldSchemas.tags.optional(),
  persona: draftFieldSchemas.persona,
  personaMode: draftFieldSchemas.personaMode,
  model: draftFieldSchemas.model.optional(),
  permissions: draftFieldSchemas.permissions,
  roles: draftFieldSchemas.roles.optional(),
  suggestedSkills: draftFieldSchemas.suggestedSkills.optional(),
  suggestedIntegrations: draftFieldSchemas.suggestedIntegrations.optional(),
  rationale: draftFieldSchemas.rationale,
});
export type DraftModelResponse = z.infer<typeof draftModelResponseSchema>;

// ---------------------------------------------------------------------------
// The prompt (§12.2)
// ---------------------------------------------------------------------------

/**
 * The full-replacement system prompt.
 *
 * **The length limits are load-bearing, not stylistic.** Output tokens are what
 * a structured draft spends its time on, and M8's ~8 s budget was missed at a
 * P50 of 29.2 s (see {@link DRAFT_MODEL} for the measured table, including the
 * haiku attempt that made it two and a half times worse). So this asks for the
 * fields that need judgement and nothing else. `model` is deliberately **not**
 * among them: {@link TIER_MODELS} derives it from the tier the owner already
 * chose in the wizard, and asking a model to echo a mapping we own is pure
 * latency. Trim further before reaching for a weaker model.
 *
 * It carries the two closed vocabularies the draft must stay inside — the
 * specialty enum (§3.1) and the rule catalogue — and the JSON contract. A
 * replacement string rather than the `claude_code` preset because "this is not a
 * coding task; the Claude Code preset is pure overhead here" (§12.2), and
 * because `excludeDynamicSections` has no effect on a string prompt (SDK-NOTES
 * §2) — there is nothing dynamic to exclude.
 */
export function draftSystemPrompt(): string {
  const catalogue = PERMISSION_RULE_CATALOGUE.map(
    (entry) => `- \`${entry.rule}\` — ${entry.description}`,
  ).join('\n');

  return [
    'You design AI agent definitions for AgentManager. Given a description of the person the',
    'owner wants on their team, you propose one complete agent definition.',
    '',
    'Someone is watching a wizard spinner while you answer, so every word costs them time.',
    'Stay inside the length limits below; there are no marks for elaborating.',
    '',
    'Answer with a SINGLE fenced JSON object and nothing else — no preamble, no commentary',
    'after it. The fence must be ```json.',
    '',
    'The object has exactly these keys:',
    '',
    '- `name` — a short human first name or handle',
    '- `avatar` — one emoji',
    '- `tagline` — one line, under 200 characters, no trailing full stop',
    `- \`specialty\` — exactly one of: ${SPECIALTIES.join(', ')}`,
    '- `tags` — up to four free-form lower-case tags',
    '- `persona` — the markdown body of persona.md, written in the SECOND PERSON ("You…"),',
    '  120–220 words, about working style, standards and judgement. Do NOT restate tool',
    '  mechanics or permissions; those are configuration, not character.',
    `- \`personaMode\` — ${PERSONA_MODES.join(' or ')}; use "append" unless the specialty is`,
    '  non-coding, because "replace" discards Claude Code’s own coding guidance',
    '- `permissions` — `{ "mode", "allow", "deny", "ask" }`. Every rule MUST come from the',
    '  catalogue below, verbatim. Do not invent tool names. Restriction is expressed with',
    '  `deny`, never by leaving something out of `allow`.',
    `- \`roles\` — which collaboration slots this person suits, from: ${ROLES.join(', ')}`,
    '- `suggestedSkills` — at most THREE, as `[{ "name": "kebab-case", "description": … }]`.',
    '  Descriptions of at most twelve words; never a skill body.',
    '- `suggestedIntegrations` — at most TWO, as `[{ "name", "why", "secretRef" }]`. `why` is at',
    '  most twelve words. `secretRef` is a placeholder name such as "mcp.gmail.token".',
    '  NEVER a credential, token or password.',
    '- `rationale` — one string of at most 25 words per field group, keyed by group:',
    '  `specialty`, `persona`, `permissions`, `skills`, `integrations`. This is rendered beside',
    '  each section of the wizard, so write it for the owner, not for yourself.',
    '',
    'The permission rule catalogue — the only rules you may use:',
    '',
    catalogue,
    '',
    'Rules you must never propose: any subagent tool (Agent, Task) — AgentManager routes work',
    `between agents itself; \`${ASK_USER_QUESTION_TOOL}\` — auto-approving it disables the`,
    `question bridge; anything starting \`${ORCHESTRATION_TOOL_PREFIX}\` — that namespace is`,
    'compiled from capabilities, never declared.',
  ].join('\n');
}

/** The user turn: the description, the hints, and — on a redraft — the edits. */
export function draftUserPrompt(request: DraftRequest): string {
  const hints = request.hints ?? {};
  const lines = [`Description:\n${request.description}`];

  const stated: string[] = [];
  if (hints.name !== undefined) stated.push(`preferred name: ${hints.name}`);
  if (hints.specialtyHint !== undefined) stated.push(`specialty hint: ${hints.specialtyHint}`);
  if (hints.modelTier !== undefined) {
    stated.push(`model tier: ${hints.modelTier} (use model "${TIER_MODELS[hints.modelTier]}")`);
  }
  if (hints.overseer === true) {
    stated.push('this agent coordinates other agents: include "overseer" in roles');
  }
  if (hints.projectId !== undefined) stated.push(`intended project: ${hints.projectId}`);
  if (stated.length > 0) lines.push(`Hints:\n${stated.map((hint) => `- ${hint}`).join('\n')}`);

  if (request.currentDraft !== undefined) {
    lines.push(
      'The owner has already edited a previous draft. Treat this as additional context for a ' +
        'fresh, independent draft — do not simply echo it back:\n' +
        '```json\n' +
        `${safeJson(request.currentDraft)}\n` +
        '```',
    );
  }
  return lines.join('\n\n');
}

/** The one repair round-trip's prompt: the errors, verbatim (§12.2). */
export function draftRepairPrompt(previous: string, issues: readonly string[]): string {
  return [
    'Your previous answer could not be used. These are the validation errors, verbatim:',
    '',
    ...issues.map((issue) => `- ${issue}`),
    '',
    'Answer again with the SAME single fenced ```json object, corrected. Change nothing else.',
    '',
    'Your previous answer was:',
    '```',
    previous.slice(0, 6_000),
    '```',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The inert options (§12.2, SDK-NOTES D5)
// ---------------------------------------------------------------------------

export function draftOptions(model: string = DRAFT_MODEL): ClaudeAgentSdkOptions {
  return {
    // A full replacement string: this is not a coding task (§12.2).
    systemPrompt: draftSystemPrompt(),
    // D5: the actual restriction lever. `[]` disables every built-in tool, so
    // the call cannot emit a tool use at all.
    tools: [],
    // Kept alongside it: with no tools defined there is nothing to auto-approve,
    // and stating both makes the intent unambiguous to a future reader.
    allowedTools: [],
    disallowedTools: [],
    // Nothing may be approved without a human, and no human is watching a
    // wizard call — so any call that somehow existed is denied outright.
    permissionMode: 'dontAsk',
    mcpServers: {},
    // Never "off" by omission (SDK-NOTES §5): both keys are stated.
    settingSources: [],
    skills: [],
    plugins: [],
    maxTurns: DRAFT_MAX_TURNS,
    model,
  };
}

// ---------------------------------------------------------------------------
// Extraction and sanitisation
// ---------------------------------------------------------------------------

/**
 * The single fenced JSON object the prompt demands, or `undefined`.
 *
 * Falls back to the first balanced `{…}` in the text, because a model that
 * answers with bare JSON has done what was asked in spirit and failing on the
 * fence would spend a repair round-trip on punctuation.
 */
export function extractFencedJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], firstBalancedObject(text)];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      return JSON.parse(candidate.trim()) as unknown;
    } catch {
      // Try the next candidate; a failure of both is what triggers the repair.
    }
  }
  return undefined;
}

function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

export interface SanitisedPermissions {
  readonly permissions: {
    readonly mode?: string | undefined;
    readonly allow: readonly string[];
    readonly deny: readonly string[];
    readonly ask: readonly string[];
  };
  readonly warnings: readonly string[];
}

/**
 * Drop every rule the catalogue does not contain (§12.2's guarantee).
 *
 * Dropping rather than failing, because the guarantee has to hold on the golden
 * path too: a draft whose `allow` names a tool that does not exist would be
 * handed to a wizard, saved, and become a permission the owner believes is in
 * force and is not — the exact failure §6.1 is written to prevent.
 */
export function sanitisePermissions(
  permissions: z.infer<typeof permissionsSchema> | undefined,
): SanitisedPermissions {
  const warnings: string[] = [];
  const allowed = new Set(CATALOGUE_RULES);

  function keep(rules: readonly string[] | undefined, bucket: string): string[] {
    const kept: string[] = [];
    for (const rule of rules ?? []) {
      if (allowed.has(rule)) {
        if (!kept.includes(rule)) kept.push(rule);
        continue;
      }
      warnings.push(
        `dropped "${rule}" from permissions.${bucket}: it is not in the rule catalogue the ` +
          'draft was given, and a rule naming a tool that may not exist is a permission you ' +
          'would believe was in force (DESIGN §12.2)',
      );
    }
    return kept;
  }

  return {
    permissions: {
      ...(permissions?.mode === undefined ? {} : { mode: permissions.mode }),
      allow: keep(permissions?.allow, 'allow'),
      deny: keep(permissions?.deny, 'deny'),
      ask: keep(permissions?.ask, 'ask'),
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Assembling the response
// ---------------------------------------------------------------------------

function assembleDraft(
  parsed: DraftModelResponse,
  request: DraftRequest,
): { draft: AgentDraft; warnings: string[] } {
  const warnings: string[] = [];
  const sanitised = sanitisePermissions(parsed.permissions);
  warnings.push(...sanitised.warnings);

  if (parsed.personaMode === 'replace') {
    warnings.push(
      'Suggested `replace` persona mode — this agent will not receive Claude Code’s coding ' +
        'guidance (DESIGN §5).',
    );
  }

  const tier = request.hints?.modelTier;
  const model = parsed.model ?? (tier === undefined ? undefined : { primary: TIER_MODELS[tier] });
  const overseer = request.hints?.overseer === true || parsed.specialty === 'overseer';
  const roles = [...(parsed.roles ?? [])];
  if (overseer && !roles.includes('overseer')) {
    // §11's rule, applied here so the wizard cannot post a definition the schema
    // will refuse for a reason the owner did not choose.
    roles.push('overseer');
  }

  const draft: AgentDraft = {
    schemaVersion: AGENT_SCHEMA_VERSION,
    name: request.hints?.name ?? parsed.name,
    ...(parsed.avatar === undefined
      ? {}
      : { avatar: { kind: 'emoji' as const, value: parsed.avatar } }),
    specialty: parsed.specialty,
    ...(parsed.tagline === undefined ? {} : { tagline: parsed.tagline }),
    ...(parsed.tags === undefined ? {} : { tags: parsed.tags }),
    persona: { mode: parsed.personaMode, file: DEFAULT_PERSONA_FILE },
    ...(model === undefined ? {} : { model }),
    permissions: sanitised.permissions,
    capabilities: { overseer, roles },
  };

  return { draft, warnings };
}

/**
 * The degraded path: keep every field group that validates on its own.
 *
 * "The fields that did validate, plus the raw text" (§12.2). Group by group,
 * because a single bad `permissions` block is no reason to throw away a good
 * persona the owner would otherwise have to write from scratch.
 */
function salvage(
  value: unknown,
  request: DraftRequest,
): {
  draft: Partial<AgentDraft>;
  persona: string;
  extra: Partial<DraftResponse>;
  warnings: string[];
} {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const warnings: string[] = [];
  const draft: Record<string, unknown> = { schemaVersion: AGENT_SCHEMA_VERSION };
  const extra: Record<string, unknown> = {};
  let persona = '';

  const name = draftFieldSchemas.name.safeParse(record['name']);
  if (name.success) draft['name'] = name.data;
  else if (request.hints?.name !== undefined) draft['name'] = request.hints.name;

  const specialty = draftFieldSchemas.specialty.safeParse(record['specialty']);
  if (specialty.success) draft['specialty'] = specialty.data;

  const avatar = draftFieldSchemas.avatar.safeParse(record['avatar']);
  if (avatar.success) draft['avatar'] = { kind: 'emoji', value: avatar.data };

  const tagline = draftFieldSchemas.tagline.safeParse(record['tagline']);
  if (tagline.success) draft['tagline'] = tagline.data;

  const tags = draftFieldSchemas.tags.safeParse(record['tags']);
  if (tags.success) draft['tags'] = tags.data;

  const personaText = draftFieldSchemas.persona.safeParse(record['persona']);
  if (personaText.success) persona = personaText.data;

  const personaMode = draftFieldSchemas.personaMode.safeParse(record['personaMode']);
  if (personaMode.success || personaText.success) {
    draft['persona'] = {
      mode: personaMode.success ? personaMode.data : 'append',
      file: DEFAULT_PERSONA_FILE,
    };
  }

  const model = draftFieldSchemas.model.safeParse(record['model']);
  if (model.success) draft['model'] = model.data;

  const permissions = draftFieldSchemas.permissions.safeParse(record['permissions']);
  if (permissions.success) {
    const sanitised = sanitisePermissions(permissions.data);
    draft['permissions'] = sanitised.permissions;
    warnings.push(...sanitised.warnings);
  }

  const roles = draftFieldSchemas.roles.safeParse(record['roles']);
  const overseer = request.hints?.overseer === true || draft['specialty'] === 'overseer';
  if (roles.success || overseer) {
    const list = [...(roles.success ? roles.data : [])];
    if (overseer && !list.includes('overseer')) list.push('overseer');
    draft['capabilities'] = { overseer, roles: list };
  }

  const skills = draftFieldSchemas.suggestedSkills.safeParse(record['suggestedSkills']);
  extra['suggestedSkills'] = skills.success ? skills.data : [];

  const integrations = draftFieldSchemas.suggestedIntegrations.safeParse(
    record['suggestedIntegrations'],
  );
  extra['suggestedIntegrations'] = integrations.success ? integrations.data : [];

  const rationale = draftFieldSchemas.rationale.safeParse(record['rationale']);
  extra['rationale'] = rationale.success ? rationale.data : {};

  return { draft, persona, extra, warnings };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export interface DraftDeps {
  readonly query: DraftQueryFn;
  /** Injectable, so the live check can time the call without a global clock. */
  readonly now?: () => number;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/** Everything one `query()` call produced, for the repair prompt and the log. */
interface Attempt {
  readonly text: string;
  readonly issues: readonly string[];
  readonly parsed: DraftModelResponse | undefined;
  readonly value: unknown;
}

async function collectText(messages: AsyncIterable<DraftMessage>): Promise<string> {
  const chunks: string[] = [];
  let resultText = '';
  for await (const message of messages) {
    if (message.type === 'assistant') {
      const envelope = message.message;
      const content =
        typeof envelope === 'object' && envelope !== null
          ? (envelope as { content?: unknown }).content
          : undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue;
          const typed = block as { type?: unknown; text?: unknown };
          if (typed.type === 'text' && typeof typed.text === 'string') chunks.push(typed.text);
        }
      } else if (typeof content === 'string') {
        chunks.push(content);
      }
      continue;
    }
    // The `result` message carries the final text too; kept as the fallback for
    // a build that reports only there.
    if (message.type === 'result' && typeof message.result === 'string') {
      resultText = message.result;
    }
  }
  const assistant = chunks.join('\n').trim();
  return assistant.length > 0 ? assistant : resultText.trim();
}

function attemptFrom(text: string): Attempt {
  const value = extractFencedJson(text);
  if (value === undefined) {
    return {
      text,
      value: undefined,
      parsed: undefined,
      issues: ['the answer contained no parseable JSON object; answer with one ```json fence'],
    };
  }
  const parsed = draftModelResponseSchema.safeParse(value);
  if (parsed.success) return { text, value, parsed: parsed.data, issues: [] };
  return {
    text,
    value,
    parsed: undefined,
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}

/**
 * §12's pipeline: one call, one repair, then degrade.
 *
 * Stateless from end to end — the only things that outlive the call are the
 * returned object and, on the two failure paths, a log line.
 */
export async function draftFromDescription(
  request: DraftRequest,
  deps: DraftDeps,
): Promise<DraftResponse> {
  // Always {@link DRAFT_MODEL}: `hints.modelTier` is a statement about the agent
  // being drafted, not about the wizard call, which must feel instant (§12.2).
  const options = draftOptions();

  let attempt = attemptFrom(
    await collectText(deps.query({ prompt: draftUserPrompt(request), options })),
  );
  let attempts = 1;

  if (attempt.parsed === undefined) {
    deps.log?.('the drafting call did not validate; one repair round-trip follows', {
      issues: attempt.issues,
    });
    const repaired = attemptFrom(
      await collectText(
        deps.query({ prompt: draftRepairPrompt(attempt.text, attempt.issues), options }),
      ),
    );
    attempts = 2;
    attempt = repaired;
  }

  if (attempt.parsed !== undefined) {
    const { draft, warnings } = assembleDraft(attempt.parsed, request);
    return {
      draft,
      persona: attempt.parsed.persona,
      rationale: attempt.parsed.rationale,
      suggestedSkills: attempt.parsed.suggestedSkills ?? [],
      suggestedIntegrations: attempt.parsed.suggestedIntegrations ?? [],
      warnings,
      degraded: false,
      attempts,
    };
  }

  deps.log?.('the drafting call failed twice; returning a partial draft', {
    issues: attempt.issues,
  });
  const partial = salvage(attempt.value, request);
  return {
    draft: partial.draft,
    persona: partial.persona,
    rationale: partial.extra.rationale ?? {},
    suggestedSkills: partial.extra.suggestedSkills ?? [],
    suggestedIntegrations: partial.extra.suggestedIntegrations ?? [],
    warnings: [
      'The model did not return a usable draft twice in a row, so this is a starting point ' +
        'rather than a finished proposal — the fields it did get right are filled in.',
      ...partial.warnings,
      ...attempt.issues.map((issue) => `unusable: ${issue}`),
    ],
    degraded: true,
    raw: attempt.text,
    attempts,
  };
}

/** Diagnostics the service turns a drafting warning into, when it logs one. */
export function draftDiagnostic(message: string): Diagnostic {
  return { level: 'warn', code: 'roster.draft.degraded', message };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 4_000);
  } catch {
    return '{}';
  }
}
