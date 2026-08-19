/**
 * The permissions fieldset's model — ui DESIGN §7.1, roster §6.1/§6.3.
 *
 * The owner's report was flat: "knowing what to write for allow, deny, ask is
 * nearly impossible." The three buckets were free-text areas with no examples and
 * no feedback, over a rule grammar with two traps in it that even a correct-looking
 * rule falls into. This file is the half of the fix that has no JSX: turning a
 * newline-joined bucket into chips and back, composing a rule from a tool and a
 * pattern, deriving the `mcp__<server>__*` rules from the servers in the form, and
 * saying — before Save, in the field — what roster's normaliser is going to do.
 *
 * **`EditorModel.allow/deny/ask` stay newline-joined strings.** Nothing here
 * changes the wire format or `toCreateBody`; chips are a *view* of the same text,
 * which is what lets all three editor entrances get the control for free.
 *
 * **The warnings never gate.** roster is the authority — `permissionRuleSchema`
 * still refuses a bad save and `sdkRules.ts` still rewrites what it rewrites. What
 * these buy is the same sentence said earlier, in the field, instead of after a
 * click; the messages are deliberately near-quotations of `sdkRules.ts` so the two
 * cannot drift into contradiction. Note which direction the restatement runs: the
 * server is the one that acts, and this only *predicts*.
 */

import type { PermissionCatalogueRule } from '../api/types';

import { mcpToolPrefix, type IntegrationForm } from './integrationsModel';

/** The three lists, in the order the fieldset renders them. */
export const RULE_BUCKETS = ['allow', 'deny', 'ask'] as const;
export type RuleBucket = (typeof RULE_BUCKETS)[number];

/**
 * One line per bucket, extending §7.1's "deny wins" note into what each list
 * actually *does*. Said per bucket rather than once at the top because the
 * question an owner has is asked while looking at one of them.
 */
export const BUCKET_HELP: Readonly<Record<RuleBucket, string>> = {
  allow:
    'Auto-approved — these run without stopping. Not a restriction: anything missing still runs, it just asks first.',
  deny: 'Always blocked, and deny wins over every allow at every layer.',
  ask: 'Stops and asks — a human answers a card before the call runs.',
};

/**
 * The tools the Compose picker offers when the catalogue did not load.
 *
 * A restatement of `src/modules/roster/preflight.ts`'s `PREFLIGHT_TOOL_CATALOGUE`,
 * for `integrationsModel.ts`'s reason: foundation §6.1 keeps the browser bundle
 * out of `src/`, and the frontend is never the authority anyway. The served list
 * wins whenever it arrives; this exists so that "the catalogue is unreachable"
 * costs the owner suggestions rather than the ability to compose a rule at all.
 */
export const FALLBACK_TOOLS: readonly string[] = [
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
];

// ---------------------------------------------------------------------------
// Text ↔ chips
// ---------------------------------------------------------------------------

/**
 * The bucket's text as chips. Deliberately `rulesOf`'s split, so a chip list and
 * what `toCreateBody` posts are the same array.
 */
export function chipsOf(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Appends one rule, keeping the order the user added them in. */
export function withRule(text: string, rule: string): string {
  const trimmed = rule.trim();
  if (trimmed === '') return text;
  return [...chipsOf(text), trimmed].join('\n');
}

/** Removes the chip at `index`. By position, because a duplicate is legal input
 *  (roster dedupes) and removing "the rule" would remove both. */
export function withoutRule(text: string, index: number): string {
  return chipsOf(text)
    .filter((_, at) => at !== index)
    .join('\n');
}

/** `Bash` + `npm run test:*` → `Bash(npm run test:*)`; no pattern → `Bash`. */
export function composeRule(tool: string, pattern: string): string {
  const name = tool.trim();
  const scope = pattern.trim();
  if (name === '') return '';
  return scope === '' ? name : `${name}(${scope})`;
}

// ---------------------------------------------------------------------------
// MCP options, derived from the form rather than from a route
// ---------------------------------------------------------------------------

/**
 * `mcp__<server>__*` for every server currently in the form.
 *
 * From the form and not from the catalogue, because the catalogue cannot hold
 * them (roster §6.3: MCP tool names "differ per agent and per integration") and
 * because a server the owner is adding *right now* has no route that knows about
 * it yet. Unnamed rows are skipped — a half-typed name is not a server.
 */
export function mcpRuleOptions(integrations: readonly IntegrationForm[]): readonly string[] {
  const out: string[] = [];
  for (const integration of integrations) {
    const name = integration.name.trim();
    if (name === '') continue;
    const rule = `${mcpToolPrefix(name)}*`;
    if (!out.includes(rule)) out.push(rule);
  }
  return out;
}

/**
 * What the Compose tool `<select>` offers: roster's names, then this agent's.
 *
 * The MCP entries carry their `*` because that is the whole rule — `mcp__gmail__*`
 * with no pattern is the one an owner wants, and the wildcard is part of the tool
 * name rather than a scope on it.
 */
export function toolOptions(
  catalogueTools: readonly string[] | undefined,
  integrations: readonly IntegrationForm[],
): readonly string[] {
  const named =
    catalogueTools === undefined || catalogueTools.length === 0 ? FALLBACK_TOOLS : catalogueTools;
  return [...named, ...mcpRuleOptions(integrations)];
}

// ---------------------------------------------------------------------------
// Grouping the catalogue for the picker
// ---------------------------------------------------------------------------

export interface CatalogueSection {
  readonly group: string;
  readonly entries: readonly PermissionCatalogueRule[];
}

/**
 * The catalogue sectioned by `group`, in the server's order and nothing else's.
 *
 * First appearance wins the section's position, so the order of the twenty
 * entries is the order of the picker — roster curated the list, and re-sorting it
 * here would be the frontend quietly disagreeing about which rules matter.
 */
export function catalogueSections(
  rules: readonly PermissionCatalogueRule[],
): readonly CatalogueSection[] {
  const byGroup = new Map<string, PermissionCatalogueRule[]>();
  for (const entry of rules) {
    const existing = byGroup.get(entry.group);
    if (existing === undefined) byGroup.set(entry.group, [entry]);
    else existing.push(entry);
  }
  return [...byGroup].map(([group, entries]) => ({ group, entries }));
}

// ---------------------------------------------------------------------------
// Warnings — `sdkRules.ts`, said in the field
// ---------------------------------------------------------------------------

/** The tool a rule is about: `Bash(rm *)` → `Bash` (`sdkRules.ts ruleTool`). */
export function ruleTool(rule: string): string {
  const open = rule.indexOf('(');
  return open === -1 ? rule : rule.slice(0, open);
}

/** The pattern inside a scoped rule, or `undefined` (`sdkRules.ts ruleContent`). */
export function ruleContent(rule: string): string | undefined {
  const open = rule.indexOf('(');
  if (open === -1 || !rule.endsWith(')')) return undefined;
  return rule.slice(open + 1, -1);
}

/** roster's `CANONICAL_FILE_EDIT_TOOL` and `FILE_EDIT_ALIASES` (`sdkRules.ts`). */
const CANONICAL_FILE_EDIT_TOOL = 'Edit';
const FILE_EDIT_TOOLS: readonly string[] = [
  CANONICAL_FILE_EDIT_TOOL,
  'Write',
  'NotebookEdit',
  'MultiEdit',
];

/** The tool whose whole point is to reach `canUseTool` (runner SDK-NOTES C2). */
const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/** `Edit(*)` and `Edit()` — the scopes the engine collapses to the bare name. */
function collapsesToBareTool(rule: string): boolean {
  const content = ruleContent(rule);
  if (content === undefined) return false;
  const trimmed = content.trim();
  return trimmed === '' || trimmed === '*';
}

export type RuleWarningCode =
  'unbalanced' | 'inert-file-rule' | 'ask-user-question' | 'wildcard-file-scope' | 'duplicate';

export interface RuleWarning {
  readonly code: RuleWarningCode;
  readonly rule: string;
  readonly message: string;
}

/** roster's own sentence about an inert file rule (`sdkRules.ts inertRuleMessage`). */
function inertRuleMessage(rule: string, content: string): string {
  return (
    `${rule} is not matched by file permission checks — only ${CANONICAL_FILE_EDIT_TOOL}(path) ` +
    `rules are. Use ${CANONICAL_FILE_EDIT_TOOL}(${content}) instead ` +
    `(${CANONICAL_FILE_EDIT_TOOL} rules cover all file-editing tools).`
  );
}

/**
 * Everything roster will do to this bucket, said before Save.
 *
 * The order of the checks is `sdkRules.ts`'s own, which matters for one case:
 * `Write(*)` collapses before it is rewritten, so it earns the wildcard warning
 * and *not* the inert-rule one — exactly as the normaliser treats it.
 */
export function ruleWarnings(bucket: RuleBucket, rules: readonly string[]): readonly RuleWarning[] {
  const warnings: RuleWarning[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    if (seen.has(rule)) {
      warnings.push({
        code: 'duplicate',
        rule,
        message: `“${rule}” is in ${bucket} twice. The duplicate is dropped when the rules are composed.`,
      });
      continue;
    }
    seen.add(rule);

    // roster's `permissionRuleSchema`: "a scoped rule must look like
    // Tool(pattern)". The one warning here that is about the rule being
    // *refused* rather than rewritten — and still not a gate, because roster
    // says it better and says it with the field path attached.
    const open = rule.indexOf('(');
    const balanced = open === -1 ? !rule.includes(')') : rule.endsWith(')') && open > 0;
    if (!balanced) {
      warnings.push({
        code: 'unbalanced',
        rule,
        message: `“${rule}” has an unbalanced parenthesis — a scoped rule must look like Tool(pattern). Saving will be refused.`,
      });
      continue;
    }

    const tool = ruleTool(rule);

    if (bucket === 'allow' && tool === ASK_USER_QUESTION_TOOL) {
      warnings.push({
        code: 'ask-user-question',
        rule,
        message:
          `“${rule}” will be moved from allow into ask: a bare allowedTools entry auto-approves ` +
          'the whole tool before canUseTool is consulted, which would silently disable the ' +
          'question bridge for this agent’s own questions.',
      });
      continue;
    }

    const content = ruleContent(rule);
    if (content === undefined || !FILE_EDIT_TOOLS.includes(tool)) continue;

    if (collapsesToBareTool(rule)) {
      warnings.push({
        code: 'wildcard-file-scope',
        rule,
        message:
          bucket === 'allow'
            ? `“${rule}” will be dropped: rule content of “*” collapses to the bare tool name, so ` +
              'it would auto-approve every file edit ahead of canUseTool. A whole-project scope ' +
              'emits no scope rule at all.'
            : `“${rule}” will be recorded as the bare tool name “${tool}”: rule content of “*” ` +
              'collapses to the bare name, which on a restrictive list removes the tool ' +
              'definition outright.',
      });
      continue;
    }

    if (tool === CANONICAL_FILE_EDIT_TOOL) continue;

    warnings.push({
      code: 'inert-file-rule',
      rule,
      message:
        bucket === 'allow'
          ? `${inertRuleMessage(rule, content)} It will be rewritten to that form.`
          : `${inertRuleMessage(rule, content)} The ${CANONICAL_FILE_EDIT_TOOL} form is added ` +
            'alongside it; the original is kept for the record but carries no boundary.',
    });
  }

  return warnings;
}
