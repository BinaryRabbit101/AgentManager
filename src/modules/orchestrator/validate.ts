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
  /**
   * Σ of what this parent's **closed** children actually spent (§7.5).
   *
   * Without it the remainder heals every time a child closes: the child's
   * reservation leaves `openChildBudgets`, its spend was never added to the
   * parent's own `tokens_used` (runner meters onto the child's row, §7.1), and
   * the lead could hand the same tokens out again. Optional so a caller that
   * has not resolved it is not lying about it — absent reads as zero, which is
   * the correct value for an assignment with no closed children.
   */
  readonly closedChildTokensUsed?: number | undefined;
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

    // §9-5, **owner decision 2026-08-18**: `capabilities.roles` is a *ranking
    // hint*, not a gate. "Any agent may work in any pair or group" — the user's
    // seating choice is authoritative, and a role the agent did not declare
    // costs it only that role's persona addendum (roster's `roles/<role>.md`
    // lookup is optional and appends nothing when the file is absent, so the
    // session still compiles). So this is a warning the create dialog shows
    // before the user confirms (§16-9), not a refusal that overrules them.
    if (!agent.roles.includes(member.role)) {
      warnings.push({
        code: 'role_not_declared',
        message:
          `Agent ${member.agentId} (${agent.name}) does not declare the role "${member.role}", ` +
          `so it works the seat without that role's persona addendum. It declares: ` +
          `${agent.roles.length === 0 ? 'none' : agent.roles.join(', ')}.`,
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

  // --- §3.3 / §3.6: the two-seat patterns have exactly two seats ----------
  //
  // Both patterns declare two required seats and their `plan()` reads exactly
  // two members, so a third was never anything but an inert row: it never took a
  // turn, never got a prompt, and still counted against
  // `maxConcurrentPerAgent`. That is a user who thinks they seated three people
  // and a fleet that quietly disagrees, which is the shape of the incident WO5
  // exists to answer — so it is a **named** refusal here rather than silence in
  // the planner, exactly as §9-6 already refuses a second overseer seat.
  //
  // One member is refused for the mirror reason: a pair with nobody to argue
  // with, or a change with nobody to review it, is a solo assignment wearing a
  // pattern's name, and the honest answer is to say so rather than to wait
  // forever on `no_members`.
  //
  // Whether the seated agents *declare* the seats' roles stays a warning
  // (`role_not_declared` above) — owner decision 2026-08-18: capabilities rank,
  // they never gate. This rule counts seats, never labels.
  if (request.pattern === 'pair' || request.pattern === 'review') {
    const shape =
      request.pattern === 'pair'
        ? { seats: 'the drafter and the critic', article: 'A "pair"' }
        : { seats: 'the implementer and the reviewer', article: 'A "review"' };
    if (request.members.length === 1) {
      refusals.push({
        code: 'seat_unfilled',
        message:
          `${shape.article} assignment has two seats, ${shape.seats}, and one member fills only ` +
          'one of them. Name a second member, or start a solo assignment instead.',
        details: { pattern: request.pattern, members: request.members.length, seats: 2 },
      });
    }
    if (request.members.length > 2) {
      refusals.push({
        code: 'seat_not_in_pattern',
        message:
          `${shape.article} assignment has exactly two seats, ${shape.seats}. The extra ` +
          `member${request.members.length > 3 ? 's hold' : ' holds'} no seat, so nothing would ` +
          'ever plan a turn for them.',
        details: { pattern: request.pattern, members: request.members.length, seats: 2 },
      });
    }
  }

  // --- §9-6: the lead seat ------------------------------------------------
  // **Owner decision, 2026-08-18**: `capabilities.overseer` is a ranking hint
  // for *suggesting* leads, not a gate on who may hold the seat. So a lead that
  // does not declare it gets a warning and the assignment runs — and the
  // coordinator's two tools follow the **seat**, mounted for whoever holds it
  // (`toolset.ts`), because a lead that cannot create a child assignment is a
  // lead in name only.
  //
  // The lead is the member holding the `overseer` role, falling back to the
  // first seat: seat order is the pattern's, and a request that names a worker
  // first must not be able to point the rule at the wrong agent.
  if (request.pattern === 'overseer') {
    const lead = request.members.find((member) => member.role === 'overseer') ?? request.members[0];
    const agent = lead === undefined ? undefined : input.agents.get(lead.agentId);
    if (agent !== undefined && !agent.overseer) {
      warnings.push({
        code: 'lead_not_overseer',
        message:
          `Agent ${agent.id} (${agent.name}) leads this overseer assignment without declaring ` +
          'capabilities.overseer. It gets the coordinator tools because it holds the lead seat; ' +
          'the capability only ranks suggested leads.',
      });
    }
    // §3.5's seat vocabulary: one seat. The workers hold seats in the child
    // assignments the lead mints, and a second seat here would give one
    // assignment two turn loops — which `assignment_turns_active` forbids.
    if (request.members.length > 1) {
      refusals.push({
        code: 'seat_not_in_pattern',
        message:
          'The overseer pattern has exactly one seat, the lead. Its workers join through the ' +
          'child assignments the lead creates, not through seats on this assignment.',
        details: { members: request.members.length },
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

  // §7.2's other half of the same rule: the *parent* of machine-created work is
  // budgeted too. Every child's budget is debited from this one's remainder, so
  // an uncapped overseer assignment is an unbounded tree — and unlike a pair it
  // gets no config default, because a number the user did not choose is not a
  // cap they agreed to on work that spawns more work.
  if (!machine && request.pattern === 'overseer' && tokenBudget === null) {
    refusals.push({
      code: 'budget_required',
      message:
        'An "overseer" assignment must carry a token budget: every child assignment its lead ' +
        'creates is debited from this one’s remainder, so an uncapped overseer is an unbounded ' +
        'tree.',
    });
  }

  if (tokenBudget !== null && input.parent !== undefined) {
    const remaining =
      (input.parent.tokenBudget ?? Number.POSITIVE_INFINITY) -
      input.parent.tokensUsed -
      input.parent.openChildBudgets -
      (input.parent.closedChildTokensUsed ?? 0);
    if (tokenBudget > remaining) {
      refusals.push({
        code: 'budget_exceeds_parent',
        message:
          `A budget of ${String(tokenBudget)} tokens exceeds the parent's remaining ` +
          `${String(Math.max(0, remaining))} (budget − used − open children's budgets − what ` +
          'its closed children spent).',
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

  // --- §2.3's pre-grants: an answer to a gate a seat of *this* assignment
  // would raise, and nothing else (WO4 §2).
  //
  // The only rule worth having, and it is a real one: a pre-grant naming an
  // agent with no seat is either a client bug or an attempt to pre-answer
  // somebody else's card, and both must be a named refusal rather than a row
  // nothing will ever read. The tool name is deliberately **not** checked
  // against a catalogue — orchestrator does not own the tool vocabulary
  // (roster does, and MCP servers extend it per agent), and a pre-grant on a
  // tool the session never exposes pre-answers nothing, which is harmless.
  {
    const seated = new Set(request.members.map((member) => member.agentId));
    for (const grant of request.preGrants ?? []) {
      if (!seated.has(grant.agentId)) {
        refusals.push({
          code: 'pre_grant_not_a_member',
          message:
            `A pre-grant names agent ${grant.agentId}, who holds no seat in this assignment. ` +
            'A pre-grant is scoped to (assignment, agent, tool) and cannot answer a gate no ' +
            'seat here will raise.',
          details: { agentId: grant.agentId, tool: grant.tool },
        });
        continue;
      }
      // Duplicates are collapsed rather than refused: two clicks on one chip and
      // two clients ticking the same box are the same intent, exactly as
      // roster's `allowRule` treats a repeated rule as a no-op success (§6.2).
      // The service collapses them on the way to the column.
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
