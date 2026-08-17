/**
 * DESIGN §9's rule set, as a **pure function over its inputs**.
 *
 * > "An overseer agent may *propose* any decomposition it likes […]. Every
 * > proposal passes through the same `createAssignment` validator as a human's,
 * > and the validator is pure, deterministic, and refuses with a named rule.
 * > Nothing the model says can widen what the rules allow."
 *
 * Purity is the point, not a style preference. This function takes facts — the
 * project's status, each named agent's roles and archived flag, how many open
 * assignments each already holds, the parent's budget arithmetic — and returns
 * refusals and warnings. It reads no database, calls no service, and consults no
 * clock, which is what lets §9's eleven rules be table-tested one case per rule
 * with no fixtures at all. The service resolves the facts; this decides.
 *
 * **Every rule is enforced here and nowhere else** (IMPLEMENTATION M1: "no rule
 * is enforced in two places"). `createSolo` is not a second code path: it builds
 * a one-member `CreateAssignmentRequest` and comes through here like everything
 * else, which is what makes "solo is the trivial assignment" (§2.1) true in the
 * code rather than only in the prose.
 */
import type { OrchestratorConfig } from './config.js';
import type { Refusal } from './errors.js';
import { normaliseScopePath } from './scopeRules.js';
import {
  ASSIGNMENT_ROLES,
  SUPPORTED_PATTERNS,
  isAssignmentRole,
  type AssignmentWarning,
  type CreateAssignmentRequest,
} from './types.js';

/** What the validator needs to know about the target project (§9-1, §9-2). */
export interface ProjectFacts {
  readonly id: string;
  /** `active` | `provisioning` | `archived` — only `active` may take new work. */
  readonly status: string;
}

/** What the validator needs to know about one named agent (§9-5, §9-6, §9-7). */
export interface AgentFacts {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
  /** `capabilities.overseer` (roster §11). */
  readonly overseer: boolean;
  /** `capabilities.roles` — the seats this agent declared it can fill. */
  readonly roles: readonly string[];
  /** How many **other** `open` assignments it already holds a seat in (§9-7). */
  readonly openAssignments: number;
}

/** The parent's budget arithmetic, for a machine-created child (§9-8). */
export interface ParentFacts {
  readonly id: string;
  readonly projectId: string;
  readonly status: string;
  /** Non-null makes the child a grandchild, which §9-3 forbids. */
  readonly parentAssignmentId: string | null;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  /** Σ of the `token_budget`s of this parent's still-open children (§9-8). */
  readonly openChildBudgets: number;
}

/** One work item named by `workItemIds`, for the §2.3 cross-project check. */
export interface WorkItemFacts {
  readonly id: string;
  readonly projectId: string;
}

/**
 * Everything §9 may see. Resolved by the service; never fetched here.
 *
 * `agents` is a map rather than a list so a request naming an unknown id is
 * distinguishable from one naming a known id badly — the difference between
 * `agent_not_found` and `role_not_declared`.
 */
export interface ValidationInput {
  readonly request: CreateAssignmentRequest;
  readonly moduleEnabled: boolean;
  readonly project: ProjectFacts | undefined;
  readonly agents: ReadonlyMap<string, AgentFacts>;
  readonly parent?: ParentFacts | undefined;
  /** Only the ids `request.workItemIds` named that actually resolved. */
  readonly workItems?: ReadonlyMap<string, WorkItemFacts>;
  readonly config: OrchestratorConfig;
  /**
   * Open, write-capable assignments on the same project whose scope overlaps
   * (§2.6). Resolved by the service with a deterministic prefix comparison.
   */
  readonly overlaps?: readonly { readonly assignmentId: string; readonly write: boolean }[];
}

export interface ValidationResult {
  readonly refusals: readonly Refusal[];
  readonly warnings: readonly AssignmentWarning[];
  /** True when §9-10 requires the assignment to be parked at `phase: planned`. */
  readonly gate: GateOutcome | undefined;
}

export interface GateOutcome {
  readonly reason: string;
}

/** True when the caller is a machine — the extra rules of §9 apply only to those. */
export function isMachineCreated(createdBy: string | undefined): boolean {
  return createdBy !== undefined && createdBy.startsWith('overseer:');
}

/**
 * Runs §9's rules **in order**, collecting every refusal rather than stopping at
 * the first.
 *
 * Collecting is deliberate: a create dialog that fixes one problem, resubmits,
 * and is told about the next is precisely the interaction a pure validator lets
 * us avoid, and an overseer that learns all of what is wrong in one refusal
 * retries once instead of five times (§4.2).
 */
export function validateCreateAssignment(input: ValidationInput): ValidationResult {
  const { request, config } = input;
  const refusals: Refusal[] = [];
  const warnings: AssignmentWarning[] = [];
  const machine = isMachineCreated(request.createdBy);
  const write = request.write ?? true;

  // --- §9-1: the module is enabled and the project is `active` --------------
  if (!input.moduleEnabled) {
    refusals.push({
      code: 'module_disabled',
      message:
        'The orchestrator module is disabled (modules.orchestrator.enabled), so no assignment ' +
        'can be created.',
    });
  }

  if (input.project === undefined) {
    refusals.push({
      code: 'project_not_found',
      message: `No project ${request.projectId} exists.`,
      details: { projectId: request.projectId },
    });
  } else if (input.project.status !== 'active') {
    refusals.push({
      code: 'project_not_active',
      message:
        `Project ${request.projectId} is "${input.project.status}", not "active". ` +
        'Only an active project takes new assignments.',
      details: { projectId: request.projectId, status: input.project.status },
    });
  }

  // --- §9-2: the target project equals the caller's ------------------------
  if (input.parent !== undefined && input.parent.projectId !== request.projectId) {
    refusals.push({
      code: 'project_mismatch',
      message:
        `Assignment ${input.parent.id} is on project ${input.parent.projectId}; it cannot create ` +
        `work on project ${request.projectId}. An overseer cannot reach across projects.`,
      details: { parentProjectId: input.parent.projectId, projectId: request.projectId },
    });
  }

  // --- §9-3: nesting depth ≤ maxNestingDepth -------------------------------
  if (input.parent !== undefined && input.parent.parentAssignmentId !== null) {
    refusals.push({
      code: 'nesting_depth',
      message:
        `Assignment ${input.parent.id} is itself a child assignment, and nesting is limited to ` +
        `${String(config.assignment.maxNestingDepth)} level(s). No overseer minting overseers.`,
      details: {
        parentAssignmentId: input.parent.id,
        maxNestingDepth: config.assignment.maxNestingDepth,
      },
    });
  }

  // --- §9-4: the pattern ships with a driver -------------------------------
  if (!SUPPORTED_PATTERNS.includes(request.pattern)) {
    refusals.push({
      code: 'unsupported_pattern',
      message:
        `Pattern "${request.pattern}" is not shipped in this build. Supported: ` +
        `${SUPPORTED_PATTERNS.join(', ')}.`,
      details: { pattern: request.pattern, supported: [...SUPPORTED_PATTERNS] },
    });
  }

  // --- §9-5 / §9-7: members, roles, seats (§2.4) ---------------------------
  if (request.members.length === 0) {
    refusals.push({
      code: 'no_members',
      message: 'An assignment needs at least one member.',
    });
  }

  const seen = new Set<string>();
  for (const member of request.members) {
    if (seen.has(member.agentId)) {
      refusals.push({
        code: 'duplicate_member',
        message:
          `Agent ${member.agentId} is named twice. One agent may hold at most one seat — an ` +
          'adversarial pair where both sides are the same identity is theatre, not review.',
        details: { agentId: member.agentId },
      });
      continue;
    }
    seen.add(member.agentId);

    if (!isAssignmentRole(member.role)) {
      refusals.push({
        code: 'invalid_role',
        message: `"${String(member.role)}" is not a role. The five are: ${ASSIGNMENT_ROLES.join(', ')}.`,
        details: { agentId: member.agentId, role: member.role },
      });
      continue;
    }

    const agent = input.agents.get(member.agentId);
    if (agent === undefined) {
      refusals.push({
        code: 'agent_not_found',
        message: `No agent ${member.agentId} is in the roster.`,
        details: { agentId: member.agentId },
      });
      continue;
    }

    if (agent.archived) {
      refusals.push({
        code: 'member_archived',
        message: `Agent ${member.agentId} is archived and cannot be assigned work.`,
        details: { agentId: member.agentId },
      });
    }

    // §9-5: the role must appear in `capabilities.roles` — otherwise the agent
    // has no addendum and never declared itself able to fill the seat.
    if (!agent.roles.includes(member.role)) {
      refusals.push({
        code: 'role_not_declared',
        message:
          `Agent ${member.agentId} (${agent.name}) does not declare the role "${member.role}". ` +
          `It declares: ${agent.roles.length === 0 ? 'none' : agent.roles.join(', ')}.`,
        details: { agentId: member.agentId, role: member.role, declared: [...agent.roles] },
      });
    }

    if (agent.openAssignments >= config.assignment.maxConcurrentPerAgent) {
      refusals.push({
        code: 'member_at_capacity',
        message:
          `Agent ${member.agentId} already holds a seat in ${String(agent.openAssignments)} open ` +
          `assignment(s), at the limit of ${String(config.assignment.maxConcurrentPerAgent)} ` +
          '(orchestrator.assignment.maxConcurrentPerAgent).',
        details: {
          agentId: member.agentId,
          openAssignments: agent.openAssignments,
          limit: config.assignment.maxConcurrentPerAgent,
        },
      });
    }
  }

  // --- §9-6: the lead seat ------------------------------------------------
  // For `overseer` the lead must be `capabilities.overseer`; for `pair` the
  // drafting seat leads. `overseer` is refused by §9-4 in this build, so the
  // check below is the one that survives it — stated in full so the rule lives
  // here and not in the pattern definition that lands in M6.
  if (request.pattern === 'overseer') {
    const lead = request.members[0];
    const agent = lead === undefined ? undefined : input.agents.get(lead.agentId);
    if (agent !== undefined && !agent.overseer) {
      refusals.push({
        code: 'lead_not_overseer',
        message:
          `Agent ${agent.id} leads an "overseer" assignment but does not declare ` +
          'capabilities.overseer.',
        details: { agentId: agent.id },
      });
    }
  }

  // --- §9-8: the budget ---------------------------------------------------
  const tokenBudget = request.tokenBudget ?? null;
  if (machine && tokenBudget === null) {
    refusals.push({
      code: 'budget_required',
      message:
        'An assignment created by an overseer must carry a token budget. An overseer cannot mint ' +
        'uncapped work.',
    });
  }

  if (tokenBudget !== null && input.parent !== undefined) {
    const remaining =
      (input.parent.tokenBudget ?? Number.POSITIVE_INFINITY) -
      input.parent.tokensUsed -
      input.parent.openChildBudgets;
    if (tokenBudget > remaining) {
      refusals.push({
        code: 'budget_exceeds_parent',
        message:
          `A budget of ${String(tokenBudget)} tokens exceeds the parent's remaining ` +
          `${String(Math.max(0, remaining))} (budget − used − open children's budgets).`,
        details: { tokenBudget, remaining },
      });
    }
  }

  // --- §9-9: the projection check (§7.2) ----------------------------------
  // "roundCap × seats × turnEstimateTokens" — labelled a crude planning constant
  // in the config comment and in the UI, because it is one number in a file.
  const roundCap = request.roundCap ?? null;
  if (tokenBudget !== null && roundCap !== null && request.members.length > 0) {
    const projected = roundCap * request.members.length * config.budgets.turnEstimateTokens;
    if (projected > tokenBudget) {
      const message =
        `Projected cost is about ${String(projected)} tokens ` +
        `(${String(roundCap)} rounds × ${String(request.members.length)} seats × ` +
        `${String(config.budgets.turnEstimateTokens)}), above the ${String(tokenBudget)}-token ` +
        'budget. turnEstimateTokens is a crude planning constant, not a prediction.';
      // Roster §8's sanctioned lever: a warning for a human who is watching, a
      // refusal for a machine that is not.
      if (machine) {
        refusals.push({
          code: 'projection_exceeds_budget',
          message,
          details: { projected, tokenBudget },
        });
      } else {
        warnings.push({ code: 'projection_exceeds_budget', message });
      }
    }
  }

  // --- §9-11: scope paths -------------------------------------------------
  for (const raw of request.scope?.paths ?? []) {
    const normalised = normaliseScopePath(raw);
    if (normalised.path !== undefined) continue;
    refusals.push({
      code: 'scope_path_invalid',
      message: scopeMessage(raw, normalised.problem),
      details: { path: raw, problem: normalised.problem },
    });
  }
  const artifact = request.scope?.artifactPath;
  if (artifact !== undefined) {
    const normalised = normaliseScopePath(artifact);
    if (normalised.path === undefined) {
      refusals.push({
        code: 'scope_path_invalid',
        message: scopeMessage(artifact, normalised.problem),
        details: { path: artifact, problem: normalised.problem, field: 'artifactPath' },
      });
    }
  }

  // --- §2.3's work-item linking: "an unknown or cross-project id is a named
  // refusal at create, not a silent drop".
  for (const itemId of request.workItemIds ?? []) {
    const item = input.workItems?.get(itemId);
    if (item === undefined) {
      refusals.push({
        code: 'work_item_not_found',
        message: `No work item ${itemId} exists.`,
        details: { workItemId: itemId },
      });
    } else if (item.projectId !== request.projectId) {
      refusals.push({
        code: 'work_item_cross_project',
        message: `Work item ${itemId} belongs to project ${item.projectId}, not ${request.projectId}.`,
        details: { workItemId: itemId, projectId: item.projectId },
      });
    }
  }

  // --- §2.6: scope-overlap awareness (warn, do not block) -----------------
  for (const overlap of input.overlaps ?? []) {
    // Two readers cannot collide, so an overlap between read-only assignments is
    // recorded and not warned about.
    if (!write && !overlap.write) continue;
    warnings.push({
      code: 'scope_overlap',
      message:
        `Scope overlaps open assignment ${overlap.assignmentId}` +
        `${overlap.write && write ? ' — both are write-capable' : ' (read-only)'}.`,
    });
  }

  // --- §9-10: `write: true` from a machine is created behind a gate --------
  const gate: GateOutcome | undefined =
    machine && write ? { reason: 'write-capable assignment created by an overseer' } : undefined;

  return { refusals, warnings, gate };
}

function scopeMessage(path: string, problem: string | undefined): string {
  switch (problem) {
    case 'absolute':
      return `Scope path "${path}" is absolute. Scope paths are repo-relative (DESIGN §9-11).`;
    case 'traversal':
      return `Scope path "${path}" contains "..". Scope paths must resolve inside the project.`;
    case 'glob':
      return `Scope path "${path}" contains a glob. Scope paths name a directory or a file.`;
    default:
      return `Scope path "${path}" is empty.`;
  }
}
