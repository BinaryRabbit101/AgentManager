/**
 * Permission composition (roster DESIGN.md §6.2) — the heart of the element.
 *
 * `compilePermissions(baseline, projectOverride, assignmentScope, policy)` is a
 * pure function and **the only composer in the system**: projects and
 * orchestrator store and hand over raw rule inputs and neither computes an
 * effective set of its own, "because two implementations of this table would
 * disagree, and the disagreement would be a permission bug" (§6.2).
 *
 * The four rules, restated because everything below is an implementation of
 * them and nothing else:
 *
 * | `deny` | **Union.** Any layer can forbid. Nothing can un-forbid. |
 * | `ask`  | **Union.** Any layer can require a human gate. |
 * | `allow`| **Intersection.** A project can only remove auto-approvals. |
 * | `mode` | **Minimum** on `plan < dontAsk < default < acceptEdits`. |
 *
 * Two things this file is careful about, both from §6.1:
 *
 * - **restriction is expressed with `deny`, never by omission from `allow`.**
 *   `allowedTools` is an auto-approve list; a tool missing from it still exists.
 *   So the compiler always emits an explicit deny set, and the residue — a call
 *   that matched no rule — is handled by the default-deny {@link CanUseToolPolicy}
 *   this module also computes. The callback itself is installed by the runner
 *   (runner DESIGN §5.1); roster never sets `options.canUseTool`.
 * - **`bypassPermissions` (and, per SDK-NOTES D1, `auto`) must be unreachable.**
 *   M1's schema makes them unrepresentable in a roster definition, but a project
 *   override arrives from SQLite as a bare string (projects `types.ts`:
 *   "`mode` is left as a string rather than re-declaring roster's ladder"), so
 *   {@link readMode} re-checks it here and drops anything off the ladder with a
 *   diagnostic. That is why {@link RawPermissionSet} takes `mode?: string`
 *   rather than `PermissionMode`: the type that crosses a storage boundary is
 *   the type this module has to defend against.
 */
import type { Diagnostic, EffectivePermissions, PermissionElevation } from './contracts.js';
import type { PermissionMode } from './schema.js';
import { PERMISSION_MODES, permissionModeRank } from './schema.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A layer of rules as it arrives from storage.
 *
 * Structurally satisfied by roster's own `PermissionSet` (schema.ts) and by
 * projects' `PermissionOverride` (projects/types.ts) alike — deliberately, so
 * neither element has to convert before handing rules over. Every field is
 * optional because a layer that says nothing means "change nothing".
 */
export interface RawPermissionSet {
  readonly mode?: string | undefined;
  readonly allow?: readonly string[] | undefined;
  readonly deny?: readonly string[] | undefined;
  readonly ask?: readonly string[] | undefined;
}

/** The §6.2 escape hatch as projects stores it: an allow set plus a reason. */
export interface RawPermissionElevation {
  readonly allow: readonly string[];
  readonly reason: string;
}

/** The project layer: an override, plus the one widening path (§6.2). */
export interface ProjectPermissionLayer {
  readonly permissions?: RawPermissionSet | undefined;
  readonly elevation?: RawPermissionElevation | undefined;
}

/**
 * The assignment layer (§13's `AssignmentContext`, orchestrator's shape).
 *
 * `write` is separate from `scopeRules` on purpose: orchestrator "states one
 * flag and enumerates nothing" (§6.2, orchestrator §2.5), and a declared
 * `scopeRules.deny` is additive on top of the floor `write: false` imposes,
 * never a substitute for it.
 */
export interface AssignmentPermissionLayer {
  readonly write: boolean;
  readonly scopeRules?: RawPermissionSet | undefined;
}

/** Foundation's `policy` namespace (foundation §2.3), the two fields §6.2 uses. */
export interface PermissionPolicy {
  readonly allowPermissionElevation: boolean;
  readonly globalDeny: readonly string[];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** What a tool call can do, decided by tool *name* — see {@link outcomeForTool}. */
export type ToolCallOutcome = 'auto-allow' | 'ask-human' | 'deny';

/**
 * The default-deny policy §6.1 requires, as data the runner's `canUseTool`
 * implements.
 *
 * Roster does not set `options.canUseTool`: auto-approved calls never reach the
 * callback, so everything that *does* reach it is outside the effective allow
 * set by construction. The only correct policy there is deny — "anything not
 * covered by the effective allow set is denied unless a human answers (the last
 * line of defence)".
 */
export interface CanUseToolPolicy {
  /** Always `'deny'`. Present as a field so the runner reads a policy rather
   *  than re-deriving one, and so a test can assert it. */
  readonly default: 'deny';
  /**
   * Whether the callback may put the question to a human at all.
   *
   * False under `plan` and `dontAsk`: on the pinned SDK those modes take the
   * deny short-circuit and never raise a `can_use_tool` request (SDK-NOTES
   * §1.2), so a runner that waited for an answer would wait forever.
   */
  readonly humanMayApprove: boolean;
  /** The effective `ask` rules, which must reach the human gate rather than
   *  being denied outright (§6.3). */
  readonly ask: readonly string[];
  /** The message a denial carries, so every denial reads the same way. */
  readonly denyMessage: string;
}

/**
 * `compilePermissions`'s result.
 *
 * DESIGN §6.2 writes the signature as `→ EffectivePermissions`; diagnostics and
 * the `canUseTool` policy ride alongside because §6.2 also requires a dropped
 * elevation to produce a diagnostic and §6.1 requires the default-deny policy to
 * be *specified* by the compiler. `effective` is exactly the contract shape
 * (contracts.ts) and nothing has been added to it.
 */
export interface CompiledPermissions {
  readonly effective: EffectivePermissions;
  readonly policy: CanUseToolPolicy;
  readonly diagnostics: readonly Diagnostic[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * What a layer that declares no `mode` composes to.
 *
 * The middle rung, and the SDK's own default: `plan` would make an agent that
 * simply forgot the field unable to work, and `acceptEdits` would make silence
 * mean "auto-approve edits", which is the wrong direction for a default.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

/** `Edit`, `Write`, `NotebookEdit` — bare names, so the deny removes the tool
 *  definition outright rather than only blocking matching calls (§6.1). */
export const MUTATING_TOOL_NAMES: readonly string[] = ['Edit', 'Write', 'NotebookEdit'];

/**
 * The `write: false` floor of §6.2, unioned into the assignment layer before
 * anything else in that layer.
 *
 * The bare names remove the three file-mutating tools; the scoped `Bash` rules
 * keep `Bash` (a read-only shell is legitimate on a read-only assignment) and
 * deny the mutating forms in every mode. The two redirection rules are the
 * "shell-redirection forms" §6.2 names — without them `Bash(echo x > file)` is
 * a write that no `Edit` deny touches.
 *
 * This is the single definition of the catalogue: §6.2 says the baseline uses
 * the same one, so a future baseline template must import it rather than retype
 * it.
 */
export const MUTATING_TOOL_DENY_RULES: readonly string[] = [
  ...MUTATING_TOOL_NAMES,
  'Bash(rm *)',
  'Bash(mv *)',
  'Bash(cp *)',
  'Bash(git commit*)',
  'Bash(git push*)',
  'Bash(* > *)',
  'Bash(* >> *)',
];

/** The one denial message, so every default-deny reads identically in a
 *  transcript and the UI can group on it. */
export const DEFAULT_DENY_MESSAGE =
  'Denied by AgentManager: this call is not in the effective allow set for this session ' +
  '(roster DESIGN §6.1 default-deny).';

// ---------------------------------------------------------------------------
// Rule algebra
// ---------------------------------------------------------------------------

/** The tool a rule is about: `Bash(rm *)` → `Bash`, `WebFetch` → `WebFetch`. */
export function ruleTool(rule: string): string {
  const open = rule.indexOf('(');
  return open === -1 ? rule : rule.slice(0, open);
}

/** True for `Tool(pattern)`; false for a bare tool name. */
export function isScopedRule(rule: string): boolean {
  return rule.includes('(');
}

/**
 * Whether `candidate` grants at least as much as `rule` does.
 *
 * Two cases only, and deliberately no third: an identical rule, and a bare tool
 * name against any scoped rule on that tool. Glob subsumption
 * (`Edit(./a/**)` ⊇ `Edit(./a/b/**)`) is **not** attempted — the rule grammar
 * is the SDK's, a wrong containment judgement here would silently widen an
 * intersection, and the safe direction when two scoped rules cannot be compared
 * is to drop both, which is what the caller does.
 */
function covers(candidate: string, rule: string): boolean {
  if (candidate === rule) return true;
  return !isScopedRule(candidate) && ruleTool(rule) === candidate;
}

/** First occurrence wins; the result is sorted by the caller. */
function dedupe(rules: Iterable<string>): string[] {
  return [...new Set(rules)];
}

/** Locale-independent, so a table test's expectation is stable everywhere. */
function sorted(rules: readonly string[]): string[] {
  return [...rules].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * `allow` ∩ `incoming`, under {@link covers}.
 *
 * A rule survives only if the other layer grants at least as much, and when the
 * two layers state the same tool at different breadths the **narrower** one
 * survives — which is what makes an assignment's `Edit(./services/billing/**)`
 * narrow a baseline `Edit` instead of being discarded by it (§6.2's path-scope
 * narrowing). Rules in `current` that `incoming` does not mention are dropped:
 * a layer that declares an allow list is making an exhaustive statement about
 * what may be auto-approved, and intersection is what §6.2 says that is.
 *
 * `widened` collects the incoming rules that survived nothing — an attempt to
 * grant something no earlier layer granted. They are dropped, and the caller
 * turns them into a diagnostic, because "a project can only remove
 * auto-approvals, never add them" is more useful when the UI can say so.
 */
function intersectAllow(
  current: readonly string[],
  incoming: readonly string[],
): { kept: string[]; widened: string[] } {
  const kept: string[] = [];
  const widened: string[] = [];
  for (const rule of incoming) {
    if (current.some((existing) => covers(existing, rule))) {
      kept.push(rule);
      continue;
    }
    const narrower = current.filter((existing) => covers(rule, existing));
    if (narrower.length > 0) {
      kept.push(...narrower);
      continue;
    }
    widened.push(rule);
  }
  return { kept: dedupe(kept), widened };
}

/**
 * Allow rules the deny set has already killed.
 *
 * Deny wins over allow in every mode (§6.1), so an allow rule that is denied
 * verbatim, or whose tool is denied by bare name (which removes the tool
 * definition entirely), is dead. Removing it is not a permission decision — it
 * is the audit record refusing to claim a grant that is not in force.
 */
function stripDeniedAllows(allow: readonly string[], deny: readonly string[]): string[] {
  const exact = new Set(deny);
  const bare = new Set(deny.filter((rule) => !isScopedRule(rule)));
  return allow.filter((rule) => !exact.has(rule) && !bare.has(ruleTool(rule)));
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * A declared mode, or `undefined` plus a diagnostic when it is off the ladder.
 *
 * The layer that matters is the project override, which projects stores as a
 * bare string. Dropping an unknown value rather than failing keeps a hand-edited
 * row from making a project unlaunchable, and dropping it *upward* is not
 * possible: an unusable value simply does not participate in the minimum, so the
 * composed mode can only stay where the other layers put it.
 */
function readMode(
  value: string | undefined,
  path: string,
  diagnostics: Diagnostic[],
): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (isPermissionMode(value)) return value;
  diagnostics.push({
    level: 'warn',
    code: 'roster.permissions.unknown-mode',
    message:
      `permission mode "${value}" is not on the ladder ` +
      `${PERMISSION_MODES.join(' < ')} and was ignored` +
      (value === 'bypassPermissions' || value === 'auto'
        ? ' — it is not selectable from roster at all (DESIGN §6.1, SDK-NOTES D1)'
        : ' (DESIGN §6.2)'),
    path,
  });
  return undefined;
}

/** The less permissive of the two; `undefined` on either side is "no opinion". */
function leastPermissive(a: PermissionMode, b: PermissionMode | undefined): PermissionMode {
  if (b === undefined) return a;
  return permissionModeRank(b) < permissionModeRank(a) ? b : a;
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

/**
 * Compose the three layers plus foundation policy into one effective set.
 *
 * Order matters and is §6.2's: `policy.globalDeny` is unioned into `deny`
 * "before anything else and no layer can remove it"; the `write: false` floor
 * enters the assignment layer before that layer's own rules; the elevation is
 * applied after the project's own narrowing (it is the project's escape hatch)
 * and before the assignment's, so an assignment still narrows an elevated set.
 */
export function compilePermissions(
  baseline: RawPermissionSet | undefined,
  projectOverride: ProjectPermissionLayer | undefined,
  assignmentScope: AssignmentPermissionLayer | undefined,
  policy: PermissionPolicy,
): CompiledPermissions {
  const diagnostics: Diagnostic[] = [];

  // --- mode: minimum on the ladder ---------------------------------------
  let mode = readMode(baseline?.mode, 'permissions.mode', diagnostics) ?? DEFAULT_PERMISSION_MODE;
  mode = leastPermissive(
    mode,
    readMode(projectOverride?.permissions?.mode, 'project.permissionOverride.mode', diagnostics),
  );
  mode = leastPermissive(
    mode,
    readMode(assignmentScope?.scopeRules?.mode, 'assignment.scopeRules.mode', diagnostics),
  );

  // --- deny: union, globalDeny first --------------------------------------
  const deny = new Set<string>(policy.globalDeny);
  for (const rule of baseline?.deny ?? []) deny.add(rule);
  for (const rule of projectOverride?.permissions?.deny ?? []) deny.add(rule);
  if (assignmentScope !== undefined && !assignmentScope.write) {
    for (const rule of MUTATING_TOOL_DENY_RULES) deny.add(rule);
  }
  for (const rule of assignmentScope?.scopeRules?.deny ?? []) deny.add(rule);

  // --- ask: union ----------------------------------------------------------
  const ask = new Set<string>(baseline?.ask ?? []);
  for (const rule of projectOverride?.permissions?.ask ?? []) ask.add(rule);
  for (const rule of assignmentScope?.scopeRules?.ask ?? []) ask.add(rule);

  // --- allow: intersection, with the one widening path ---------------------
  let allow = dedupe(baseline?.allow ?? []);

  const projectAllow = projectOverride?.permissions?.allow;
  if (projectAllow !== undefined) {
    const { kept, widened } = intersectAllow(allow, projectAllow);
    allow = kept;
    if (widened.length > 0) {
      diagnostics.push({
        level: 'info',
        code: 'roster.permissions.widening-ignored',
        message:
          `the project's permission override tried to allow ${widened.map((r) => `"${r}"`).join(', ')}, ` +
          'which the roster baseline does not grant; allow is an intersection, so it was ignored ' +
          '(DESIGN §6.2 — use permissionElevation, which requires a reason)',
        path: 'project.permissionOverride.allow',
      });
    }
  }

  const elevation = projectOverride?.elevation;
  let appliedElevation: PermissionElevation | null = null;
  if (elevation !== undefined && elevation.allow.length > 0) {
    if (policy.allowPermissionElevation) {
      allow = dedupe([...allow, ...elevation.allow]);
      appliedElevation = { allow: [...elevation.allow], reason: elevation.reason };
      diagnostics.push({
        level: 'info',
        code: 'roster.permissions.elevation-applied',
        message:
          `permission elevation applied: ${elevation.allow.map((r) => `"${r}"`).join(', ')} — ` +
          `reason: ${elevation.reason}`,
        path: 'project.elevation',
      });
    } else {
      diagnostics.push({
        level: 'warn',
        code: 'roster.permissions.elevation-dropped',
        message:
          `permission elevation was dropped: policy.allowPermissionElevation is false, so the ` +
          `project's request to allow ${elevation.allow.map((r) => `"${r}"`).join(', ')} ` +
          `(reason: ${elevation.reason}) was not applied (DESIGN §6.2)`,
        path: 'project.elevation',
      });
    }
  }

  const assignmentAllow = assignmentScope?.scopeRules?.allow;
  if (assignmentAllow !== undefined) {
    const { kept, widened } = intersectAllow(allow, assignmentAllow);
    allow = kept;
    if (widened.length > 0) {
      diagnostics.push({
        level: 'info',
        code: 'roster.permissions.widening-ignored',
        message:
          `the assignment scope tried to allow ${widened.map((r) => `"${r}"`).join(', ')}, which no ` +
          'earlier layer grants; assignment scope can only narrow (DESIGN §6.2)',
        path: 'assignment.scopeRules.allow',
      });
    }
  }

  // --- deny wins: an allow rule the deny set killed is not a grant ---------
  const denyList = [...deny];
  const survivingAllow = stripDeniedAllows(allow, denyList);
  if (survivingAllow.length !== allow.length) {
    const killed = allow.filter((rule) => !survivingAllow.includes(rule));
    diagnostics.push({
      level: 'info',
      code: 'roster.permissions.allow-overridden-by-deny',
      message:
        `${killed.map((r) => `"${r}"`).join(', ')} ${killed.length === 1 ? 'was' : 'were'} allowed by ` +
        'a layer but denied by another; deny wins in every mode, so the auto-approval is not in force ' +
        '(DESIGN §6.1)',
    });
  }

  const effective: EffectivePermissions = {
    mode,
    allow: sorted(survivingAllow),
    deny: sorted(denyList),
    ask: sorted([...ask]),
    elevation: appliedElevation,
  };

  return {
    effective,
    policy: {
      default: 'deny',
      humanMayApprove: mode === 'default' || mode === 'acceptEdits',
      ask: effective.ask,
      denyMessage: DEFAULT_DENY_MESSAGE,
    },
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Reading the result
// ---------------------------------------------------------------------------

/** True when the deny set removes the tool's *definition* — a bare-name deny,
 *  which "removes the tool definition entirely" (§6.1). */
export function removesToolDefinition(
  effective: Pick<EffectivePermissions, 'deny'>,
  tool: string,
): boolean {
  return effective.deny.includes(tool);
}

/**
 * What happens to a call on `tool`, decided by tool *name* only — which is all
 * a rule set can decide before the call's arguments exist.
 *
 * This is the assertion §6.1's "restriction is expressed with deny, never by
 * omission" has to survive: a tool that appears in neither list is **never**
 * `auto-allow`. It either reaches the human gate (modes `default` /
 * `acceptEdits`) or is denied outright (`plan` / `dontAsk`, which never raise a
 * permission prompt — SDK-NOTES §1.2).
 *
 * A tool whose only grants are scoped is likewise never `auto-allow` by name:
 * matching calls are auto-approved by the engine and never reach the callback,
 * and everything else lands on the default-deny policy. That is what makes an
 * assignment's path scope enforced rather than advisory (§6.2).
 */
export function outcomeForTool(compiled: CompiledPermissions, tool: string): ToolCallOutcome {
  if (removesToolDefinition(compiled.effective, tool)) return 'deny';
  if (compiled.effective.ask.includes(tool)) return 'ask-human';
  if (compiled.effective.allow.includes(tool)) return 'auto-allow';
  return compiled.policy.humanMayApprove ? 'ask-human' : 'deny';
}
