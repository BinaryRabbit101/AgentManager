/**
 * The composition table (roster IMPLEMENTATION M4).
 *
 * "It is the highest-risk logic in the element, and it is the **only** composer
 * in the system… Two implementations of this table would disagree, and the
 * disagreement would be a permission bug" (DESIGN §6.2). So the table is the
 * test: every case is a (baseline, project, assignment, policy) tuple with the
 * whole expected `EffectivePermissions`, not a spot-check of one field.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic, EffectivePermissions } from './contracts.js';
import {
  DEFAULT_PERMISSION_MODE,
  MUTATING_TOOL_DENY_RULES,
  compilePermissions,
  grantTool,
  outcomeForTool,
  removesToolDefinition,
} from './permissions.js';
import type {
  AssignmentPermissionLayer,
  PermissionPolicy,
  ProjectPermissionLayer,
  RawPermissionSet,
} from './permissions.js';
import { PERMISSION_MODES } from './schema.js';

// ---------------------------------------------------------------------------
// Shared inputs
// ---------------------------------------------------------------------------

/** The canonical fixture's permission block (`__fixtures__/coder.json`). */
const BASE: RawPermissionSet = {
  mode: 'acceptEdits',
  allow: ['Read', 'Glob', 'Grep', 'Edit', 'Bash(npm run test:*)'],
  deny: ['Bash(rm *)', 'Bash(git push*)', 'WebFetch'],
  ask: ['Bash(git commit*)'],
};

const BASE_ALLOW = ['Bash(npm run test:*)', 'Edit', 'Glob', 'Grep', 'Read'];
const BASE_DENY = ['Bash(git push*)', 'Bash(rm *)', 'WebFetch'];
const BASE_ASK = ['Bash(git commit*)'];

/** The `write: false` floor of §6.2, sorted as the compiler emits it. */
const FLOOR_DENY = [
  'Bash(* > *)',
  'Bash(* >> *)',
  'Bash(cp *)',
  'Bash(git commit*)',
  'Bash(git push*)',
  'Bash(mv *)',
  'Bash(rm *)',
  'Edit',
  'NotebookEdit',
  'Write',
];

const OPEN_POLICY: PermissionPolicy = { allowPermissionElevation: true, globalDeny: [] };

/** Every session belongs to an assignment (D4); this is the unrestricted one. */
const FREE_ASSIGNMENT: AssignmentPermissionLayer = { write: true };

const SANDBOX_ELEVATION = {
  allow: ['WebSearch'],
  reason: 'sandbox project: the agent may search the web while prototyping',
};

interface Case {
  readonly name: string;
  readonly baseline?: RawPermissionSet;
  readonly project?: ProjectPermissionLayer;
  readonly assignment?: AssignmentPermissionLayer;
  readonly policy?: PermissionPolicy;
  readonly expected: EffectivePermissions;
  /** Diagnostic codes, in emission order. */
  readonly codes?: readonly string[];
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const CASES: readonly Case[] = [
  {
    name: 'baseline alone passes through unchanged',
    baseline: BASE,
    assignment: FREE_ASSIGNMENT,
    expected: {
      mode: 'acceptEdits',
      allow: BASE_ALLOW,
      deny: BASE_DENY,
      ask: BASE_ASK,
      elevation: null,
    },
  },
  {
    name: 'no layers at all: nothing is auto-approved and the mode is the middle rung',
    expected: { mode: DEFAULT_PERMISSION_MODE, allow: [], deny: [], ask: [], elevation: null },
  },
  {
    name: 'project tries to widen allow: ignored',
    baseline: BASE,
    project: { permissions: { allow: ['Read', 'Bash(rm -rf /)'] } },
    assignment: FREE_ASSIGNMENT,
    expected: {
      mode: 'acceptEdits',
      allow: ['Read'],
      deny: BASE_DENY,
      ask: BASE_ASK,
      elevation: null,
    },
    codes: ['roster.permissions.widening-ignored'],
  },
  {
    name: 'project adds deny: applied',
    baseline: BASE,
    project: { permissions: { deny: ['Bash(curl*)', 'WebSearch'] } },
    assignment: FREE_ASSIGNMENT,
    expected: {
      mode: 'acceptEdits',
      allow: BASE_ALLOW,
      deny: ['Bash(curl*)', 'Bash(git push*)', 'Bash(rm *)', 'WebFetch', 'WebSearch'],
      ask: BASE_ASK,
      elevation: null,
    },
  },
  {
    name: 'project adds ask: applied, and the baseline ask survives',
    baseline: BASE,
    project: { permissions: { ask: ['WebSearch'] } },
    assignment: { write: true, scopeRules: { ask: ['Bash(npm publish*)'] } },
    expected: {
      mode: 'acceptEdits',
      allow: BASE_ALLOW,
      deny: BASE_DENY,
      ask: ['Bash(git commit*)', 'Bash(npm publish*)', 'WebSearch'],
      elevation: null,
    },
  },
  {
    name: 'assignment path scope narrows Edit to the subsystem',
    baseline: BASE,
    assignment: { write: true, scopeRules: { allow: ['Edit(./services/billing/**)'] } },
    expected: {
      mode: 'acceptEdits',
      allow: ['Edit(./services/billing/**)'],
      deny: BASE_DENY,
      ask: BASE_ASK,
      elevation: null,
    },
  },
  {
    name: 'mode ladder minimum: a project narrows acceptEdits to plan',
    baseline: BASE,
    project: { permissions: { mode: 'plan' } },
    assignment: FREE_ASSIGNMENT,
    expected: { mode: 'plan', allow: BASE_ALLOW, deny: BASE_DENY, ask: BASE_ASK, elevation: null },
  },
  {
    name: 'mode ladder minimum: a project cannot widen dontAsk to acceptEdits',
    baseline: { ...BASE, mode: 'dontAsk' },
    project: { permissions: { mode: 'acceptEdits' } },
    assignment: FREE_ASSIGNMENT,
    expected: {
      mode: 'dontAsk',
      allow: BASE_ALLOW,
      deny: BASE_DENY,
      ask: BASE_ASK,
      elevation: null,
    },
  },
  {
    name: 'policy.globalDeny beats a project allow',
    baseline: BASE,
    project: { permissions: { allow: ['Read', 'Edit'] } },
    assignment: FREE_ASSIGNMENT,
    policy: { allowPermissionElevation: true, globalDeny: ['Edit'] },
    expected: {
      mode: 'acceptEdits',
      allow: ['Read'],
      deny: ['Bash(git push*)', 'Bash(rm *)', 'Edit', 'WebFetch'],
      ask: BASE_ASK,
      elevation: null,
    },
    codes: ['roster.permissions.allow-overridden-by-deny'],
  },
  {
    name: 'elevation widens and is flagged in the result',
    baseline: BASE,
    project: { elevation: SANDBOX_ELEVATION },
    assignment: FREE_ASSIGNMENT,
    expected: {
      mode: 'acceptEdits',
      allow: [...BASE_ALLOW, 'WebSearch'],
      deny: BASE_DENY,
      ask: BASE_ASK,
      elevation: { allow: ['WebSearch'], reason: SANDBOX_ELEVATION.reason },
    },
    codes: ['roster.permissions.elevation-applied'],
  },
  {
    name: 'the same elevation is dropped with a diagnostic under allowPermissionElevation: false',
    baseline: BASE,
    project: { elevation: SANDBOX_ELEVATION },
    assignment: FREE_ASSIGNMENT,
    policy: { allowPermissionElevation: false, globalDeny: [] },
    expected: {
      mode: 'acceptEdits',
      allow: BASE_ALLOW,
      deny: BASE_DENY,
      ask: BASE_ASK,
      elevation: null,
    },
    codes: ['roster.permissions.elevation-dropped'],
  },
  {
    name: 'an elevation with an empty allow set is not an elevation',
    baseline: BASE,
    project: { elevation: { allow: [], reason: 'left over from an earlier edit' } },
    assignment: FREE_ASSIGNMENT,
    expected: {
      mode: 'acceptEdits',
      allow: BASE_ALLOW,
      deny: BASE_DENY,
      ask: BASE_ASK,
      elevation: null,
    },
  },
  {
    name: 'write: false with no scopeRules at all still yields the mutating deny',
    baseline: BASE,
    assignment: { write: false },
    expected: {
      mode: 'acceptEdits',
      allow: ['Bash(npm run test:*)', 'Glob', 'Grep', 'Read'],
      deny: [...FLOOR_DENY.slice(0, 7), 'Edit', 'NotebookEdit', 'WebFetch', 'Write'],
      ask: BASE_ASK,
      elevation: null,
    },
    codes: ['roster.permissions.allow-overridden-by-deny'],
  },
  {
    name: 'write: false beats a baseline and a project that both allow every mutating tool',
    baseline: { allow: ['Edit', 'Write', 'NotebookEdit', 'Read'] },
    project: { permissions: { allow: ['Edit', 'Write', 'NotebookEdit', 'Read'] } },
    assignment: { write: false },
    expected: {
      mode: DEFAULT_PERMISSION_MODE,
      allow: ['Read'],
      deny: FLOOR_DENY,
      ask: [],
      elevation: null,
    },
    codes: ['roster.permissions.allow-overridden-by-deny'],
  },
  {
    name: 'write: false beats an applied elevation that tries to re-allow Edit',
    baseline: { allow: ['Read', 'Edit'] },
    project: { elevation: { allow: ['Edit'], reason: 'the user asked for a quick fix' } },
    assignment: { write: false },
    expected: {
      mode: DEFAULT_PERMISSION_MODE,
      allow: ['Read'],
      deny: FLOOR_DENY,
      ask: [],
      elevation: { allow: ['Edit'], reason: 'the user asked for a quick fix' },
    },
    codes: ['roster.permissions.elevation-applied', 'roster.permissions.allow-overridden-by-deny'],
  },
  {
    name: 'a declared scopeRules.deny is additive on top of the write: false floor',
    baseline: { allow: ['Read'] },
    assignment: { write: false, scopeRules: { deny: ['Read(./secrets/**)'] } },
    expected: {
      mode: DEFAULT_PERMISSION_MODE,
      allow: ['Read'],
      deny: [...FLOOR_DENY.slice(0, 9), 'Read(./secrets/**)', 'Write'],
      ask: [],
      elevation: null,
    },
  },
  {
    name: 'a project mode of bypassPermissions is off the ladder and is dropped',
    baseline: { ...BASE, mode: 'default' },
    project: { permissions: { mode: 'bypassPermissions' } },
    assignment: FREE_ASSIGNMENT,
    expected: {
      mode: 'default',
      allow: BASE_ALLOW,
      deny: BASE_DENY,
      ask: BASE_ASK,
      elevation: null,
    },
    codes: ['roster.permissions.unknown-mode'],
  },
  {
    name: 'a project mode of auto is off the ladder and is dropped (SDK-NOTES D1)',
    baseline: { ...BASE, mode: 'plan' },
    project: { permissions: { mode: 'auto' } },
    assignment: FREE_ASSIGNMENT,
    expected: { mode: 'plan', allow: BASE_ALLOW, deny: BASE_DENY, ask: BASE_ASK, elevation: null },
    codes: ['roster.permissions.unknown-mode'],
  },
  {
    name: 'two scoped rules that cannot be compared narrow to nothing rather than guessing',
    baseline: { allow: ['Edit'] },
    project: { permissions: { allow: ['Edit(./src/**)'] } },
    assignment: { write: true, scopeRules: { allow: ['Edit(./src/billing/**)'] } },
    expected: { mode: DEFAULT_PERMISSION_MODE, allow: [], deny: [], ask: [], elevation: null },
    codes: ['roster.permissions.widening-ignored'],
  },
  {
    name: 'globalDeny survives every layer, including one that denies nothing',
    baseline: { mode: 'acceptEdits', allow: ['Read'] },
    project: { permissions: { deny: [] } },
    assignment: { write: true, scopeRules: { deny: [] } },
    policy: { allowPermissionElevation: true, globalDeny: ['Bash(rm *)', 'WebFetch'] },
    expected: {
      mode: 'acceptEdits',
      allow: ['Read'],
      deny: ['Bash(rm *)', 'WebFetch'],
      ask: [],
      elevation: null,
    },
  },
];

function codesOf(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

describe('compilePermissions — the §6.2 composition table', () => {
  it('covers at least the fifteen triples M4 requires', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(15);
  });

  for (const testCase of CASES) {
    it(testCase.name, () => {
      const compiled = compilePermissions(
        testCase.baseline,
        testCase.project,
        testCase.assignment,
        testCase.policy ?? OPEN_POLICY,
      );
      expect(compiled.effective).toEqual(testCase.expected);
      expect(codesOf(compiled.diagnostics)).toEqual(testCase.codes ?? []);
    });
  }
});

// ---------------------------------------------------------------------------
// write: false (§6.2's floor)
// ---------------------------------------------------------------------------

describe('write: false enforces the mutating-tool deny', () => {
  it('denies every rule in the catalogue regardless of what the other layers allowed', () => {
    const compiled = compilePermissions(
      { mode: 'acceptEdits', allow: ['Edit', 'Write', 'NotebookEdit', 'Bash(rm *)'] },
      { permissions: { allow: ['Edit', 'Write', 'NotebookEdit', 'Bash(rm *)'] } },
      { write: false },
      OPEN_POLICY,
    );
    for (const rule of MUTATING_TOOL_DENY_RULES) {
      expect(compiled.effective.deny).toContain(rule);
    }
    expect(compiled.effective.allow).toEqual([]);
  });

  it('removes the tool definitions of Edit, Write and NotebookEdit', () => {
    const compiled = compilePermissions(BASE, undefined, { write: false }, OPEN_POLICY);
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(removesToolDefinition(compiled.effective, tool)).toBe(true);
      expect(outcomeForTool(compiled, tool)).toBe('deny');
    }
  });

  it('leaves a read-only assignment able to read: Bash survives, its mutating forms do not', () => {
    const compiled = compilePermissions(
      { allow: ['Read', 'Bash(npm run test:*)'] },
      undefined,
      { write: false },
      OPEN_POLICY,
    );
    expect(removesToolDefinition(compiled.effective, 'Bash')).toBe(false);
    expect(compiled.effective.allow).toContain('Bash(npm run test:*)');
    expect(compiled.effective.deny).toContain('Bash(rm *)');
  });
});

// ---------------------------------------------------------------------------
// Default-deny (§6.1)
// ---------------------------------------------------------------------------

describe('restriction is expressed as deny, never by omission', () => {
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    'a tool in neither allow nor deny still cannot execute — %s',
    (_name, testCase) => {
      const compiled = compilePermissions(
        testCase.baseline,
        testCase.project,
        testCase.assignment,
        testCase.policy ?? OPEN_POLICY,
      );
      const unmentioned = 'SomeToolNobodyListed';
      expect(compiled.effective.allow).not.toContain(unmentioned);
      expect(compiled.effective.deny).not.toContain(unmentioned);
      expect(compiled.policy.default).toBe('deny');
      expect(outcomeForTool(compiled, unmentioned)).not.toBe('auto-allow');
    },
  );

  it('denies without a prompt under plan and dontAsk, where no callback is reached', () => {
    for (const mode of ['plan', 'dontAsk'] as const) {
      const compiled = compilePermissions({ mode }, undefined, FREE_ASSIGNMENT, OPEN_POLICY);
      expect(compiled.policy.humanMayApprove).toBe(false);
      expect(outcomeForTool(compiled, 'Bash')).toBe('deny');
    }
  });

  it('routes an unlisted tool to the human gate under default and acceptEdits', () => {
    for (const mode of ['default', 'acceptEdits'] as const) {
      const compiled = compilePermissions({ mode }, undefined, FREE_ASSIGNMENT, OPEN_POLICY);
      expect(compiled.policy.humanMayApprove).toBe(true);
      expect(outcomeForTool(compiled, 'Bash')).toBe('ask-human');
    }
  });

  it('a bare-name deny removes the tool definition; a scoped deny does not', () => {
    const compiled = compilePermissions(BASE, undefined, FREE_ASSIGNMENT, OPEN_POLICY);
    expect(removesToolDefinition(compiled.effective, 'WebFetch')).toBe(true);
    expect(outcomeForTool(compiled, 'WebFetch')).toBe('deny');
    // `Bash(rm *)` denies matching calls but keeps the tool.
    expect(removesToolDefinition(compiled.effective, 'Bash')).toBe(false);
  });

  it('a tool whose only grant is scoped is never auto-approved by name', () => {
    const compiled = compilePermissions(
      BASE,
      undefined,
      { write: true, scopeRules: { allow: ['Edit(./services/billing/**)'] } },
      OPEN_POLICY,
    );
    expect(compiled.effective.allow).toEqual(['Edit(./services/billing/**)']);
    expect(outcomeForTool(compiled, 'Edit')).not.toBe('auto-allow');
  });

  it('carries the ask rules onto the policy, so the human gate is reachable', () => {
    const compiled = compilePermissions(BASE, undefined, FREE_ASSIGNMENT, OPEN_POLICY);
    expect(compiled.policy.ask).toEqual(BASE_ASK);
    expect(compiled.policy.denyMessage).toContain('not in the effective allow set');
  });
});

// ---------------------------------------------------------------------------
// bypassPermissions is unreachable (§6.1, SDK-NOTES D1)
// ---------------------------------------------------------------------------

describe('bypassPermissions (and auto) are unreachable', () => {
  it('no case in the table produces a mode off the roster ladder', () => {
    for (const testCase of CASES) {
      const compiled = compilePermissions(
        testCase.baseline,
        testCase.project,
        testCase.assignment,
        testCase.policy ?? OPEN_POLICY,
      );
      expect(PERMISSION_MODES).toContain(compiled.effective.mode);
    }
  });

  const attempts: readonly (readonly [
    string,
    RawPermissionSet | undefined,
    ProjectPermissionLayer | undefined,
    AssignmentPermissionLayer | undefined,
  ])[] = [
    ['baseline', { mode: 'bypassPermissions' }, undefined, undefined],
    ['project override', undefined, { permissions: { mode: 'bypassPermissions' } }, undefined],
    [
      'assignment scope',
      undefined,
      undefined,
      { write: true, scopeRules: { mode: 'bypassPermissions' } },
    ],
    ['baseline (auto)', { mode: 'auto' }, undefined, undefined],
    ['project override (auto)', undefined, { permissions: { mode: 'auto' } }, undefined],
  ];

  it.each(attempts)(
    'a %s asking for it is dropped with a diagnostic',
    (_where, baseline, project, assignment) => {
      const compiled = compilePermissions(baseline, project, assignment, OPEN_POLICY);
      expect(compiled.effective.mode).toBe(DEFAULT_PERMISSION_MODE);
      expect(codesOf(compiled.diagnostics)).toContain('roster.permissions.unknown-mode');
    },
  );

  it('an elevation naming the mode as a rule cannot change the mode', () => {
    const compiled = compilePermissions(
      { mode: 'plan', allow: ['Read'] },
      { elevation: { allow: ['bypassPermissions'], reason: 'nice try' } },
      FREE_ASSIGNMENT,
      OPEN_POLICY,
    );
    expect(compiled.effective.mode).toBe('plan');
  });

  it('the ladder itself contains neither member', () => {
    expect(PERMISSION_MODES).not.toContain('bypassPermissions');
    expect(PERMISSION_MODES).not.toContain('auto');
  });
});

// ---------------------------------------------------------------------------
// The two SDK-spike corrections, at composition level
// ---------------------------------------------------------------------------

/**
 * `sdkRules.test.ts` proves the rewrites rule by rule. What matters here is that
 * they happen **before** the algebra runs, because `allow` is an intersection
 * and an intersection between a rewritten rule and an un-rewritten one would
 * silently drop both.
 */
describe('AskUserQuestion never reaches the allow set (runner SDK-NOTES C2)', () => {
  it('lifts a baseline allow into ask, so the question bridge survives', () => {
    const compiled = compilePermissions(
      { allow: ['Read', 'AskUserQuestion'] },
      undefined,
      FREE_ASSIGNMENT,
      OPEN_POLICY,
    );

    expect(compiled.effective.allow).toEqual(['Read']);
    expect(compiled.effective.ask).toContain('AskUserQuestion');
    expect(codesOf(compiled.diagnostics)).toContain(
      'roster.permissions.ask-user-question-not-auto-approved',
    );
  });

  it('lifts it from any layer — project override, assignment scope, elevation', () => {
    const layers: readonly [ProjectPermissionLayer | undefined, AssignmentPermissionLayer][] = [
      [{ permissions: { allow: ['AskUserQuestion'] } }, FREE_ASSIGNMENT],
      [undefined, { write: true, scopeRules: { allow: ['AskUserQuestion'] } }],
      [{ elevation: { allow: ['AskUserQuestion'], reason: 'let it ask' } }, FREE_ASSIGNMENT],
    ];

    for (const [project, assignment] of layers) {
      const compiled = compilePermissions(
        { allow: ['AskUserQuestion', 'Read'] },
        project,
        assignment,
        OPEN_POLICY,
      );
      expect(compiled.effective.allow).not.toContain('AskUserQuestion');
      expect(compiled.effective.ask).toContain('AskUserQuestion');
    }
  });

  it('still lets a definition deny it outright', () => {
    const compiled = compilePermissions(
      { deny: ['AskUserQuestion'] },
      undefined,
      FREE_ASSIGNMENT,
      OPEN_POLICY,
    );
    expect(compiled.effective.deny).toContain('AskUserQuestion');
    expect(removesToolDefinition(compiled.effective, 'AskUserQuestion')).toBe(true);
  });
});

describe('file scopes are expressed as Edit(path) (orchestrator SDK-NOTES C1)', () => {
  it('intersects a Write(path) assignment scope against an Edit baseline', () => {
    const compiled = compilePermissions(
      { allow: ['Edit'] },
      undefined,
      { write: true, scopeRules: { allow: ['Write(./services/billing/**)'] } },
      OPEN_POLICY,
    );

    // Without the rewrite the two rules would be incomparable and the scope
    // would be discarded as an attempt to widen.
    expect(compiled.effective.allow).toEqual(['Edit(./services/billing/**)']);
    expect(codesOf(compiled.diagnostics)).toContain('roster.permissions.inert-file-rule');
  });

  it('carries the complement deny on the Edit form, which is the half that matters', () => {
    const compiled = compilePermissions(
      { allow: ['Edit(./docs/**)'] },
      undefined,
      { write: true, scopeRules: { deny: ['Write(./services/**)'] } },
      OPEN_POLICY,
    );
    expect(compiled.effective.deny).toContain('Edit(./services/**)');
    expect(compiled.effective.deny).toContain('Write(./services/**)');
  });

  it('never puts Edit(*) in the compiled allow set', () => {
    const compiled = compilePermissions(
      { allow: ['Edit(*)', 'Read'] },
      undefined,
      FREE_ASSIGNMENT,
      OPEN_POLICY,
    );
    expect(compiled.effective.allow).toEqual(['Read']);
    expect(compiled.effective.allow).not.toContain('Edit');
    expect(codesOf(compiled.diagnostics)).toContain(
      'roster.permissions.wildcard-file-scope-dropped',
    );
  });

  it('normalises policy.globalDeny too, so foundation cannot state an inert rule', () => {
    const compiled = compilePermissions(undefined, undefined, FREE_ASSIGNMENT, {
      allowPermissionElevation: true,
      globalDeny: ['MultiEdit(C:/Windows/**)'],
    });
    expect(compiled.effective.deny).toContain('Edit(C:/Windows/**)');
  });
});

describe('grantTool — the compiler’s own auto-approvals', () => {
  it('adds a rule no layer declared, sorted into the allow set', () => {
    const compiled = compilePermissions(
      { allow: ['Read'] },
      undefined,
      FREE_ASSIGNMENT,
      OPEN_POLICY,
    );
    expect(grantTool(compiled, 'Skill').effective.allow).toEqual(['Read', 'Skill']);
  });

  it('refuses to override a deny', () => {
    const denied = compilePermissions(
      { allow: ['Read'], deny: ['Skill'] },
      undefined,
      FREE_ASSIGNMENT,
      OPEN_POLICY,
    );
    expect(grantTool(denied, 'Skill').effective.allow).toEqual(['Read']);
  });

  it('is a no-op when the rule is already granted', () => {
    const compiled = compilePermissions(
      { allow: ['Skill'] },
      undefined,
      FREE_ASSIGNMENT,
      OPEN_POLICY,
    );
    expect(grantTool(compiled, 'Skill')).toBe(compiled);
  });
});
