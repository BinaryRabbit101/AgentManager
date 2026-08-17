/**
 * The two corrections the M0 spikes owed the compiler.
 *
 * Runner SDK-NOTES C2 — `AskUserQuestion` must never reach `allowedTools` —
 * and orchestrator SDK-NOTES C1 — only `Edit(path)` scopes file edits, and
 * `Edit(*)` collapses to a bare auto-approve. Both are tested here at the rule
 * level and again through `compilePermissions` / `compileSession` in their own
 * suites, because the failure they prevent is only visible in the compiled
 * options.
 */
import { describe, expect, it } from 'vitest';

import {
  ASK_USER_QUESTION_TOOL,
  allowsAskUserQuestion,
  collapsesToBareTool,
  normaliseAllowRules,
  normaliseGuardRules,
  ruleContent,
  ruleTool,
} from './sdkRules.js';

describe('reading a rule', () => {
  it('splits a scoped rule into its tool and its content', () => {
    expect(ruleTool('Bash(rm *)')).toBe('Bash');
    expect(ruleContent('Bash(rm *)')).toBe('rm *');
    expect(ruleTool('WebFetch')).toBe('WebFetch');
    expect(ruleContent('WebFetch')).toBeUndefined();
  });

  it('knows which scopes the engine collapses to the bare tool name', () => {
    expect(collapsesToBareTool('Edit(*)')).toBe(true);
    expect(collapsesToBareTool('Edit()')).toBe(true);
    expect(collapsesToBareTool('Edit( )')).toBe(true);
    expect(collapsesToBareTool('Edit(./src/**)')).toBe(false);
    expect(collapsesToBareTool('Edit')).toBe(false);
  });
});

describe('fix 1 — AskUserQuestion is never auto-approved (runner SDK-NOTES C2)', () => {
  it('moves a bare AskUserQuestion allow into the ask bucket, with a diagnostic', () => {
    const result = normaliseAllowRules(['Read', ASK_USER_QUESTION_TOOL], 'permissions.allow');

    expect(result.rules).toEqual(['Read']);
    expect(result.forcedAsk).toEqual([ASK_USER_QUESTION_TOOL]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe(
      'roster.permissions.ask-user-question-not-auto-approved',
    );
    expect(result.diagnostics[0]?.level).toBe('warn');
    expect(result.diagnostics[0]?.message).toContain('question bridge');
    expect(result.diagnostics[0]?.path).toBe('permissions.allow');
  });

  it('moves a scoped AskUserQuestion allow too — a "*" scope is the same auto-approve', () => {
    const result = normaliseAllowRules(['AskUserQuestion(*)'], 'assignment.scopeRules.allow');
    expect(result.rules).toEqual([]);
    expect(result.forcedAsk).toEqual([ASK_USER_QUESTION_TOOL]);
  });

  it('leaves a deny of AskUserQuestion alone — refusing to ask is a real configuration', () => {
    const result = normaliseGuardRules([ASK_USER_QUESTION_TOOL], 'permissions.deny');
    expect(result.rules).toEqual([ASK_USER_QUESTION_TOOL]);
    expect(result.diagnostics).toEqual([]);
  });

  it('gives a guard test the predicate it needs', () => {
    expect(allowsAskUserQuestion(['Read', 'AskUserQuestion'])).toBe(true);
    expect(allowsAskUserQuestion(['Read', 'AskUserQuestion(x)'])).toBe(true);
    expect(allowsAskUserQuestion(['Read', 'Edit'])).toBe(false);
  });
});

describe('fix 2 — only Edit(path) scopes file edits (orchestrator SDK-NOTES C1)', () => {
  it('rewrites a scoped Write/NotebookEdit/MultiEdit allow onto Edit(path)', () => {
    const result = normaliseAllowRules(
      ['Write(./docs/**)', 'NotebookEdit(./nb/**)', 'MultiEdit(./docs/**)'],
      'assignment.scopeRules.allow',
    );

    expect(result.rules).toEqual(['Edit(./docs/**)', 'Edit(./nb/**)']);
    expect(result.diagnostics).toHaveLength(3);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.code).toBe('roster.permissions.inert-file-rule');
      expect(diagnostic.level).toBe('warn');
      expect(diagnostic.message).toContain('not matched by file permission checks');
    }
  });

  it('leaves an Edit(path) allow exactly as written', () => {
    const result = normaliseAllowRules(['Edit(./services/billing/**)'], 'permissions.allow');
    expect(result.rules).toEqual(['Edit(./services/billing/**)']);
    expect(result.diagnostics).toEqual([]);
  });

  it('never emits Edit(*): a whole-project scope emits no scope rule at all', () => {
    const result = normaliseAllowRules(
      ['Edit(*)', 'Write(*)', 'Read(./src/**)'],
      'permissions.allow',
    );

    expect(result.rules).toEqual(['Read(./src/**)']);
    expect(result.rules).not.toContain('Edit(*)');
    expect(result.rules).not.toContain('Edit');
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      'roster.permissions.wildcard-file-scope-dropped',
      'roster.permissions.wildcard-file-scope-dropped',
    ]);
    expect(result.diagnostics[0]?.message).toContain('collapses to the bare tool name');
  });

  it('adds the Edit form beside an inert deny rather than replacing it', () => {
    const result = normaliseGuardRules(['Write(./secrets/**)'], 'permissions.deny');

    // Deny is a union and the original costs nothing, so the author's stated
    // intent stays in the record while the Edit form carries the boundary.
    expect(result.rules).toEqual(['Write(./secrets/**)', 'Edit(./secrets/**)']);
    expect(result.diagnostics[0]?.code).toBe('roster.permissions.inert-file-rule');
    expect(result.diagnostics[0]?.level).toBe('info');
  });

  it('collapses a "*" deny scope to the bare name, which is the stronger reading', () => {
    const result = normaliseGuardRules(['Edit(*)'], 'permissions.deny');
    expect(result.rules).toEqual(['Edit']);
    expect(result.diagnostics[0]?.code).toBe('roster.permissions.wildcard-file-scope-collapsed');
  });

  it('touches no rule on a tool that is not a file-edit tool', () => {
    const rules = ['Bash(rm *)', 'Read(./src/**)', 'Glob(./src/**)', 'mcp__gmail__read_*'];
    expect(normaliseAllowRules(rules, 'p').rules).toEqual(rules);
    expect(normaliseGuardRules(rules, 'p').rules).toEqual(rules);
  });

  it('deduplicates, so a layer that states both spellings composes as one rule', () => {
    const result = normaliseAllowRules(['Edit(./docs/**)', 'Write(./docs/**)'], 'p');
    expect(result.rules).toEqual(['Edit(./docs/**)']);
  });
});
