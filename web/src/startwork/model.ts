/**
 * The **Start work** flow, as data (DESIGN §6, §10.4; orchestrator §3.5, §16-9).
 *
 * Everything here is pure: which shapes of work a selection allows, who sits in
 * which seat, what the request body is for each shape, and the sentence the
 * overseer's goal carries. The React half (`StartWork.tsx`) owns the fields, the
 * focus trap and the network; this owns the decisions — so the decisions can be
 * asserted without a DOM, and so the two halves cannot disagree about what "two
 * agents, adversarial" means.
 *
 * ## The one rule that shapes every function below
 *
 * **Owner decision, 2026-08-18: capabilities rank, they never gate.** Nothing
 * here filters an agent out of a picker, refuses a seat, or disables a mode
 * because of `capabilities.roles`. Declared roles decide *ordering* and the
 * *suggestion* label; a mismatch costs one persona addendum and comes back as
 * the server's `role_not_declared` **warning**, which §10.4 says is rendered
 * advisory and never as a blocker.
 */

import type {
  AgentView,
  AssignmentView,
  IntegrationPreflight,
  IntegrationState,
  Project,
  SeatDefinition,
  TaskTemplateView,
} from '../api/types';
import { projectLaunchRefusal } from '../api/types';

/**
 * How the selected agents work together (§6).
 *
 * Driven by the *count*, which is the whole point of the rewrite: the user picks
 * people and a task, and the shape of the work is the last question rather than
 * the first. `independent` is available at every count above one because "two
 * agents on the same brief, separately" is a real thing to want and used to be
 * unreachable without opening the launch flow twice.
 */
export type Teamwork = 'solo' | 'pair' | 'independent' | 'team';

/** What a selection of this size may be shaped as, in the order it is offered. */
export function teamworkOptions(count: number): readonly Teamwork[] {
  if (count <= 1) return ['solo'];
  if (count === 2) return ['pair', 'independent'];
  return ['team', 'independent'];
}

/**
 * The shape a count defaults to, and the shape a stale choice falls back to.
 *
 * The user's choice survives while it is still offered — adding a third agent
 * to a pair the user chose leaves them on `team` rather than silently reverting
 * — so this takes the current choice and returns it when it is still valid.
 */
export function teamworkFor(count: number, chosen: Teamwork | null): Teamwork {
  const options = teamworkOptions(count);
  if (chosen !== null && options.includes(chosen)) return chosen;
  return options[0] ?? 'solo';
}

/** Which orchestrator pattern a shape posts, or `null` when it posts solos. */
export function patternFor(teamwork: Teamwork): 'pair' | 'overseer' | null {
  if (teamwork === 'pair') return 'pair';
  if (teamwork === 'team') return 'overseer';
  return null;
}

/** §6: "Role defaults to `implementer` where the agent declares it, else `capabilities.roles[0]`." */
export function defaultRole(agent: AgentView | undefined): string | undefined {
  const roles = agent?.definition.capabilities?.roles ?? [];
  if (roles.includes('implementer')) return 'implementer';
  return roles[0];
}

/** The roles an agent declares — the ranking key and the suggestion label. */
export function declaredRoles(agent: AgentView): readonly string[] {
  return agent.definition.capabilities?.roles ?? [];
}

/** Whether this agent declares any of `roles`. A hint on the row, never a gate. */
export function declaresAny(agent: AgentView, roles: readonly string[]): boolean {
  return declaredRoles(agent).some((role) => roles.includes(role));
}

/**
 * The agents the flow opens with selected (§6's pre-fill rules).
 *
 * The intent wins when it names anyone — a drag, a card menu, an agent→agent
 * drop. Only when it names nobody does the project's `defaults.agentIds` fill
 * in, and then **all** of them rather than `agentIds[0]`: the old flow could
 * seat exactly one agent, so it took the first and dropped the rest; this one
 * can seat every agent the project nominates, and dropping them would be a
 * narrowing the project did not ask for.
 */
export function preselectedAgentIds(
  intent: { readonly agentIds: readonly string[] },
  projectDefaults: readonly string[] | undefined,
): readonly string[] {
  if (intent.agentIds.length > 0) return intent.agentIds;
  return projectDefaults ?? [];
}

/** §5.3: a project that cannot be launched against is not offered as a target. */
export function launchableProjects(projects: readonly Project[]): readonly Project[] {
  return projects.filter((project) => projectLaunchRefusal(project) === undefined);
}

/** The rest, with the server's reason — shown, never hidden (§5.3, §13.5). */
export function refusedProjects(
  projects: readonly Project[],
): readonly { readonly project: Project; readonly refusal: string }[] {
  return projects.flatMap((project) => {
    const refusal = projectLaunchRefusal(project);
    return refusal === undefined ? [] : [{ project, refusal }];
  });
}

/**
 * How many open assignments each agent already holds (§10.4's row label).
 *
 * Counted from `GET /api/assignments?status=open`, which the app already reads
 * for home and the index, rather than from a second endpoint — and counted
 * rather than derived: this is arithmetic over the server's list, not a status
 * the UI is recomputing (§4).
 */
export function openAssignmentCounts(
  assignments: readonly AssignmentView[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const assignment of assignments) {
    for (const member of assignment.members) {
      counts.set(member.agentId, (counts.get(member.agentId) ?? 0) + 1);
    }
  }
  return counts;
}

/** The first role the agent declares that this seat allows — the server's rule. */
export function roleForSeat(
  seatRoles: readonly string[],
  agentRoles: readonly string[],
): string | undefined {
  return agentRoles.find((role) => seatRoles.includes(role)) ?? seatRoles[0];
}

/**
 * Which selected agent takes which seat, one per seat in seat order.
 *
 * A **stable ranking**, not a filter: for each seat in turn the first remaining
 * agent that declares one of the seat's roles takes it, and when none does, the
 * first remaining agent takes it anyway. So dropping an implementer onto a
 * skeptic seats them the way the pattern reads best, and seating two agents who
 * declare nothing still fills both seats rather than leaving one empty.
 *
 * The UI offers a swap over the result rather than a second ranking, because
 * "who drafts" is the user's call and a ranking that re-ran on every swap would
 * undo it.
 */
export function rankForSeats(
  seats: readonly SeatDefinition[],
  selected: readonly AgentView[],
): readonly AgentView[] {
  const remaining = [...selected];
  const seated: AgentView[] = [];
  for (const seat of seats) {
    if (remaining.length === 0) break;
    const index = remaining.findIndex((agent) => declaresAny(agent, seat.roles));
    const [taken] = remaining.splice(index === -1 ? 0 : index, 1);
    if (taken !== undefined) seated.push(taken);
  }
  return seated;
}

export interface SeatMember {
  readonly agentId: string;
  readonly role: string;
}

/** `members` for `POST /api/assignments`: seat order, one role each. */
export function seatMembers(
  seats: readonly SeatDefinition[],
  seated: readonly AgentView[],
): readonly SeatMember[] {
  return seats.flatMap((seat, index) => {
    const agent = seated[index];
    if (agent === undefined) return [];
    const role = roleForSeat(seat.roles, declaredRoles(agent));
    return role === undefined ? [] : [{ agentId: agent.definition.id, role }];
  });
}

/**
 * The line an overseer's goal carries about who else the user picked
 * (orchestrator §3.5).
 *
 * The workers of an `overseer` assignment are **not** seats of it — they hold
 * seats in the child assignments the lead mints — so there is no field on the
 * create call to put them in. The lead is mounted `list_roster` and
 * `create_assignment`, so the honest way to pass the user's preference is as
 * part of the brief: guidance the lead reads, not a contract the engine keeps.
 * The UI says so in as many words beside it ("the lead decides the final
 * split"), because a sentence in a prompt that reads like a guarantee is the
 * failure mode this comment exists to prevent.
 *
 * Ids ride beside the names because `create_assignment` takes agent ids.
 */
export function suggestedWorkersLine(
  workers: readonly { readonly id: string; readonly name: string }[],
): string {
  if (workers.length === 0) return '';
  const named = workers.map((worker) => `${worker.name} (${worker.id})`).join(', ');
  return (
    `Prefer seating these agents in child assignments: ${named}. ` +
    'You have list_roster and the final split is yours — this is the human’s preference, not a rule.'
  );
}

/** The goal as posted for a team: the brief, then the suggestion, as prose. */
export function goalWithWorkers(
  goal: string,
  workers: readonly { readonly id: string; readonly name: string }[],
): string {
  const line = suggestedWorkersLine(workers);
  if (line === '') return goal;
  return goal.trim() === '' ? line : `${goal.trim()}\n\n${line}`;
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export interface SoloRequest {
  readonly projectId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly role?: string;
  readonly write?: true;
  readonly workItemIds?: readonly string[];
  /** Gates pre-answered in the dialog (WO4 §2). Omitted when nothing was ticked. */
  readonly preGrants?: readonly PreGrant[];
  /** The task template this was started from (WO5) — provenance, not a setting. */
  readonly templateId?: string;
  readonly confirmRemoteAccess?: true;
}

/**
 * `POST /api/assignments/solo` (orchestrator §16.7), field for field.
 *
 * The same body the launch flow has always sent, built here so the solo path
 * and the independent path — which is N of these — cannot drift apart.
 */
export function soloRequest(input: {
  readonly projectId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly role: string | undefined;
  readonly write: boolean;
  readonly workItemIds: readonly string[];
  readonly preGrants: readonly PreGrant[];
  readonly templateId: string | null;
  readonly confirmRemoteAccess: boolean;
}): SoloRequest {
  return {
    projectId: input.projectId,
    agentId: input.agentId,
    prompt: input.prompt,
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.write ? { write: true as const } : {}),
    // §8.2: the created assignment carries them, and projects flips each linked
    // item to `in_progress` server-side — the UI never sets a status it does
    // not own (§4).
    ...(input.workItemIds.length === 0 ? {} : { workItemIds: input.workItemIds }),
    // Omitted rather than sent empty: a body that always carries the key would
    // make "nothing was pre-allowed" indistinguishable from "this client does
    // not do pre-grants" on the server side.
    ...(input.preGrants.length === 0 ? {} : { preGrants: input.preGrants }),
    // Omitted rather than sent null for the same reason: the blank card is the
    // default, and a body that always carried the key would make "started from
    // nothing" and "this client does not know about templates" the same request.
    ...(input.templateId === null ? {} : { templateId: input.templateId }),
    ...(input.confirmRemoteAccess ? { confirmRemoteAccess: true as const } : {}),
  };
}

export interface PatternRequest {
  readonly projectId: string;
  readonly pattern: 'pair' | 'overseer';
  readonly members: readonly SeatMember[];
  readonly goal?: string;
  readonly scope: { readonly paths: readonly string[]; readonly artifactPath?: string };
  readonly roundCap?: number;
  readonly tokenBudget?: number;
  readonly preGrants?: readonly PreGrant[];
  readonly templateId?: string;
  readonly autoStart: false;
  readonly confirmRemoteAccess?: true;
}

/** Comma-separated paths as the server wants them: trimmed, empties dropped. */
export function scopePathList(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path !== '');
}

/**
 * `POST /api/assignments` for a pattern, always `autoStart: false`.
 *
 * The parked create is what makes "surfaces every server `warning` **before**
 * the user confirms" honest (§10.4): the warnings are computed by the server
 * from the created row, so the only way to show them before a turn runs is to
 * create without starting and let an explicit **Start** advance it.
 */
export function patternRequest(input: {
  readonly projectId: string;
  readonly pattern: 'pair' | 'overseer';
  readonly members: readonly SeatMember[];
  readonly goal: string;
  readonly scopePaths: readonly string[];
  readonly artifactPath: string;
  readonly roundCap: string;
  readonly tokenBudget: string;
  readonly preGrants: readonly PreGrant[];
  readonly templateId: string | null;
  readonly confirmRemoteAccess: boolean;
}): PatternRequest {
  return {
    projectId: input.projectId,
    pattern: input.pattern,
    members: input.members,
    ...(input.goal === '' ? {} : { goal: input.goal }),
    scope: {
      paths: input.scopePaths,
      ...(input.artifactPath === '' ? {} : { artifactPath: input.artifactPath }),
    },
    ...(input.roundCap === '' ? {} : { roundCap: Number(input.roundCap) }),
    ...(input.tokenBudget === '' ? {} : { tokenBudget: Number(input.tokenBudget) }),
    ...(input.preGrants.length === 0 ? {} : { preGrants: input.preGrants }),
    ...(input.templateId === null ? {} : { templateId: input.templateId }),
    autoStart: false,
    ...(input.confirmRemoteAccess ? { confirmRemoteAccess: true as const } : {}),
  };
}

/**
 * Why the flow cannot start yet, or `undefined` when it can.
 *
 * The **only** client-side refusals in the whole dialog, and each is a field the
 * request has no honest value for rather than a judgement about the request:
 * §10.4's "refuses nothing client-side that the server would accept" still
 * holds. The overseer budget is the one addition, and it is the server's own
 * `requires.tokenBudget` with no default to fall back on (§7.2, §3.5) — a
 * missing number there is an unbounded tree of child assignments, so the form
 * collects it rather than posting a null the server would refuse.
 */
export function startBlocker(input: {
  readonly hasOrchestrator: boolean;
  readonly projectId: string | null;
  readonly agentCount: number;
  readonly task: string;
  readonly teamwork: Teamwork;
  readonly tokenBudget: string;
  readonly requiresTokenBudget: boolean;
}): string | undefined {
  if (!input.hasOrchestrator) return 'The orchestrator module is not running.';
  if (input.projectId === null || input.projectId === '') return 'Choose a project.';
  if (input.agentCount === 0) return 'Choose at least one agent.';
  if (input.task.trim() === '') return 'Describe the task.';
  if (input.teamwork === 'team' && input.agentCount < 2) return 'A team needs more than one agent.';
  if (input.requiresTokenBudget && input.tokenBudget.trim() === '') {
    return 'This pattern needs a token budget — it has no default.';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The preflight and the prerequisites (WO4 §1, §3)
// ---------------------------------------------------------------------------

/**
 * One gate the user pre-answered, exactly as orchestrator's create call takes it.
 *
 * Scoped to `(assignment, agent, tool)` server-side: the client sends the two
 * halves it knows, and the assignment supplies the third by being the row the
 * grant is stored on. It is deliberately **not** a permission rule — the chip
 * says "do not stop and ask about this tool", and roster stays the only thing
 * that decides what the tool may do when it runs.
 */
export interface PreGrant {
  readonly agentId: string;
  readonly tool: string;
}

/** The key the dialog holds a ticked chip under. Two fields, one string. */
export function preGrantKey(agentId: string, tool: string): string {
  return `${agentId}::${tool}`;
}

/**
 * The ticked chips as the create call's `preGrants`, in a stable order.
 *
 * Sorted rather than insertion-ordered, because the set is what matters and a
 * test asserting on a request body should not have to know which chip the user
 * happened to click first.
 */
export function preGrantList(ticked: ReadonlySet<string>): readonly PreGrant[] {
  return [...ticked].sort().flatMap((key) => {
    const split = key.indexOf('::');
    if (split <= 0) return [];
    return [{ agentId: key.slice(0, split), tool: key.slice(split + 2) }];
  });
}

/**
 * The slug half of §3's default artifact path: the goal's first words.
 *
 * Lowercased, non-alphanumerics collapsed to single hyphens, capped at five
 * words so a paragraph-long goal does not become a directory nobody can type.
 * An empty or symbol-only goal yields `assignment`, because the path has to be
 * *something*: `docs/assignments//DRAFT.md` is not an editable default, it is a
 * broken one.
 */
export function assignmentSlug(goal: string): string {
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '')
    .slice(0, 5);
  return words.length === 0 ? 'assignment' : words.join('-');
}

/**
 * §3's prefill: `docs/assignments/<slug>-<shortId>/DRAFT.md`.
 *
 * The short id is the caller's rather than this function's, so the value is
 * pure and a test can assert the whole string. It is there because two
 * assignments started from the same goal on the same project would otherwise
 * draft over each other's file — and the second one silently, since WO2's pair
 * guard only checks that *a* file is at the path, not that this run wrote it.
 *
 * Editable and never empty-blocking: the dialog seeds the field with this and
 * the user may replace it with anything, including a path in another tree.
 */
export function defaultArtifactPath(goal: string, shortId: string): string {
  const suffix = shortId === '' ? '' : `-${shortId}`;
  return `docs/assignments/${assignmentSlug(goal)}${suffix}/DRAFT.md`;
}

// ---------------------------------------------------------------------------
// Task templates (roster §2.4, WO5)
// ---------------------------------------------------------------------------

/**
 * The `{{slug}}` a template's paths are rendered against.
 *
 * The *same* string the untemplated default builds its directory from —
 * `<slug>-<shortId>` — so a template that writes `docs/assignments/{{slug}}/…`
 * lands beside a hand-filled run rather than in a parallel tree, and inherits
 * the short id's reason for existing: two runs of the same brief must not draft
 * over each other's file.
 */
export function templateSlug(goal: string, shortId: string): string {
  return shortId === '' ? assignmentSlug(goal) : `${assignmentSlug(goal)}-${shortId}`;
}

/**
 * `{{slug}}` and `{{source}}`, and nothing else — the browser half of roster's
 * `renderTemplateText`.
 *
 * Restated here rather than fetched per keystroke, and pinned by a test that
 * imports roster's own function: the same arrangement the integrations form uses
 * against `integrationsSchema` (roster §10), for the same reason — a rule stated
 * twice is a rule that drifts once, unless something asserts they agree.
 *
 * A placeholder outside the vocabulary survives verbatim, so an author's typo
 * shows up in the prefilled field as the typo it is.
 */
export function renderTemplateText(
  text: string,
  values: { readonly slug?: string; readonly source?: string },
): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (whole, name: string) => {
    if (name === 'slug') return values.slug ?? '';
    if (name === 'source') return values.source ?? '';
    return whole;
  });
}

/** True when the template renders §6's one extra input. */
export function usesSource(template: TaskTemplateView | undefined): boolean {
  return template?.variables.includes('source') ?? false;
}

/** Which teamwork shape a template's `pattern` asks the dialog to open on. */
export function teamworkForTemplate(pattern: 'solo' | 'pair'): Teamwork {
  return pattern === 'pair' ? 'pair' : 'solo';
}

/**
 * The connectors a template needs that this agent does not carry, as the server
 * already answered it.
 *
 * A lookup rather than a computation: `integrationGaps` arrives on the template
 * with one entry per live agent that falls short (roster §2.4), so ticking an
 * agent costs no request and the warning cannot disagree with the server about
 * what the agent declares.
 */
export function missingConnectors(
  template: TaskTemplateView | undefined,
  agentId: string,
): readonly string[] {
  return template?.integrationGaps.find((gap) => gap.agentId === agentId)?.missing ?? [];
}

/** Every seated agent that falls short, in selection order — the warning list. */
export function connectorWarnings(
  template: TaskTemplateView | undefined,
  agentIds: readonly string[],
): readonly { readonly agentId: string; readonly missing: readonly string[] }[] {
  return agentIds.flatMap((agentId) => {
    const missing = missingConnectors(template, agentId);
    return missing.length === 0 ? [] : [{ agentId, missing }];
  });
}

/**
 * A short tail for the artifact directory, distinct per opened dialog.
 *
 * Not a ULID: this is a directory name a human reads and types, and the
 * assignment's real id is 26 characters. Six base-36 characters is two billion
 * values, which is far more than the number of assignments that will ever share
 * one goal's first five words.
 */
export function shortAssignmentId(random: () => number = Math.random): string {
  return Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
}

// ---------------------------------------------------------------------------
// Connector preflight (§6's privilege step; roster §10, WO6 item 2)
// ---------------------------------------------------------------------------

/**
 * The chip a preflight row renders as, and the action beside it.
 *
 * **This is advice, never a blocker.** §10.4's rule — "refuses nothing
 * client-side that the server would accept" — applies with extra force here,
 * because a connector this build reports as `needs-auth` may well be authorised
 * already: the CLI owns the OAuth grant and roster only remembers what a session
 * reported (roster §10). Turning an unknown into a disabled **Start** would stop
 * work that would have run.
 *
 * The actions are the honest ones for what the SDK can do before a session
 * exists, which is *nothing*: there is no headless authorize call in the pinned
 * `@anthropic-ai/claude-agent-sdk` (see `src/modules/runner/mcpAuth.ts`), so the
 * OAuth action explains where the link appears rather than pretending to open
 * one. The two states that *can* be fixed from here — a missing secret and a
 * connector the agent does not have — get real links.
 */
export interface ConnectorChip {
  readonly key: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly integration: string;
  readonly state: IntegrationState;
  readonly label: string;
  readonly detail: string;
  /** Where the fix lives, when it is a place. */
  readonly action?: {
    readonly kind: 'editor' | 'secrets';
    readonly label: string;
    readonly to: string;
  };
}

const CHIP_LABELS: Readonly<Record<IntegrationState, string>> = {
  ready: 'ready',
  'needs-auth': 'needs authorising',
  'missing-secret': 'missing secret',
  'not-attached': 'not attached',
  'missing-connector': 'connector missing',
};

function chipAction(
  agentId: string,
  row: IntegrationPreflight,
): ConnectorChip['action'] | undefined {
  if (row.state === 'missing-connector') {
    // The fix is in the library, not in this agent: the agent's reference is
    // fine, the thing it points at is gone (roster §10.3).
    return { kind: 'editor', label: 'Open the connectors…', to: '/connectors' };
  }
  if (row.state === 'not-attached') {
    return {
      kind: 'editor',
      label: 'Add the connector…',
      to: `/agents/${encodeURIComponent(agentId)}`,
    };
  }
  if (row.state === 'missing-secret') {
    // foundation §3.5: there is no HTTP write route for a secret and this does
    // not add one — the fix is `agentmanager secrets set <ref> --stdin`, and the
    // Connectors page is where that command is actually printed beside the ref
    // it is missing (WO4). This used to point at `/settings`, which has no
    // secrets UI at all: a link to a screen that cannot help is worse than none.
    return { kind: 'secrets', label: 'Set the secret…', to: '/connectors' };
  }
  return undefined;
}

/**
 * Every seated agent's connectors, flattened into one ordered chip list.
 *
 * Ordered worst-first *within* each agent — `missing-connector`, then
 * `not-attached`, then `missing-secret`, then `needs-auth`, then `ready` —
 * because a row the user must act on should not be below the fold of a row that
 * is fine.
 */
export function connectorChips(
  agents: readonly AgentView[],
  required: readonly string[] = [],
): readonly ConnectorChip[] {
  const rank: Readonly<Record<IntegrationState, number>> = {
    // First, above `missing-secret`: a connector the library does not hold is a
    // launch refusal with nothing else knowable about it (roster §10.3).
    'missing-connector': 0,
    'not-attached': 1,
    'missing-secret': 2,
    'needs-auth': 3,
    ready: 4,
  };
  const chips: ConnectorChip[] = [];

  for (const agent of agents) {
    const agentId = agent.definition.id;
    const declared = agent.integrations ?? [];
    // `not-attached` is a fact about the *task*, so the list endpoint cannot
    // report it and this adds it — the same rule roster's own projection uses.
    const missing = required
      .filter((name) => !declared.some((row) => row.integration === name))
      .map((name): IntegrationPreflight => ({
        integration: name,
        auth: 'none',
        toolPrefix: `mcp__${name}__`,
        state: 'not-attached',
        credentials: [],
        missingSecretRefs: [],
        required: true,
        detail: `This task needs the “${name}” connector and ${agent.definition.name} does not declare it.`,
      }));

    const rows = [...declared, ...missing].sort((a, b) => rank[a.state] - rank[b.state]);
    for (const row of rows) {
      const action = chipAction(agentId, row);
      chips.push({
        key: `${agentId}:${row.integration}`,
        agentId,
        agentName: agent.definition.name,
        integration: row.integration,
        state: row.state,
        label: CHIP_LABELS[row.state],
        detail: row.detail,
        ...(action === undefined ? {} : { action }),
      });
    }
  }

  return chips;
}

/** True when at least one chip is something the user might want to fix first. */
export function connectorsNeedAttention(chips: readonly ConnectorChip[]): boolean {
  return chips.some((chip) => chip.state !== 'ready');
}
