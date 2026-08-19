/**
 * The permissions fieldset's model (ui §7.1, roster §6.1/§6.3) — WO2.
 *
 * `AgentEditor.test.tsx` owns what the *control* does; this owns the two claims
 * underneath it that a click cannot show clearly:
 *
 * - chips are a **view** of the newline-joined bucket, so adding and removing
 *   compose back into exactly what `rulesOf`/`toCreateBody` already read;
 * - {@link ruleWarnings} predicts `sdkRules.ts` rather than paraphrasing it —
 *   same rules rewritten, same rules left alone, and the same order of checks,
 *   because `Write(*)` is treated as a collapse and not as an inert rule.
 */

import { describe, expect, it } from 'vitest';

import type { PermissionCatalogueRule } from '../api/types';

import { EMPTY_INTEGRATION } from './integrationsModel';
import {
  FALLBACK_TOOLS,
  catalogueSections,
  chipsOf,
  composeRule,
  mcpRuleOptions,
  ruleWarnings,
  toolOptions,
  withRule,
  withoutRule,
} from './permissionRules';

describe('chips are a view of the same newline-joined text', () => {
  it('splits, trims and drops blank lines — `rulesOf`’s own rule', () => {
    expect(chipsOf('Read\n\n  Bash(git status)  \n')).toEqual(['Read', 'Bash(git status)']);
  });

  it('appends in the order the user added them', () => {
    expect(withRule('Read', 'Bash(git status)')).toBe('Read\nBash(git status)');
    expect(withRule('', 'Read')).toBe('Read');
  });

  it('adds nothing for an empty rule, so a stray click cannot write a blank line', () => {
    expect(withRule('Read', '   ')).toBe('Read');
  });

  it('removes by position, because a duplicate is legal input', () => {
    expect(withoutRule('Read\nRead\nGrep', 0)).toBe('Read\nGrep');
    expect(withoutRule('Read\nGrep', 1)).toBe('Read');
  });

  it('composes a scoped rule, or a bare tool when there is no pattern', () => {
    expect(composeRule('Bash', 'npm run test:*')).toBe('Bash(npm run test:*)');
    expect(composeRule('Read', '  ')).toBe('Read');
    expect(composeRule('', 'anything')).toBe('');
  });
});

describe('the MCP options come from the form, not from a route', () => {
  it('offers one `mcp__<server>__*` per named server, in form order', () => {
    const options = mcpRuleOptions([
      { ...EMPTY_INTEGRATION, name: 'gmail' },
      { ...EMPTY_INTEGRATION, name: 'todo' },
    ]);
    expect(options).toEqual(['mcp__gmail__*', 'mcp__todo__*']);
  });

  it('skips a half-typed row — an unnamed server is not a server', () => {
    expect(mcpRuleOptions([{ ...EMPTY_INTEGRATION, name: '  ' }])).toEqual([]);
  });

  it('falls back to roster’s tool names when the catalogue never arrived', () => {
    expect(toolOptions(undefined, [])).toEqual(FALLBACK_TOOLS);
    expect(toolOptions([], [{ ...EMPTY_INTEGRATION, name: 'gmail' }])).toEqual([
      ...FALLBACK_TOOLS,
      'mcp__gmail__*',
    ]);
  });

  it('prefers the served list when there is one', () => {
    expect(toolOptions(['Bash', 'Read'], [])).toEqual(['Bash', 'Read']);
  });
});

describe('catalogue sections keep the server’s order', () => {
  const rules: readonly PermissionCatalogueRule[] = [
    { rule: 'Read', description: 'read', group: 'read', suggest: 'allow' },
    { rule: 'Edit', description: 'edit', group: 'edit', suggest: 'allow' },
    { rule: 'Grep', description: 'grep', group: 'read', suggest: 'allow' },
  ];

  it('groups without re-sorting — roster curated the list, not the frontend', () => {
    expect(catalogueSections(rules)).toEqual([
      { group: 'read', entries: [rules[0], rules[2]] },
      { group: 'edit', entries: [rules[1]] },
    ]);
  });
});

describe('warnings mirror sdkRules.ts and never gate (roster §6.1)', () => {
  it('says a Write(path) rule is stored as Edit(path)', () => {
    const [warning] = ruleWarnings('allow', ['Write(./docs/**)']);
    expect(warning?.code).toBe('inert-file-rule');
    expect(warning?.message).toContain('only Edit(path) rules are');
    expect(warning?.message).toContain('Use Edit(./docs/**) instead');
  });

  it('says the same of NotebookEdit, and keeps the original on a restrictive list', () => {
    const [warning] = ruleWarnings('deny', ['NotebookEdit(secret.ipynb)']);
    expect(warning?.code).toBe('inert-file-rule');
    expect(warning?.message).toContain('the original is kept for the record');
  });

  it('says an allow on AskUserQuestion is lifted into ask', () => {
    const [warning] = ruleWarnings('allow', ['AskUserQuestion']);
    expect(warning?.code).toBe('ask-user-question');
    expect(warning?.message).toContain('moved from allow into ask');
    // Denying it stays a legitimate configuration, so it is not warned about.
    expect(ruleWarnings('deny', ['AskUserQuestion'])).toEqual([]);
  });

  it('treats Edit(*) as a collapse, and reads it differently per bucket', () => {
    const allowed = ruleWarnings('allow', ['Edit(*)']);
    expect(allowed[0]?.code).toBe('wildcard-file-scope');
    expect(allowed[0]?.message).toContain('will be dropped');

    const denied = ruleWarnings('deny', ['Edit(*)']);
    expect(denied[0]?.message).toContain('bare tool name “Edit”');
  });

  it('collapses before it rewrites, exactly as the normaliser does', () => {
    // `Write(*)` earns the wildcard warning and *not* the inert-rule one: the
    // normaliser drops it before it ever reaches the rewrite branch.
    const warnings = ruleWarnings('allow', ['Write(*)']);
    expect(warnings.map((warning) => warning.code)).toEqual(['wildcard-file-scope']);
  });

  it('catches an unbalanced parenthesis, which roster’s schema refuses outright', () => {
    const [warning] = ruleWarnings('allow', ['Bash(npm run test']);
    expect(warning?.code).toBe('unbalanced');
    expect(warning?.message).toContain('Tool(pattern)');
  });

  it('names a duplicate once, and warns about nothing else in it', () => {
    const warnings = ruleWarnings('allow', ['Read', 'Read', 'Read']);
    expect(warnings.map((warning) => warning.code)).toEqual(['duplicate', 'duplicate']);
  });

  it('is silent about the ordinary rules the catalogue offers', () => {
    expect(ruleWarnings('allow', ['Read', 'Glob', 'Bash(npm run test:*)', 'Edit(src/**)'])).toEqual(
      [],
    );
  });
});
