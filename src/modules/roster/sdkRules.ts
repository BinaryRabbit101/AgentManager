/**
 * What the SDK's rule engine actually does with a permission rule — and the two
 * places roster's own vocabulary and the engine's disagree.
 *
 * Roster's schema accepts any `Tool` or `Tool(pattern)` string (schema.ts keeps
 * validation shallow on purpose: the rule grammar belongs to the SDK). But two
 * findings from the M0 spikes mean that a rule which *parses* is not necessarily
 * a rule that *does* anything, and one that does something may do more than its
 * author meant. Both are corrected here, once, before composition — so
 * `EffectivePermissions` is a record of what the engine will actually enforce
 * rather than of what someone typed.
 *
 * ## Fix 1 — `AskUserQuestion` must never be auto-approved (runner SDK-NOTES C2)
 *
 * Runner's question bridge is built on `canUseTool`, and the SDK's own wrapper
 * says: "Bare `allowedTools` entries auto-approve the whole tool **before the
 * callback is consulted**." Roster emits the effective allow set as
 * `allowedTools` (§6.1, §13), so an agent whose baseline "generously" allows
 * `AskUserQuestion` would have its own questions auto-approved and the bridge
 * silently disabled — the failure arriving through a permission grant that looks
 * like kindness. Runner C2's third required change is addressed to roster:
 * `AskUserQuestion` "should **never** be emitted as a bare `allowedTools` entry
 * — it belongs in the `ask` bucket (which does reach the callback) or nowhere".
 *
 * So an allow rule on that tool, from any layer, is moved into `ask` with a
 * diagnostic. Denying it stays possible and untouched: an agent that must not
 * ask questions is a legitimate thing to configure.
 *
 * ## Fix 2 — only `Edit(path)` scopes file edits (orchestrator SDK-NOTES C1)
 *
 * The SDK's rule validator canonicalises file-permission checks onto one tool:
 *
 * ```js
 * const canonical = toolName === 'Write' || toolName === 'NotebookEdit' || toolName === 'MultiEdit'
 *   ? 'Edit' : toolName === 'Glob' ? 'Read' : undefined;
 * ```
 *
 * `Write(./docs/**)`, `NotebookEdit(...)` and `MultiEdit(...)` all *parse* and
 * are all accepted — they are simply never consulted. "One `Edit(path)` rule
 * covers every file-editing tool." The half that matters is the complement deny:
 * a `Write(<everything else>)` deny is inert, so a scope that reads like a
 * boundary is not one. And a rule whose content is exactly `*` collapses to the
 * bare tool name, which in `allowedTools` auto-approves every file edit ahead of
 * `canUseTool` — so `Edit(*)` is never emitted; a whole-project scope emits no
 * scope rule at all (C1, point 3).
 *
 * Roster is the only place that sees every layer's rules, which is why C1 point
 * 4 puts the detector here.
 *
 * **Scope of the rewrite.** Only the three file-edit aliases are rewritten. The
 * validator's other alias — `Glob(path)` → `Read(path)` — is left alone
 * deliberately: nothing in roster or orchestrator emits read scopes today, and a
 * rewrite with no caller is a behaviour nobody has reviewed. If read scoping
 * arrives, it belongs in {@link FILE_EDIT_ALIASES}' read-side twin, added with
 * its own tests.
 */
import type { Diagnostic } from './contracts.js';

/** The tool whose whole point is to reach `canUseTool` (runner C2). */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/** The one tool the engine consults for file-edit path rules (orchestrator C1). */
export const CANONICAL_FILE_EDIT_TOOL = 'Edit';

/** Tools whose scoped rules the engine rewrites onto `Edit` — i.e. whose scoped
 *  rules are inert as written. */
export const FILE_EDIT_ALIASES: readonly string[] = ['Write', 'NotebookEdit', 'MultiEdit'];

/** Every tool a `Tool(path)` rule may name and still be about file edits. */
export const FILE_EDIT_TOOLS: readonly string[] = [CANONICAL_FILE_EDIT_TOOL, ...FILE_EDIT_ALIASES];

// ---------------------------------------------------------------------------
// Reading a rule
// ---------------------------------------------------------------------------

/** The tool a rule is about: `Bash(rm *)` → `Bash`, `WebFetch` → `WebFetch`. */
export function ruleTool(rule: string): string {
  const open = rule.indexOf('(');
  return open === -1 ? rule : rule.slice(0, open);
}

/** True for `Tool(pattern)`; false for a bare tool name. */
export function isScopedRule(rule: string): boolean {
  return rule.includes('(');
}

/** The pattern inside a scoped rule, or `undefined` for a bare tool name. */
export function ruleContent(rule: string): string | undefined {
  const open = rule.indexOf('(');
  if (open === -1 || !rule.endsWith(')')) return undefined;
  return rule.slice(open + 1, -1);
}

/**
 * True when the engine's rule parser collapses this scope to the bare tool name.
 *
 * "A rule whose content is exactly `*` (or empty) collapses to the bare tool
 * name — `Edit(*)` parses to `Edit`" (orchestrator SDK-NOTES §5).
 */
export function collapsesToBareTool(rule: string): boolean {
  const content = ruleContent(rule);
  if (content === undefined) return false;
  const trimmed = content.trim();
  return trimmed === '' || trimmed === '*';
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** One layer's rules, rewritten into what the engine will actually enforce. */
export interface NormalisedRules {
  /** The rules to compose with. Deduplicated, order preserved. */
  readonly rules: readonly string[];
  /**
   * Rules lifted out of `allow` and into `ask` (fix 1). Empty for deny and ask
   * lists, which never need the lift.
   */
  readonly forcedAsk: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

/** The SDK's own warning text, so the diagnostic reads the way the engine's
 *  validator would have. */
function inertRuleMessage(rule: string, content: string): string {
  return (
    `${rule} is not matched by file permission checks — only ${CANONICAL_FILE_EDIT_TOOL}(path) ` +
    `rules are. Use ${CANONICAL_FILE_EDIT_TOOL}(${content}) instead ` +
    `(${CANONICAL_FILE_EDIT_TOOL} rules cover all file-editing tools).`
  );
}

function dedupe(rules: readonly string[]): string[] {
  return [...new Set(rules)];
}

/**
 * Normalise an **allow** list.
 *
 * Three rewrites, all narrowing or neutral, never widening:
 *
 * 1. any rule on `AskUserQuestion` leaves `allow` and is reported through
 *    {@link NormalisedRules.forcedAsk} (fix 1);
 * 2. a scoped rule on `Write` / `NotebookEdit` / `MultiEdit` becomes the
 *    equivalent `Edit(path)` — the form the engine consults — with a warning
 *    carrying the SDK's own text (fix 2a, 2b);
 * 3. a file-edit scope whose content is `*` is **dropped**, because it would
 *    collapse to a bare auto-approve of every file edit; a whole-project scope
 *    emits no scope rule at all (fix 2c).
 */
export function normaliseAllowRules(rules: readonly string[], path: string): NormalisedRules {
  const out: string[] = [];
  const forcedAsk: string[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const rule of rules) {
    const tool = ruleTool(rule);

    if (tool === ASK_USER_QUESTION_TOOL) {
      forcedAsk.push(ASK_USER_QUESTION_TOOL);
      diagnostics.push({
        level: 'warn',
        code: 'roster.permissions.ask-user-question-not-auto-approved',
        message:
          `"${rule}" was moved from allow into ask: a bare allowedTools entry auto-approves the ` +
          'whole tool before canUseTool is consulted, which would silently disable the question ' +
          'bridge for this agent’s own questions (runner SDK-NOTES C2)',
        path,
      });
      continue;
    }

    const content = ruleContent(rule);
    if (content === undefined || !FILE_EDIT_TOOLS.includes(tool)) {
      out.push(rule);
      continue;
    }

    if (collapsesToBareTool(rule)) {
      diagnostics.push({
        level: 'warn',
        code: 'roster.permissions.wildcard-file-scope-dropped',
        message:
          `"${rule}" was dropped from allow: rule content of "*" collapses to the bare tool name, ` +
          `so it would auto-approve every file edit ahead of canUseTool. A whole-project scope ` +
          'emits no scope rule at all (orchestrator SDK-NOTES C1)',
        path,
      });
      continue;
    }

    if (tool === CANONICAL_FILE_EDIT_TOOL) {
      out.push(rule);
      continue;
    }

    out.push(`${CANONICAL_FILE_EDIT_TOOL}(${content})`);
    diagnostics.push({
      level: 'warn',
      code: 'roster.permissions.inert-file-rule',
      message: `${inertRuleMessage(rule, content)} It was rewritten to that form.`,
      path,
    });
  }

  return { rules: dedupe(out), forcedAsk: dedupe(forcedAsk), diagnostics };
}

/**
 * Normalise a **deny** or **ask** list.
 *
 * Restrictive lists are treated differently from `allow` in two ways, both
 * because a restriction that is inert is worse than one that is redundant:
 *
 * - the original rule is **kept** as well as the `Edit(path)` form. It costs
 *   nothing (the engine ignores it) and it keeps the author's stated intent in
 *   the audit record, while the `Edit` form is what actually holds the boundary.
 *   Orchestrator C1: "deny forms may stay but must not be relied on";
 * - a `*` scope becomes the **bare tool name** rather than being dropped: on a
 *   restrictive list, collapsing to the bare name is the stronger reading (a
 *   bare deny removes the tool definition outright, §6.1) and is exactly what
 *   the engine does anyway.
 */
export function normaliseGuardRules(rules: readonly string[], path: string): NormalisedRules {
  const out: string[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const rule of rules) {
    const tool = ruleTool(rule);
    const content = ruleContent(rule);

    if (content === undefined || !FILE_EDIT_TOOLS.includes(tool)) {
      out.push(rule);
      continue;
    }

    if (collapsesToBareTool(rule)) {
      out.push(tool);
      diagnostics.push({
        level: 'info',
        code: 'roster.permissions.wildcard-file-scope-collapsed',
        message:
          `"${rule}" was recorded as the bare tool name "${tool}": rule content of "*" collapses ` +
          'to the bare name in the engine, which on a restrictive list removes the tool ' +
          'definition outright (orchestrator SDK-NOTES C1, roster DESIGN §6.1)',
        path,
      });
      continue;
    }

    out.push(rule);
    if (tool !== CANONICAL_FILE_EDIT_TOOL) {
      out.push(`${CANONICAL_FILE_EDIT_TOOL}(${content})`);
      diagnostics.push({
        level: 'info',
        code: 'roster.permissions.inert-file-rule',
        message:
          `${inertRuleMessage(rule, content)} The ${CANONICAL_FILE_EDIT_TOOL} form was added ` +
          'alongside it; the original is kept for the record but carries no boundary.',
        path,
      });
    }
  }

  return { rules: dedupe(out), forcedAsk: [], diagnostics };
}

/** True when `rules` would put `AskUserQuestion` into `allowedTools` — the state
 *  {@link normaliseAllowRules} exists to make unreachable. Exported so a guard
 *  test can assert on the compiled options directly. */
export function allowsAskUserQuestion(rules: readonly string[]): boolean {
  return rules.some((rule) => ruleTool(rule) === ASK_USER_QUESTION_TOOL);
}
