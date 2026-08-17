/**
 * The board's drag gesture, as data (DESIGN §5.3, §5.4; IMPLEMENTATION §3).
 *
 * Everything here is pure: what the targets are, what a drop *means*, what the
 * live region says, and why a target is refused. The React half
 * (`BoardDndContext.tsx`) owns sensors, the overlay and the wiring; this owns
 * the decisions — so the decisions can be asserted without a pointer, a layout
 * or a browser.
 *
 * ## The keyboard ring, and why it is not a geometric search
 *
 * §5.4: "Tab to the card, `Space` to lift, **arrows to move between targets**,
 * `Space` to drop." That sentence describes a *ring of targets*, not a spatial
 * search, and the board is exactly that: a list of cards followed by a list of
 * projects. dnd-kit's stock keyboard behaviour walks geometry; here the arrow
 * keys walk {@link buildRing} instead, so the order a keyboard user experiences
 * is the order the screen reader announces, on every viewport and at every zoom
 * level — and it stays deterministic when the rail reflows into a horizontal
 * scroller on a phone (§2.3).
 *
 * Pointer and touch drags keep dnd-kit's real collision detection, because there
 * the pointer *is* the intent.
 */

import type { Project } from '../api/types';
import { projectLaunchRefusal } from '../api/types';

/** The payload of the one draggable kind the board has (§5.3). */
export interface AgentDragData {
  readonly type: 'agent';
  readonly agentId: string;
}

/**
 * One droppable, flattened.
 *
 * `refusal` is the §5.3 rule made renderable: "A project that cannot be launched
 * against — `provisioning`, `archived`, or health `missing` — is **not** a valid
 * target: it dims during the drag and its tooltip says why."
 */
export interface DropTarget {
  readonly id: string;
  readonly kind: 'agent' | 'project' | 'workItem';
  readonly label: string;
  readonly refusal?: string;
  /** `workItem` only: which project the row belongs to (§5.3's payload). */
  readonly projectId?: string;
}

/** What a completed drag asks the app to do. Nothing here performs it. */
export type DropOutcome =
  | { readonly kind: 'launch'; readonly agentId: string; readonly projectId: string }
  /** §5.3 row 3: the pair create dialog, drafting seat × critic seat (§10.4). */
  | { readonly kind: 'pair'; readonly agentId: string; readonly withAgentId: string }
  /** §5.3 row 2: the launch flow with the item attached. */
  | {
      readonly kind: 'launch-work-item';
      readonly agentId: string;
      readonly projectId: string;
      readonly workItemId: string;
    }
  | { readonly kind: 'reorder'; readonly agentId: string; readonly overAgentId: string }
  | { readonly kind: 'refused'; readonly reason: string }
  /** Dropped on nothing, or on itself. "Drop on nothing cancels silently." */
  | { readonly kind: 'none' };

export function agentTarget(agentId: string, name: string): DropTarget {
  return { id: agentId, kind: 'agent', label: name };
}

export function projectTarget(project: Project): DropTarget {
  const refusal = projectLaunchRefusal(project);
  return {
    id: project.id,
    kind: 'project',
    label: project.name,
    ...(refusal === undefined ? {} : { refusal }),
  };
}

/**
 * A work item row (§5.3 row 2, §8.2 region 4).
 *
 * A `done` or `dropped` item is refused for the same reason an archived project
 * is: the drop would open a launch flow for work the user has already closed,
 * and refusing at the drop beats a flow that surprises on submit.
 */
export function workItemTarget(item: {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: string;
}): DropTarget {
  const refusal =
    item.status === 'done' ? 'already done' : item.status === 'dropped' ? 'dropped' : undefined;
  return {
    id: item.id,
    kind: 'workItem',
    label: item.title,
    projectId: item.projectId,
    ...(refusal === undefined ? {} : { refusal }),
  };
}

/**
 * The ordered ring the arrow keys walk: every card, then every project.
 *
 * The dragged card is left in place rather than removed — dnd-kit's sortable
 * context treats "over itself" as the identity move, and a ring whose length
 * changed with the selection would make "third target" mean two different
 * things depending on which card was lifted.
 */
export function buildRing(
  agents: readonly DropTarget[],
  projects: readonly DropTarget[],
  workItems: readonly DropTarget[] = [],
): readonly DropTarget[] {
  return [...agents, ...projects, ...workItems];
}

/** Wraps, because a ring that stops at its ends strands a keyboard user. */
export function stepRing(length: number, index: number, delta: number): number {
  if (length === 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/**
 * What dropping `agentId` on `target` means (§5.3's table).
 *
 * ## The one ambiguity in §5.3's table, and how it is resolved
 *
 * Two of its four rows describe the *same* pointer gesture. "Another agent
 * card" opens the **pair create dialog**; "the board grid itself" is a
 * **reorder** — but dnd-kit's sortable context reports the card you are over,
 * not the gap between cards, so a drop is over an agent card in both cases.
 * Until M9 the target was inert (§5.3 says so in as many words) and the code
 * read every agent→agent drop as a reorder; with the assignment view landed,
 * both meanings are live and something has to tell them apart.
 *
 * **Reorder mode is what tells them apart**, and it is not a new invention:
 * §5.4 already lists "Reorder mode" as *the* non-drag path to board order, and
 * gives the pair gesture its own row. So inside Reorder mode an agent→agent
 * drop reorders, and outside it the same drop opens the pair dialog. Each
 * gesture keeps its own keyboard path — which is what IMPLEMENTATION §11 then
 * requires, listing "agent→agent" and "board reorder" as two of the four drags
 * that each need one.
 */
export function dropOutcome(
  agentId: string,
  target: DropTarget | undefined,
  /** `true` while the board is in §5.4's explicit Reorder mode. */
  reordering = false,
): DropOutcome {
  if (target === undefined) return { kind: 'none' };
  if (target.kind === 'project') {
    if (target.refusal !== undefined) {
      return { kind: 'refused', reason: `${target.label} is ${target.refusal}.` };
    }
    return { kind: 'launch', agentId, projectId: target.id };
  }
  if (target.kind === 'workItem') {
    if (target.refusal !== undefined) {
      return { kind: 'refused', reason: `“${target.label}” is ${target.refusal}.` };
    }
    return {
      kind: 'launch-work-item',
      agentId,
      projectId: target.projectId ?? '',
      workItemId: target.id,
    };
  }
  if (target.id === agentId) return { kind: 'none' };
  if (reordering) return { kind: 'reorder', agentId, overAgentId: target.id };
  return { kind: 'pair', agentId, withAgentId: target.id };
}

// ---------------------------------------------------------------------------
// The live region (§15: "dnd-kit's live-region announcements for pick-up,
// target change, drop and cancel")
// ---------------------------------------------------------------------------

export function pickedUp(agentName: string): string {
  return `Picked up ${agentName}. Use the arrow keys to choose a target, space to drop, escape to cancel.`;
}

/**
 * The floating label of §5.3 — *"Launch **Priya** on **littlepocketmuseum**"* —
 * and the same sentence the live region reads on every target change, so the
 * pointer user and the screen-reader user are told the same thing.
 */
export function overTarget(
  agentName: string,
  target: DropTarget | undefined,
  reordering = false,
): string {
  if (target === undefined) return `${agentName} is over no target.`;
  if (target.kind === 'agent') {
    if (target.label === agentName) return `${agentName} is back in its own place.`;
    return reordering
      ? `Move ${agentName} to ${target.label}'s place.`
      : `Start a pair: ${agentName} drafting, ${target.label} reviewing.`;
  }
  if (target.refusal !== undefined) {
    return `${target.label} can't be launched on: ${target.refusal}.`;
  }
  if (target.kind === 'workItem') {
    return `Launch ${agentName} on the work item “${target.label}”.`;
  }
  return `Launch ${agentName} on ${target.label}.`;
}

export function droppedOn(agentName: string, outcome: DropOutcome, targetLabel?: string): string {
  switch (outcome.kind) {
    case 'launch':
      return `Opening the launch flow for ${agentName} on ${targetLabel ?? 'the project'}. Nothing has started yet.`;
    case 'launch-work-item':
      return `Opening the launch flow for ${agentName} on “${targetLabel ?? 'the work item'}”. Nothing has started yet.`;
    case 'pair':
      return `Opening the pair dialog for ${agentName} with ${targetLabel ?? 'the other agent'}. Nothing has started yet.`;
    case 'reorder':
      return `Moved ${agentName} to ${targetLabel ?? 'a new position'}.`;
    case 'refused':
      return `${outcome.reason} Nothing was started.`;
    case 'none':
      return `${agentName} was left where it was.`;
  }
}

export function cancelled(agentName: string): string {
  return `Dropping ${agentName} was cancelled. It stayed where it was.`;
}
