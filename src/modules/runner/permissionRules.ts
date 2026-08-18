/**
 * `toolName + toolInput → the one permission rule that would durably allow this
 * call` — the derivation behind §5.1's **Always allow** option.
 *
 * ## Why this is a pure function in runner, and what it is *not*
 *
 * §5.1's boundary is unchanged and load-bearing: **runner matches no rule
 * patterns and consults no rule set.** This file does not evaluate rules, does
 * not read the effective allow set, and does not decide anything — it *writes a
 * sentence in the SDK's rule grammar* describing the call that is on the table,
 * so the card can show the user the exact string that clicking "Always allow"
 * would append to the agent's `permissions.allow`. Composition stays roster's:
 * the string travels to `POST /api/roster/agents/:id/permissions/allow`, which
 * validates it against roster's own grammar and refuses anything it dislikes
 * (roster DESIGN §6). Nothing here is ever applied to the live session, and
 * `updatedPermissions` is still never set anywhere in this element.
 *
 * The grammar itself is roster's (`src/modules/roster/sdkRules.ts`), and feature
 * modules never import each other (foundation §6.1) — so the three facts this
 * derivation depends on are **restated** here with their citations rather than
 * shared, exactly as `questionBridge.ts` restates the card envelope. A change to
 * either side has to change both, and the roster route is the backstop that
 * catches a drift rather than persisting it.
 *
 * ## The three facts, restated from SDK-NOTES and roster's sdkRules
 *
 * 1. **A bare tool name in `allowedTools` auto-approves the whole tool _before_
 *    `canUseTool` is consulted** (SDK-NOTES §5.3: "Bare `allowedTools` entries
 *    auto-approve the whole tool before the callback is consulted"). That is
 *    what makes a durable allow actually durable — the next session's call never
 *    reaches the callback at all — and it is also why a bare name is only ever
 *    derived for tools where "all of them" is what the user is being shown.
 * 2. **Only `Edit(path)` scopes a file edit.** The engine canonicalises
 *    `Write` / `NotebookEdit` / `MultiEdit` path checks onto `Edit`, so
 *    `Write(./docs/**)` parses, is accepted, and is *never consulted*
 *    (orchestrator SDK-NOTES C1, restated in roster's `sdkRules.ts` fix 2). A
 *    rule that merely *looks* scoped is worse than no rule, so this derivation
 *    never produces one: a file-editing call yields `Edit(<path>)` — the one
 *    form the engine honours, and the one that covers every file-editing tool —
 *    or it yields nothing at all.
 * 3. **A scope of `*` collapses to the bare tool name** (roster
 *    `collapsesToBareTool`), which for a file edit would silently auto-approve
 *    every edit anywhere. So a file-editing call with no usable path derives
 *    **no rule**, and the card then simply does not offer the third option. A
 *    missing option is an honest outcome; `Edit` bare is not.
 *
 * ## What a caller gets
 *
 * `undefined` — meaning "there is no rule that honestly describes this call, so
 * do not offer to remember it" — is a first-class answer and is returned for
 * every input this function is not sure about. The card degrades to §5.1's
 * original two options, which is exactly the behaviour that shipped before.
 */

/**
 * Roster's `permissionRule` schema caps a rule at 200 characters (roster
 * `schema.ts`). A derivation that exceeded it would produce a card offering a
 * rule the roster route is bound to refuse, so the cap is applied here too — the
 * user is never shown a button that cannot work.
 */
export const MAX_RULE_LENGTH = 200;

/** The one tool the engine consults for file-edit path rules (SDK-NOTES C1). */
const CANONICAL_FILE_EDIT_TOOL = 'Edit';

/**
 * The tools whose calls are about editing a file on disk.
 *
 * All four derive an `Edit(path)` rule, because that is the only form the engine
 * consults and "one `Edit(path)` rule covers every file-editing tool" (roster
 * `sdkRules.ts`). The path field differs per tool, which is the only reason this
 * is a map rather than a set.
 */
const FILE_EDIT_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Edit: ['file_path', 'path'],
  Write: ['file_path', 'path'],
  MultiEdit: ['file_path', 'path'],
  NotebookEdit: ['notebook_path', 'file_path', 'path'],
});

/**
 * The tool whose whole point is to reach `canUseTool` (SDK-NOTES C2, roster
 * `sdkRules.ts` fix 1).
 *
 * Roster would lift an allow rule on it straight back into `ask` with a
 * diagnostic, so offering to add one would be offering a no-op. It is also not a
 * tool gate in the first place — an `AskUserQuestion` card carries the *agent's*
 * own options (§5.3) and never reaches this derivation — so this guard is belt
 * and braces for a caller that forgets.
 */
const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/**
 * Programs whose *second* token is the verb, and for which a whole-program rule
 * would grant far more than the user was looking at.
 *
 * Someone approving `git status` is not approving `git push --force`, and
 * someone approving `npm run build` is not approving `npm publish`. For these
 * the prefix is two tokens; for everything else it is one, because a single
 * unrecognised program name is the whole of what was asked for.
 *
 * Deliberately a short, literal list rather than a heuristic: "does this program
 * take subcommands?" has no syntactic answer, and a wrong guess in the
 * *narrowing* direction merely produces a rule that matches less than it could,
 * while a wrong guess the other way produces one that matches more than the user
 * agreed to.
 */
const SUBCOMMAND_PROGRAMS: ReadonlySet<string> = new Set([
  'apt',
  'apt-get',
  'aws',
  'az',
  'brew',
  'bun',
  'cargo',
  'deno',
  'docker',
  'dotnet',
  'gcloud',
  'gh',
  'git',
  'go',
  'kubectl',
  'npm',
  'npx',
  'pip',
  'pip3',
  'pnpm',
  'poetry',
  'systemctl',
  'terraform',
  'uv',
  'yarn',
]);

/**
 * Shell syntax that makes "the first token" a lie about what is being approved.
 *
 * `git status; rm -rf .` starts with `git`, and a `Bash(git:*)` rule derived
 * from it would be a rule the user approved while looking at something else
 * entirely. Rather than try to be clever about compound commands, no rule is
 * derived from one at all — the card keeps its two options and the user answers
 * the call in front of them.
 */
const SHELL_OPERATORS = /[;&|<>`$(){}\n\r]/u;

/** A single token safe to paste into a rule: no spaces, no glob, no grammar. */
const SAFE_TOKEN = /^[A-Za-z0-9._@/+:-]+$/u;

/** `VAR=value` prefixes, which precede the program rather than being it. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** A built-in tool name. The engine's own are `PascalCase` identifiers. */
const BUILTIN_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/u;

/** `mcp__<server>__<tool>` — an MCP tool is allowed by its full name (§5.1). */
const MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/u;

/**
 * The rule that would durably allow this call, or `undefined` when none can be
 * written honestly.
 *
 * | Call | Rule |
 * |---|---|
 * | `Bash { command: "npm run build" }` | `Bash(npm run:*)` |
 * | `Bash { command: "ls -la" }` | `Bash(ls:*)` |
 * | `Bash { command: "git status; rm -rf ." }` | *(none — compound command)* |
 * | `Write { file_path: "C:\\ws\\a.ts" }` | `Edit(C:/ws/a.ts)` |
 * | `NotebookEdit { notebook_path: "n.ipynb" }` | `Edit(n.ipynb)` |
 * | `Edit { }` (no path) | *(none — a bare `Edit` allows every edit)* |
 * | `Read { file_path: "…" }` | `Read` |
 * | `mcp__gmail__send` | `mcp__gmail__send` |
 * | `AskUserQuestion` | *(none — roster would lift it back to `ask`)* |
 */
export function durableAllowRule(toolName: string, toolInput: unknown): string | undefined {
  const tool = toolName.trim();
  if (tool === '' || tool === ASK_USER_QUESTION_TOOL) return undefined;

  const input = isRecord(toolInput) ? toolInput : {};

  if (MCP_TOOL_NAME.test(tool)) return capped(tool);
  // A name that opens `mcp__` but is not a whole `mcp__server__tool` is not an
  // MCP tool this can describe, and it would pass the built-in identifier test
  // below — producing a bare rule that matches nothing. Refuse instead.
  if (tool.startsWith('mcp__') || !BUILTIN_TOOL_NAME.test(tool)) return undefined;

  if (tool === 'Bash') return capped(bashRule(input));

  const pathFields = FILE_EDIT_PATH_FIELDS[tool];
  if (pathFields !== undefined) return capped(fileEditRule(input, pathFields));

  // Fact 1: a bare name auto-approves the whole tool ahead of the callback,
  // which is precisely what "always allow Read" means and what the card says.
  return capped(tool);
}

/** `Bash(<prefix>:*)` — never the whole command line (§5.1's owner decision). */
function bashRule(input: Record<string, unknown>): string | undefined {
  const command = input['command'];
  if (typeof command !== 'string') return undefined;
  const trimmed = command.trim();
  if (trimmed === '' || SHELL_OPERATORS.test(trimmed)) return undefined;

  // `FOO=1 npm run build` is an `npm` call wearing a hat.
  const tokens = trimmed.split(/\s+/u).filter((token) => !ENV_ASSIGNMENT.test(token));
  const program = tokens[0];
  if (program === undefined || !SAFE_TOKEN.test(program)) return undefined;

  const verb = tokens[1];
  if (
    verb !== undefined &&
    SUBCOMMAND_PROGRAMS.has(basename(program)) &&
    !verb.startsWith('-') &&
    SAFE_TOKEN.test(verb)
  ) {
    return `Bash(${program} ${verb}:*)`;
  }
  return `Bash(${program}:*)`;
}

/**
 * `Edit(<path>)` for every file-editing tool (fact 2), or nothing (fact 3).
 *
 * The path is slash-normalised because the engine's patterns are gitignore-style
 * globs, in which a backslash is an escape character — `Edit(C:\ws\a.ts)` would
 * be a rule about a path nobody has.
 */
function fileEditRule(
  input: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = input[field];
    if (typeof value !== 'string') continue;
    const path = value.trim().replace(/\\/gu, '/');
    // Fact 3: `*` and `` collapse to a bare `Edit`, which allows every edit
    // anywhere. Parentheses would break the `Tool(pattern)` grammar itself.
    if (path === '' || path === '*' || path.includes('(') || path.includes(')')) continue;
    return `${CANONICAL_FILE_EDIT_TOOL}(${path})`;
  }
  return undefined;
}

/** The last path segment of a program token — `/usr/bin/git` is still `git`. */
function basename(token: string): string {
  const parts = token.split('/');
  return parts[parts.length - 1] ?? token;
}

/** Roster's own 200-character cap, applied before the card offers the rule. */
function capped(rule: string | undefined): string | undefined {
  if (rule === undefined) return undefined;
  return rule.length > MAX_RULE_LENGTH ? undefined : rule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
