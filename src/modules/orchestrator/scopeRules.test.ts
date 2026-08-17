/**
 * §2.5's `scopeRules` emission, pinned against SDK-NOTES **C1**.
 *
 * These assertions are the reason the write scope can be called *enforced*: the
 * SDK consults only `Edit(path)` rules, so a suite that accepted a
 * `Write(path)` rule would be certifying a boundary that is not one.
 */
import { describe, expect, it } from 'vitest';

import { emitScopeRules, normaliseScopePath } from './scopeRules.js';

describe('normaliseScopePath (§9-11)', () => {
  it.each([
    ['docs/', 'docs/'],
    ['./docs/', 'docs/'],
    ['docs', 'docs'],
    ['docs\\orchestrator\\DESIGN.md', 'docs/orchestrator/DESIGN.md'],
    ['  docs/orchestrator/  ', 'docs/orchestrator/'],
    ['docs//orchestrator/', 'docs/orchestrator/'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normaliseScopePath(input).path).toBe(expected);
  });

  it.each([
    ['C:\\Code', 'absolute'],
    ['/etc', 'absolute'],
    ['../up', 'traversal'],
    ['docs/../..', 'traversal'],
    ['docs/**', 'glob'],
    ['docs/*.md', 'glob'],
    ['', 'empty'],
    ['./', 'empty'],
  ])('rejects %s as %s', (input, problem) => {
    const result = normaliseScopePath(input);
    expect(result.path).toBeUndefined();
    expect(result.problem).toBe(problem);
  });
});

describe('emitScopeRules (§2.5, corrected by SDK-NOTES C1)', () => {
  it('emits Edit(path) and nothing else — Write and NotebookEdit rules are inert', () => {
    const rules = emitScopeRules({ paths: ['docs/'] }, true);
    expect(rules.allow).toEqual(['Edit(./docs/**)']);
    // C1: `Edit` rules cover `Write`, `NotebookEdit` and `MultiEdit`, so
    // enumerating them is not defence in depth — it is noise that reads like it.
    expect(JSON.stringify(rules)).not.toContain('Write(');
    expect(JSON.stringify(rules)).not.toContain('NotebookEdit(');
    expect(JSON.stringify(rules)).not.toContain('MultiEdit(');
  });

  it('appends /** to a directory and leaves a file alone', () => {
    expect(emitScopeRules({ paths: ['docs/', 'docs/orchestrator/DESIGN.md'] }, true).allow).toEqual(
      ['Edit(./docs/**)', 'Edit(./docs/orchestrator/DESIGN.md)'],
    );
  });

  it('emits no rule at all for a whole-project scope (C1-3)', () => {
    // `Edit(*)` collapses to the bare `Edit`, which auto-approves ahead of
    // `canUseTool`. A whole-project scope must therefore emit nothing.
    expect(emitScopeRules(undefined, true)).toEqual({});
    expect(emitScopeRules(null, true)).toEqual({});
    expect(emitScopeRules({ paths: [] }, true)).toEqual({});
    expect(JSON.stringify(emitScopeRules({ paths: [] }, true))).not.toContain('*');
  });

  it('emits no rule for a read-only assignment — the flag is the boundary', () => {
    // Roster's compiler unions a mutating-tool deny on `write === false` (R2).
    // An allow-list alongside that floor would suggest the allow-list is what
    // made it read-only.
    expect(emitScopeRules({ paths: ['docs/'] }, false)).toEqual({});
  });

  it('never emits deny or ask — the complement is roster\u2019s to derive', () => {
    const rules = emitScopeRules({ paths: ['docs/', 'src/'] }, true);
    expect(rules.deny).toBeUndefined();
    expect(rules.ask).toBeUndefined();
  });

  it('never emits an absolute path', () => {
    const rules = emitScopeRules({ paths: ['docs/'] }, true);
    for (const rule of rules.allow ?? []) {
      expect(rule).not.toMatch(/[A-Za-z]:/);
      expect(rule).toContain('./');
    }
  });

  it('is deterministic: two equivalent scopes compile byte-identically', () => {
    expect(emitScopeRules({ paths: ['src/', 'docs/', 'docs/'] }, true)).toEqual(
      emitScopeRules({ paths: ['./docs/', 'src/'] }, true),
    );
  });
});
