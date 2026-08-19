/**
 * Which tools would stop and ask a human — DESIGN §6.3, §9.1 (WO4 §1).
 *
 * `validate` already answers "what rules apply". What the Start-work dialog
 * needs before it starts anything is the *consequence* of those rules: which
 * tools will raise a card mid-run, so the user can pre-answer them in the one
 * second they are already spending in the dialog rather than in N trips to the
 * machine while a pair sits paused.
 *
 * The whole computation is {@link outcomeForTool} run over a catalogue. It is
 * not a second composer — `compilePermissions` stays the only one (§6.2), and
 * this file reads its output exactly as the runner's policy does.
 *
 * ## Why a catalogue, and why this one
 *
 * There is no tool registry in the system: `allowedTools` is an auto-approve
 * list, not an inventory (§6.1), so nothing anywhere enumerates the tools a
 * session will expose. A preflight therefore has to name the tools it asks
 * about, and naming them is a decision rather than a lookup:
 *
 * - **`Bash` first, always.** It is the gate the observed 2026-08-19 pair run
 *   answered twice, and the one an agent reaches for on any real project.
 * - Then the three file-mutating tools, because a read-only assignment removes
 *   them outright and a write-capable one gates them — the difference the user
 *   most wants to see before starting.
 * - Then the read/search/fetch tools, which gate on a cautious baseline and are
 *   exactly the "wearing" cards the addendum complains about.
 *
 * MCP tools are deliberately **absent**: their names come from the toolset
 * handle, they differ per agent and per integration, and a chip list that grew
 * with every connector would stop being a glance. An MCP gate that fires
 * mid-run stays a question card, which is WO4 §4's unchanged case.
 */
import { outcomeForTool, type CompiledPermissions } from './permissions.js';
import { ruleTool } from './sdkRules.js';

/**
 * The tools a preflight asks about, in the order the UI renders them.
 *
 * Order is part of the contract: the caller does not sort, so "Bash first among
 * them" (WO4 §1) is true of the array itself rather than of a comparator
 * somebody has to remember to write.
 */
export const PREFLIGHT_TOOL_CATALOGUE: readonly string[] = [
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
];

/** One chip in the Start-work dialog's per-agent preflight row. */
export interface GateLiableTool {
  readonly tool: string;
  /**
   * Why this tool would gate.
   *
   * `ask_rule` is an explicit `ask` from some layer — a deliberate "always check
   * with me". `not_auto_allowed` is the default-deny policy's escalation: no
   * bare-name allow covers the tool, so every call that is not caught by a
   * scoped rule reaches the human. The distinction matters to the user because
   * an `ask` rule is somebody's stated intent and the other is simply the
   * absence of a grant.
   */
  readonly reason: 'ask_rule' | 'not_auto_allowed';
  /**
   * True when the effective allow set already carries a rule *about* this tool.
   *
   * This is the closest honest reading of "the same agent was previously
   * allowed on this project" (WO4 §1). The Always-allow memory is stored as
   * ordinary rules in the agent's own `permissions.allow` (§6.2) — there is no
   * per-project rule store and no marker separating a rule remembered from a
   * card from one typed in the editor. But `effective.allow` here is the set
   * *after* the project layer has intersected, so a rule that survives is a
   * grant that applies to this agent on this project; and because a bare-name
   * allow would have made the tool `auto-allow` rather than gate-liable, a
   * `remembered` chip can only have come from a scoped rule — which is exactly
   * the shape `durableAllowRule` writes (runner §5.1).
   */
  readonly remembered: boolean;
}

/**
 * The gate-liable subset of {@link PREFLIGHT_TOOL_CATALOGUE}, in catalogue
 * order.
 *
 * `auto-allow` tools are omitted because they never stop; `deny` tools are
 * omitted because pre-allowing one is not a thing a pre-grant can do — a
 * pre-grant pre-answers a gate the compiled permissions *would have raised*, it
 * never adds capability (WO4 §2), and a tool the deny set removed raises no
 * gate to answer.
 */
export function gateLiableTools(compiled: CompiledPermissions): readonly GateLiableTool[] {
  const scopedAllows = new Set(compiled.effective.allow.map((rule) => ruleTool(rule)));

  const liable: GateLiableTool[] = [];
  for (const tool of PREFLIGHT_TOOL_CATALOGUE) {
    if (outcomeForTool(compiled, tool) !== 'ask-human') continue;
    liable.push({
      tool,
      reason: compiled.effective.ask.includes(tool) ? 'ask_rule' : 'not_auto_allowed',
      remembered: scopedAllows.has(tool),
    });
  }
  return liable;
}
