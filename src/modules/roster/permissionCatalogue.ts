/**
 * The curated permission rules, and the one place they live (§6.3, §12.2).
 *
 * This list started life inside `draft.ts` as prompt material: twenty
 * `{ rule, description }` pairs handed to Claude so a drafted definition "cannot
 * invent tool names that do not exist" (§12.2). The owner's complaint on
 * 2026-08-19 was that the same twenty sentences — the only plain-language
 * explanation of permission rules anywhere in the system — were shown to a model
 * and never to a human, who was left typing rules into three empty textareas.
 *
 * So the catalogue moved here and gained two fields the *editor* needs and the
 * prompt ignores, and `draft.ts` re-exports it: one list, one set of words, and
 * no way for the picker and the prompt to describe the same rule differently.
 * **No `rule` string changed in the move** — `draft.ts`'s sanitiser judges a
 * drafted rule against exactly these strings, so an edit here is an edit to what
 * drafting will accept.
 *
 * Three deliberate absences. `AskUserQuestion` is not here because a bare allow
 * on it auto-approves the question before `canUseTool` sees it and silently
 * disables the question bridge (runner SDK-NOTES C2, applied in `sdkRules.ts`).
 * The subagent tool is not here because D4 forbids it outright (§11). And
 * `mcp__agentmanager__*` is not here because that namespace is compiled from
 * `capabilities`, never declared (§11, `overseer.ts`). MCP tools in general are
 * absent for `preflight.ts`'s reason: their names differ per agent and per
 * integration, so the editor derives `mcp__<server>__*` from the form in front of
 * it rather than from a list the server could not have.
 */

/** The buckets the picker groups by. Presentation only — never on the wire of a
 *  definition, which knows nothing but the rule string. */
export const CATALOGUE_GROUPS = ['read', 'edit', 'shell', 'git', 'web', 'other'] as const;
export type CatalogueGroup = (typeof CATALOGUE_GROUPS)[number];

/** Which list an entry belongs in when nobody has said otherwise. */
export const CATALOGUE_SUGGESTIONS = ['allow', 'deny', 'ask'] as const;
export type CatalogueSuggestion = (typeof CATALOGUE_SUGGESTIONS)[number];

export interface CatalogueRule {
  readonly rule: string;
  readonly description: string;
  /** Which section of the picker this appears under. */
  readonly group: CatalogueGroup;
  /**
   * The bucket this entry's own description argues for.
   *
   * Read straight off the prose rather than invented: "usually deny" and "deny
   * unless there is a reason" are `deny`; a description that states no posture is
   * `allow`, which is what the catalogue is *for* (auto-approving the ordinary);
   * and the two whose prose makes the answer depend on **which agent this is** —
   * "deny for a reviewer or a researcher", "deny unless the agent genuinely
   * ships" — are `ask`, the bucket that means a human decides per call. That is
   * the only reading under which the hint contradicts neither half of its own
   * sentence.
   *
   * It is a hint and nothing more: the editor renders a soft note when a chosen
   * bucket differs from it and never refuses the choice (WO2 §2).
   */
  readonly suggest: CatalogueSuggestion;
}

export const PERMISSION_RULE_CATALOGUE: readonly CatalogueRule[] = [
  { rule: 'Read', description: 'read any file in the workspace', group: 'read', suggest: 'allow' },
  { rule: 'Glob', description: 'find files by name pattern', group: 'read', suggest: 'allow' },
  { rule: 'Grep', description: 'search file contents', group: 'read', suggest: 'allow' },
  {
    rule: 'Edit',
    description: 'edit an existing file (the only rule that scopes file writes)',
    group: 'edit',
    suggest: 'allow',
  },
  { rule: 'Write', description: 'create a file', group: 'edit', suggest: 'allow' },
  { rule: 'NotebookEdit', description: 'edit a Jupyter notebook', group: 'edit', suggest: 'allow' },
  { rule: 'TodoWrite', description: 'keep its own task list', group: 'other', suggest: 'allow' },
  { rule: 'WebSearch', description: 'search the web', group: 'web', suggest: 'allow' },
  { rule: 'WebFetch', description: 'fetch a named URL', group: 'web', suggest: 'allow' },
  { rule: 'Bash(git status)', description: 'see what changed', group: 'git', suggest: 'allow' },
  { rule: 'Bash(git diff*)', description: 'read the diff', group: 'git', suggest: 'allow' },
  { rule: 'Bash(git add*)', description: 'stage changes', group: 'git', suggest: 'allow' },
  {
    rule: 'Bash(git commit*)',
    description: 'commit — deny for a reviewer or a researcher',
    group: 'git',
    suggest: 'ask',
  },
  {
    rule: 'Bash(git push*)',
    description: 'push — deny unless the agent genuinely ships',
    group: 'git',
    suggest: 'ask',
  },
  {
    rule: 'Bash(npm run test:*)',
    description: 'run the test suite',
    group: 'shell',
    suggest: 'allow',
  },
  { rule: 'Bash(npm run lint)', description: 'run the linter', group: 'shell', suggest: 'allow' },
  {
    rule: 'Bash(npm run build)',
    description: 'build the project',
    group: 'shell',
    suggest: 'allow',
  },
  {
    rule: 'Bash(npm install*)',
    description: 'install dependencies — usually deny',
    group: 'shell',
    suggest: 'deny',
  },
  {
    rule: 'Bash(rm *)',
    description: 'delete files — deny unless there is a reason',
    group: 'shell',
    suggest: 'deny',
  },
  {
    rule: 'Bash(* > *)',
    description: 'shell redirection, which is a write — usually deny',
    group: 'shell',
    suggest: 'deny',
  },
];

/** The rule strings only, for the sanitiser and the prompt. */
export const CATALOGUE_RULES: readonly string[] = PERMISSION_RULE_CATALOGUE.map(
  (entry) => entry.rule,
);
