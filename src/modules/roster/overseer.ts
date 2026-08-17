/**
 * What makes an agent overseer-capable (roster DESIGN §11, IMPLEMENTATION M7).
 *
 * §11 in one line: **`capabilities.overseer` grants the orchestration toolset
 * and never the SDK's own subagent tool.** Under D4 the app orchestrates —
 * AgentManager routes work between agents; agents do not spawn hidden
 * sub-hierarchies — so the flag buys a coordinator's *surface*, not an admin's
 * powers.
 *
 * Four decisions are taken here and nowhere else:
 *
 * 1. **The `mcp__agentmanager__*` namespace is compiler-owned.** A definition
 *    may write rules in it (M1's `overseer` fixture does, as
 *    `mcp__agentmanager__*`), but they are stripped before composition finishes
 *    and replaced by the grant the agent's capability earns. Any other reading
 *    breaks §11's own acceptance: a worker whose baseline happened to carry the
 *    wildcard would silently hold `list_roster` and `create_assignment`, which
 *    are "the coordinator's act" and nobody else's. Stripping is not a
 *    permission *widening* — every granted rule still passes through
 *    {@link grantTool}, so a `deny` on any of these tool names wins, as it does
 *    in every mode (§6.1).
 * 2. **Six for an overseer, four for a worker** (§11's table, orchestrator R1b).
 *    The four — `send_to_agent`, `read_mailbox`, `report_status`,
 *    `request_user_decision` — "create no work, reveal no roster, and reach
 *    outside no assignment". `list_roster` and `create_assignment` are the two
 *    that do, and they are the overseer's.
 * 3. **The subagent tool is denied by name, not omitted.** §6.1: restriction is
 *    expressed with `deny`, never by omission from `allow`, because a tool
 *    missing from the auto-approve list still exists and can still be called.
 *    Both the current name (`Agent`) and the legacy one (`Task`) are denied, on
 *    every launch, overseer or not — D4 is an architecture decision about the
 *    whole product, not a per-agent setting.
 * 4. **The roster an overseer can read carries no credentials.** §11: "It cannot
 *    delegate to people it cannot see. It has no business knowing their
 *    credentials." {@link projectRosterForOverseer} is therefore a projection
 *    with no `permissions` and no `integrations` key at all — not empty ones.
 *
 * The in-process MCP server itself is orchestrator's (`createSdkMcpServer`);
 * roster declares *who may be handed it* and compiles the matching allow rules.
 * The mount lives in `compileSession.ts` (§13, orchestrator R1).
 */
import type { Diagnostic } from './contracts.js';
import { grantTool, sortRules, type CompiledPermissions } from './permissions.js';
import { ruleTool } from './sdkRules.js';
import type { AgentDefinition, Role, Specialty } from './schema.js';

// ---------------------------------------------------------------------------
// The orchestration toolset (§11, §13)
// ---------------------------------------------------------------------------

/**
 * The record key the toolset is mounted under, and the middle segment of every
 * rule below.
 *
 * The same string as orchestrator's `TOOLSET_SERVER_KEY`, restated rather than
 * imported: feature modules never import each other (foundation §6.1), and
 * `agentmanager` is already a reserved agent id (`ids.ts`) precisely so nothing
 * in the library can collide with it. A test asserts the two agree.
 */
export const ORCHESTRATION_SERVER = 'agentmanager';

/** The prefix every orchestration rule starts with (`mcp__<server>__`, §10). */
export const ORCHESTRATION_TOOL_PREFIX = `mcp__${ORCHESTRATION_SERVER}__`;

/** §11's table, overseer column: the D4 orchestration surface, entire. */
export const OVERSEER_TOOL_NAMES = [
  'list_roster',
  'create_assignment',
  'send_to_agent',
  'read_mailbox',
  'report_status',
  'request_user_decision',
] as const;

/** §11's table, worker column (orchestrator R1b): four, not two. */
export const WORKER_TOOL_NAMES = [
  'send_to_agent',
  'read_mailbox',
  'report_status',
  'request_user_decision',
] as const;

/** The two an overseer has that a worker does not — stated as its own list so
 *  the "both directions" assertion has something to name. */
export const OVERSEER_ONLY_TOOL_NAMES = OVERSEER_TOOL_NAMES.filter(
  (name) => !(WORKER_TOOL_NAMES as readonly string[]).includes(name),
);

/**
 * The SDK's subagent tool, current and legacy names.
 *
 * `Task` was the name before it became `Agent`; a deny that named only one of
 * them would be a deny that a version bump silently turned off.
 */
export const SUBAGENT_TOOL_NAMES: readonly string[] = ['Agent', 'Task'];

/** `mcp__agentmanager__report_status` — the rule form for one tool name. */
export function orchestrationRule(toolName: string): string {
  return `${ORCHESTRATION_TOOL_PREFIX}${toolName}`;
}

/**
 * Whether a rule reaches into the orchestration namespace at all.
 *
 * Deliberately generous: the bare `mcp__agentmanager__*` wildcard, an exact
 * tool rule, and a scoped `mcp__agentmanager__send_to_agent(...)` all count,
 * because all three are statements about tools this module owns.
 */
export function isOrchestrationRule(rule: string): boolean {
  return ruleTool(rule).startsWith(ORCHESTRATION_TOOL_PREFIX);
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/** §11's switch. The schema already guarantees `roles` contains `overseer`
 *  whenever this is true, so nothing here re-checks it. */
export function isOverseer(definition: Pick<AgentDefinition, 'capabilities'>): boolean {
  return definition.capabilities?.overseer === true;
}

/** The tool names this agent's capability earns (§11's table). */
export function orchestrationToolNames(overseer: boolean): readonly string[] {
  return overseer ? OVERSEER_TOOL_NAMES : WORKER_TOOL_NAMES;
}

// ---------------------------------------------------------------------------
// Defaults and the model floor (§11)
// ---------------------------------------------------------------------------

/**
 * §11: "A higher default `maxTurns` and `maxBudgetUsd` — coordination is
 * turn-expensive and produces little output per turn."
 *
 * The numbers are M1's `overseer` fixture's own (`iris-overseer` states 200 and
 * 10), so an overseer that declares nothing lands where the shipped example
 * declares itself rather than somewhere new. A definition's own `defaults`
 * still win: this is what "when unset" means.
 */
export const OVERSEER_DEFAULT_MAX_TURNS = 200;
export const OVERSEER_DEFAULT_MAX_BUDGET_USD = 10;

/** §11's floor: the validator warns below `sonnet`. */
export const OVERSEER_MODEL_FLOOR = 'sonnet';

/**
 * Where a model sits relative to the floor: `-1` below, `0` at it, `1` above,
 * `undefined` for anything this build cannot place.
 *
 * Unplaceable is not "below": §8 is warn-not-block precisely so a model
 * released after this build ships does not make an agent unloadable, and
 * warning about an unknown name would be inventing a judgement.
 */
export function modelTierRelativeToFloor(model: string): -1 | 0 | 1 | undefined {
  const lower = model.toLowerCase();
  if (lower.includes('haiku')) return -1;
  if (lower.includes('sonnet')) return 0;
  if (lower.includes('opus') || lower === 'best') return 1;
  return undefined;
}

/**
 * §11's model floor as a diagnostic, or `undefined` when there is nothing to
 * say.
 *
 * A warning, never a refusal: "decomposition and convergence judgement are the
 * tasks least tolerant of a weak model" is a statement about quality, and
 * roster does not get to decide that an owner may not try it anyway.
 */
export function overseerModelDiagnostic(
  agentId: string,
  model: string | undefined,
): Diagnostic | undefined {
  if (model === undefined) return undefined;
  if (modelTierRelativeToFloor(model) !== -1) return undefined;
  return {
    level: 'warn',
    code: 'roster.overseer.model-below-floor',
    message:
      `this overseer runs on "${model}", which is below the ${OVERSEER_MODEL_FLOOR} floor §11 ` +
      'recommends: decomposition and convergence judgement are the tasks least tolerant of a ' +
      'weak model. The launch proceeds — this is a warning, not a refusal.',
    agentId,
    path: 'model.primary',
  };
}

// ---------------------------------------------------------------------------
// The grant (§11, §13/R1)
// ---------------------------------------------------------------------------

export interface OrchestrationGrantInput {
  readonly agentId: string;
  readonly overseer: boolean;
  /**
   * Whether the toolset is actually being mounted this launch.
   *
   * §11: when the orchestrator module is disabled "those tools do not exist:
   * the compiler emits a diagnostic and drops every `mcp__agentmanager__*` rule
   * rather than compiling allow rules for a server that will never be mounted".
   */
  readonly available: boolean;
  /** What the mounted instance says it exposes, when it says (§13: "orchestrator
   *  decides which of the six tools that instance actually exposes"). */
  readonly mountedToolNames?: readonly string[] | undefined;
}

export interface OrchestrationGrant {
  readonly compiled: CompiledPermissions;
  /** The rules actually in force after `deny` had its say. */
  readonly granted: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Replace whatever the layers declared in the orchestration namespace with the
 * grant this agent's capability earns.
 *
 * Order is: strip, then grant. Stripping first is what makes "exactly the four"
 * true for a worker whose baseline wrote the wildcard, and granting through
 * {@link grantTool} is what keeps `deny` winning over the grant.
 */
export function applyOrchestrationGrant(
  compiled: CompiledPermissions,
  input: OrchestrationGrantInput,
): OrchestrationGrant {
  const diagnostics: Diagnostic[] = [];
  const declared = compiled.effective.allow.filter(isOrchestrationRule);

  let next: CompiledPermissions = {
    ...compiled,
    effective: {
      ...compiled.effective,
      allow: compiled.effective.allow.filter((rule) => !isOrchestrationRule(rule)),
    },
  };

  if (!input.available) {
    if (declared.length > 0) {
      diagnostics.push({
        level: 'warn',
        code: 'roster.orchestration.unavailable',
        message:
          `the orchestration toolset is not mounted on this launch, so ` +
          `${declared.map((rule) => `"${rule}"`).join(', ')} ` +
          `${declared.length === 1 ? 'was' : 'were'} dropped rather than compiled as allow ` +
          'rules for a server that will never be there (DESIGN §11)',
        agentId: input.agentId,
        path: 'permissions.allow',
      });
    }
    return { compiled: next, granted: [], diagnostics };
  }

  const wanted = orchestrationToolNames(input.overseer).map(orchestrationRule);
  for (const rule of wanted) next = grantTool(next, rule);
  const granted = next.effective.allow.filter(isOrchestrationRule);

  const refused = wanted.filter((rule) => !granted.includes(rule));
  if (refused.length > 0) {
    diagnostics.push({
      level: 'warn',
      code: 'roster.orchestration.grant-denied',
      message:
        `${refused.map((rule) => `"${rule}"`).join(', ')} ${refused.length === 1 ? 'is' : 'are'} ` +
        'denied by a permission layer, so the grant §11 would make was refused; deny wins over ' +
        'allow in every mode (DESIGN §6.1)',
      agentId: input.agentId,
      path: 'permissions.deny',
    });
  }

  if (declared.length > 0) {
    diagnostics.push({
      level: 'info',
      code: 'roster.orchestration.rules-replaced',
      message:
        `the ${ORCHESTRATION_TOOL_PREFIX}* namespace is compiled from capabilities, not declared: ` +
        `${declared.map((rule) => `"${rule}"`).join(', ')} ` +
        `${declared.length === 1 ? 'was' : 'were'} replaced by this agent's ` +
        `${input.overseer ? 'overseer' : 'worker'} grant of ${String(granted.length)} tool(s) ` +
        '(DESIGN §11)',
      agentId: input.agentId,
      path: 'permissions.allow',
    });
  }

  const mounted = input.mountedToolNames;
  if (mounted !== undefined) {
    const missing = orchestrationToolNames(input.overseer).filter(
      (name) => !mounted.includes(name),
    );
    if (missing.length > 0) {
      diagnostics.push({
        level: 'info',
        code: 'roster.orchestration.tool-not-mounted',
        message:
          `this agent is granted ${missing.map((name) => `"${name}"`).join(', ')}, which the ` +
          'mounted agentmanager server does not expose in this build; the rule is harmless and ' +
          'the tool simply is not there (DESIGN §11, §13)',
        agentId: input.agentId,
        path: 'capabilities',
      });
    }
  }

  return {
    compiled: { ...next, effective: { ...next.effective, allow: sortRules(next.effective.allow) } },
    granted,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// The roster an overseer may read (§11)
// ---------------------------------------------------------------------------

/**
 * One agent as an overseer sees it.
 *
 * §11: "names, specialties, tags, capabilities — never permissions or
 * integrations". The absent fields are absent from the *type*, so a future edit
 * that adds one has to change this interface and trip the key-scan test rather
 * than quietly widening what a coordinating agent can read.
 */
export interface OverseerRosterEntry {
  readonly id: string;
  readonly name: string;
  readonly specialty: Specialty;
  readonly tagline: string | null;
  readonly tags: readonly string[];
  readonly capabilities: {
    readonly overseer: boolean;
    readonly roles: readonly Role[];
  };
}

/** Keys that must never appear anywhere in the projection (§11). */
export const OVERSEER_PROJECTION_FORBIDDEN_KEYS: readonly string[] = [
  'permissions',
  'integrations',
  'settingSources',
  'env',
  'headers',
  'secretRef',
];

/**
 * The read-only projection handed to an overseer.
 *
 * Built field by field from the definition rather than by deleting keys from a
 * copy: a deletion list is a thing that goes stale the next time the schema
 * grows a field, and the field it forgets would be the one that mattered.
 */
export function projectRosterForOverseer(
  definitions: readonly AgentDefinition[],
): readonly OverseerRosterEntry[] {
  return definitions.map((definition) => ({
    id: definition.id,
    name: definition.name,
    specialty: definition.specialty,
    tagline: definition.tagline ?? null,
    tags: [...(definition.tags ?? [])],
    capabilities: {
      overseer: definition.capabilities?.overseer ?? false,
      roles: [...(definition.capabilities?.roles ?? [])],
    },
  }));
}
