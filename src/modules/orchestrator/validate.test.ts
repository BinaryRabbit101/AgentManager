/**
 * DESIGN §9's rule set, one case per rule.
 *
 * IMPLEMENTATION M1's acceptance: *"Every §9 rule has a test that refuses with
 * its own named code; no rule is enforced in two places."* This file is the
 * first half. The second half is structural and is asserted at the bottom: the
 * only place a `RefusalCode` is *produced* is `validate.ts`, so a rule cannot be
 * enforced twice without that assertion failing.
 *
 * Every case here runs with **no database, no service and no fixtures** — which
 * is the whole reason §9 was specified as a pure function over resolved facts.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ORCHESTRATOR_CONFIG_DEFAULTS } from './config.js';
import { REFUSAL_CODES, WARNING_CODES, type RefusalCode, type WarningCode } from './errors.js';
import type { AgentFacts, ValidationInput } from './validate.js';
import { isMachineCreated, validateCreateAssignment } from './validate.js';
import type { CreateAssignmentRequest } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

function agent(overrides: Partial<AgentFacts> & { id: string }): AgentFacts {
  return {
    name: overrides.id,
    archived: false,
    overseer: false,
    roles: ['implementer'],
    openAssignments: 0,
    ...overrides,
  };
}

const ADA = agent({ id: 'ada', roles: ['architect', 'implementer'] });
const SAM = agent({ id: 'sam', roles: ['skeptic'] });

function input(
  request: Partial<CreateAssignmentRequest> = {},
  overrides: Partial<ValidationInput> = {},
): ValidationInput {
  const full: CreateAssignmentRequest = {
    projectId: 'proj-1',
    pattern: 'solo',
    members: [{ agentId: 'ada', role: 'implementer' }],
    ...request,
  };
  return {
    request: full,
    moduleEnabled: true,
    project: { id: 'proj-1', status: 'active' },
    agents: new Map([
      ['ada', ADA],
      ['sam', SAM],
    ]),
    config: ORCHESTRATOR_CONFIG_DEFAULTS,
    ...overrides,
  };
}

function codes(result: ReturnType<typeof validateCreateAssignment>): readonly string[] {
  return result.refusals.map((refusal) => refusal.code);
}

describe('the §9 validator — the happy path', () => {
  it('accepts a plain user-created solo with no refusals and no gate', () => {
    const result = validateCreateAssignment(input());
    expect(result.refusals).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.gate).toBeUndefined();
  });

  it('is pure: the same input twice produces the same answer', () => {
    const one = validateCreateAssignment(input());
    const two = validateCreateAssignment(input());
    expect(one).toEqual(two);
  });
});

describe('§9 rule 1 — the module is enabled and the project is active', () => {
  it('refuses module_disabled when modules.orchestrator.enabled is false', () => {
    const result = validateCreateAssignment(input({}, { moduleEnabled: false }));
    expect(codes(result)).toContain('module_disabled');
  });

  it('refuses project_not_found for an unknown project', () => {
    const result = validateCreateAssignment(input({}, { project: undefined }));
    expect(codes(result)).toContain('project_not_found');
  });

  it.each(['provisioning', 'archived'])(
    'refuses project_not_active when status is %s',
    (status) => {
      const result = validateCreateAssignment(input({}, { project: { id: 'proj-1', status } }));
      expect(codes(result)).toContain('project_not_active');
      expect(result.refusals.find((r) => r.code === 'project_not_active')?.message).toContain(
        status,
      );
    },
  );
});

describe('§9 rule 2 — the target project equals the caller\u2019s', () => {
  it('refuses project_mismatch when a parent reaches across projects', () => {
    const result = validateCreateAssignment(
      input(
        { createdBy: 'overseer:ada', tokenBudget: 1000, parentAssignmentId: 'parent' },
        {
          parent: {
            id: 'parent',
            projectId: 'other-project',
            status: 'open',
            parentAssignmentId: null,
            tokenBudget: 100_000,
            tokensUsed: 0,
            openChildBudgets: 0,
          },
        },
      ),
    );
    expect(codes(result)).toContain('project_mismatch');
  });
});

describe('§9 rule 3 — nesting depth', () => {
  it('refuses nesting_depth when the parent is itself a child', () => {
    const result = validateCreateAssignment(
      input(
        { createdBy: 'overseer:ada', tokenBudget: 1000, parentAssignmentId: 'parent' },
        {
          parent: {
            id: 'parent',
            projectId: 'proj-1',
            status: 'open',
            parentAssignmentId: 'grandparent',
            tokenBudget: 100_000,
            tokensUsed: 0,
            openChildBudgets: 0,
          },
        },
      ),
    );
    expect(codes(result)).toContain('nesting_depth');
  });
});

describe('§9 rule 4 — the pattern ships with a driver', () => {
  it.each(['review', 'overseer'] as const)('refuses unsupported_pattern for %s', (pattern) => {
    const result = validateCreateAssignment(input({ pattern }));
    expect(codes(result)).toContain('unsupported_pattern');
  });

  it.each(['solo', 'pair'] as const)('accepts %s', (pattern) => {
    const result = validateCreateAssignment(
      input({
        pattern,
        members:
          pattern === 'pair'
            ? [
                { agentId: 'ada', role: 'architect' },
                { agentId: 'sam', role: 'skeptic' },
              ]
            : [{ agentId: 'ada', role: 'implementer' }],
      }),
    );
    expect(codes(result)).not.toContain('unsupported_pattern');
  });
});

describe('§9 rule 5 — every member\u2019s role is one of the five and is declared', () => {
  it('refuses invalid_role for a role outside the pinned five', () => {
    const result = validateCreateAssignment(
      input({ members: [{ agentId: 'ada', role: 'wizard' as never }] }),
    );
    expect(codes(result)).toContain('invalid_role');
  });

  it('refuses role_not_declared and names what the agent does declare', () => {
    const result = validateCreateAssignment(
      input({ members: [{ agentId: 'sam', role: 'implementer' }] }),
    );
    expect(codes(result)).toContain('role_not_declared');
    const refusal = result.refusals.find((r) => r.code === 'role_not_declared');
    expect(refusal?.message).toContain('skeptic');
    expect(refusal?.details).toMatchObject({ agentId: 'sam', role: 'implementer' });
  });
});

describe('§9 rule 6 — the lead seat', () => {
  it('refuses lead_not_overseer when an overseer pattern is led by a non-overseer', () => {
    const result = validateCreateAssignment(
      input({
        pattern: 'overseer',
        members: [{ agentId: 'ada', role: 'implementer' }],
      }),
    );
    expect(codes(result)).toContain('lead_not_overseer');
  });

  it('does not raise it when the lead declares capabilities.overseer', () => {
    const result = validateCreateAssignment(
      input(
        { pattern: 'overseer', members: [{ agentId: 'ove', role: 'overseer' }] },
        {
          agents: new Map([
            ['ove', agent({ id: 'ove', overseer: true, roles: ['overseer', 'implementer'] })],
          ]),
        },
      ),
    );
    expect(codes(result)).not.toContain('lead_not_overseer');
  });
});

describe('§9 rule 7 — archived, at capacity, or holding two seats', () => {
  it('refuses agent_not_found for an id the roster does not know', () => {
    const result = validateCreateAssignment(
      input({ members: [{ agentId: 'ghost', role: 'implementer' }] }),
    );
    expect(codes(result)).toContain('agent_not_found');
  });

  it('refuses member_archived', () => {
    const result = validateCreateAssignment(
      input({}, { agents: new Map([['ada', agent({ id: 'ada', archived: true })]]) }),
    );
    expect(codes(result)).toContain('member_archived');
  });

  it('refuses member_at_capacity at maxConcurrentPerAgent, not before it', () => {
    const atLimit = validateCreateAssignment(
      input({}, { agents: new Map([['ada', agent({ id: 'ada', openAssignments: 2 })]]) }),
    );
    expect(codes(atLimit)).toContain('member_at_capacity');

    const below = validateCreateAssignment(
      input({}, { agents: new Map([['ada', agent({ id: 'ada', openAssignments: 1 })]]) }),
    );
    expect(codes(below)).not.toContain('member_at_capacity');
  });

  it('refuses duplicate_member — two seats may not be the same agent', () => {
    const result = validateCreateAssignment(
      input({
        pattern: 'pair',
        members: [
          { agentId: 'ada', role: 'architect' },
          { agentId: 'ada', role: 'implementer' },
        ],
      }),
    );
    expect(codes(result)).toContain('duplicate_member');
  });

  it('refuses no_members for an empty seat list', () => {
    expect(codes(validateCreateAssignment(input({ members: [] })))).toContain('no_members');
  });
});

describe('§9 rule 8 — the budget', () => {
  it('refuses budget_required for a machine-created assignment with a null budget', () => {
    const result = validateCreateAssignment(input({ createdBy: 'overseer:ada' }));
    expect(codes(result)).toContain('budget_required');
  });

  it('does not require a budget from a user', () => {
    expect(codes(validateCreateAssignment(input({ createdBy: 'user' })))).not.toContain(
      'budget_required',
    );
  });

  it('refuses budget_exceeds_parent using budget − used − open children', () => {
    const parent = {
      id: 'parent',
      projectId: 'proj-1',
      status: 'open',
      parentAssignmentId: null,
      tokenBudget: 100_000,
      tokensUsed: 30_000,
      openChildBudgets: 50_000,
    };
    // Remaining is 20 000.
    const over = validateCreateAssignment(
      input(
        { createdBy: 'overseer:ada', tokenBudget: 20_001, parentAssignmentId: 'parent' },
        { parent },
      ),
    );
    expect(codes(over)).toContain('budget_exceeds_parent');

    const exact = validateCreateAssignment(
      input(
        { createdBy: 'overseer:ada', tokenBudget: 20_000, parentAssignmentId: 'parent' },
        { parent },
      ),
    );
    expect(codes(exact)).not.toContain('budget_exceeds_parent');
  });
});

describe('§9 rule 9 — the projection check', () => {
  const overBudget = {
    pattern: 'pair' as const,
    members: [
      { agentId: 'ada', role: 'architect' as const },
      { agentId: 'sam', role: 'skeptic' as const },
    ],
    roundCap: 3,
    // 3 × 2 × 25 000 = 150 000, comfortably over.
    tokenBudget: 100_000,
  };

  it('warns a human rather than refusing (roster §8\u2019s sanctioned lever)', () => {
    const result = validateCreateAssignment(input(overBudget));
    expect(codes(result)).not.toContain('projection_exceeds_budget');
    expect(result.warnings.map((w) => w.code)).toContain('projection_exceeds_budget');
    expect(result.warnings[0]?.message).toContain('crude planning constant');
  });

  it('refuses projection_exceeds_budget for a machine-created assignment', () => {
    const result = validateCreateAssignment(input({ ...overBudget, createdBy: 'overseer:ada' }));
    expect(codes(result)).toContain('projection_exceeds_budget');
  });

  it('passes when the budget covers the projection', () => {
    const result = validateCreateAssignment(
      input({ ...overBudget, createdBy: 'overseer:ada', tokenBudget: 400_000 }),
    );
    expect(codes(result)).not.toContain('projection_exceeds_budget');
  });
});

describe('§9 rule 10 — write: true from a machine is created behind a gate', () => {
  it('returns a gate for a machine-created write-capable assignment', () => {
    const result = validateCreateAssignment(
      input({ createdBy: 'overseer:ada', tokenBudget: 400_000, write: true }),
    );
    expect(result.refusals).toEqual([]);
    expect(result.gate).toEqual({ reason: 'write-capable assignment created by an overseer' });
  });

  it('returns no gate for a machine-created read-only assignment', () => {
    const result = validateCreateAssignment(
      input({ createdBy: 'overseer:ada', tokenBudget: 400_000, write: false }),
    );
    expect(result.gate).toBeUndefined();
  });

  it('returns no gate for a user-created write-capable assignment', () => {
    expect(validateCreateAssignment(input({ write: true })).gate).toBeUndefined();
  });
});

describe('§9 rule 11 — scope paths', () => {
  it.each([
    ['C:\\Code\\App', 'absolute'],
    ['/etc/passwd', 'absolute'],
    ['../secrets', 'traversal'],
    ['docs/../../etc', 'traversal'],
    ['docs/**', 'glob'],
    ['   ', 'empty'],
  ])('refuses scope_path_invalid for %s (%s)', (path, problem) => {
    const result = validateCreateAssignment(input({ scope: { paths: [path] } }));
    expect(codes(result)).toContain('scope_path_invalid');
    expect(result.refusals[0]?.details).toMatchObject({ problem });
  });

  it('checks artifactPath by the same rule', () => {
    const result = validateCreateAssignment(
      input({ scope: { paths: ['docs/'], artifactPath: '../DESIGN.md' } }),
    );
    expect(codes(result)).toContain('scope_path_invalid');
    expect(result.refusals[0]?.details).toMatchObject({ field: 'artifactPath' });
  });

  it('accepts a repo-relative directory and file', () => {
    const result = validateCreateAssignment(
      input({ scope: { paths: ['docs/', 'docs/orchestrator/DESIGN.md'] } }),
    );
    expect(codes(result)).not.toContain('scope_path_invalid');
  });
});

describe('§2.3 — work-item linking refuses by name, never silently', () => {
  it('refuses work_item_not_found for an unknown id', () => {
    const result = validateCreateAssignment(
      input({ workItemIds: ['wi-1'] }, { workItems: new Map() }),
    );
    expect(codes(result)).toContain('work_item_not_found');
  });

  it('refuses work_item_cross_project for an id from another project', () => {
    const result = validateCreateAssignment(
      input(
        { workItemIds: ['wi-1'] },
        { workItems: new Map([['wi-1', { id: 'wi-1', projectId: 'other' }]]) },
      ),
    );
    expect(codes(result)).toContain('work_item_cross_project');
  });

  it('accepts an id from this project', () => {
    const result = validateCreateAssignment(
      input(
        { workItemIds: ['wi-1'] },
        { workItems: new Map([['wi-1', { id: 'wi-1', projectId: 'proj-1' }]]) },
      ),
    );
    expect(result.refusals).toEqual([]);
  });
});

describe('§2.6 — scope-overlap awareness warns, never blocks', () => {
  it('says nothing when neither assignment is write-capable', () => {
    const result = validateCreateAssignment(
      input({ write: false }, { overlaps: [{ assignmentId: 'other', write: false }] }),
    );
    expect(result.warnings).toEqual([]);
    expect(result.refusals).toEqual([]);
  });

  it('warns when exactly one is write-capable, and does not refuse', () => {
    const result = validateCreateAssignment(
      input({ write: true }, { overlaps: [{ assignmentId: 'other', write: false }] }),
    );
    expect(result.warnings.map((w) => w.code)).toEqual(['scope_overlap']);
    expect(result.warnings[0]?.message).toContain('read-only');
    expect(result.refusals).toEqual([]);
  });

  it('warns and names both when both are write-capable', () => {
    const result = validateCreateAssignment(
      input({ write: true }, { overlaps: [{ assignmentId: 'other', write: true }] }),
    );
    expect(result.warnings[0]?.message).toContain('both are write-capable');
    expect(result.refusals).toEqual([]);
  });
});

describe('refusals are collected, not thrown one at a time', () => {
  it('reports every broken rule in one answer', () => {
    const result = validateCreateAssignment(
      input(
        {
          pattern: 'review',
          members: [{ agentId: 'sam', role: 'implementer' }],
          scope: { paths: ['../x'] },
        },
        { project: { id: 'proj-1', status: 'archived' } },
      ),
    );
    expect([...codes(result)].sort()).toEqual(
      [
        'project_not_active',
        'role_not_declared',
        'scope_path_invalid',
        'unsupported_pattern',
      ].sort(),
    );
  });
});

describe('isMachineCreated', () => {
  it.each([
    ['overseer:ada', true],
    ['user', false],
    ['system', false],
    [undefined, false],
  ])('%s → %s', (createdBy, expected) => {
    expect(isMachineCreated(createdBy)).toBe(expected);
  });
});

describe('no rule is enforced in two places', () => {
  it('produces every RefusalCode only inside validate.ts', () => {
    // The structural half of M1's acceptance. A second producer of any code
    // would mean the same rule is decided twice and could disagree with itself;
    // `errors.ts` *declares* the vocabulary and `service.ts`/`routes.ts` only
    // ever re-throw what the validator returned.
    const validator = readFileSync(resolve(here, 'validate.ts'), 'utf8');
    const others = ['service.ts', 'routes.ts', 'repository.ts', 'module.ts'].map((name) =>
      readFileSync(resolve(here, name), 'utf8'),
    );

    for (const code of REFUSAL_CODES) {
      const literal = `code: '${code}'`;
      expect(validator, `${code} must be produced in validate.ts`).toContain(literal);
      for (const source of others) {
        expect(source, `${code} must not be produced outside validate.ts`).not.toContain(literal);
      }
    }
  });

  it('declares exactly the codes the validator can emit', () => {
    // Both vocabularies, because §9-9 is the same condition in both: a warning
    // for a human who is watching, a refusal for a machine that is not. A code
    // the validator emits but neither list declares is a code no consumer can
    // switch on.
    const validator = readFileSync(resolve(here, 'validate.ts'), 'utf8');
    const emitted = new Set<string>(
      [...validator.matchAll(/code: '([a-z_]+)'/g)].map((match) => match[1] as string),
    );
    const declared = new Set<string>([
      ...(REFUSAL_CODES as readonly RefusalCode[]),
      ...(WARNING_CODES as readonly WarningCode[]),
    ]);
    expect([...emitted].sort()).toEqual([...declared].sort());
  });
});
