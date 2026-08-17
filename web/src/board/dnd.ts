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
  readonly kind: 'agent' | 'project';
  readonly label: string;
  readonly refusal?: string;
}

/** What a completed drag asks the app to do. Nothing here performs it. */
export type DropOutcome =
  | { readonly kind: 'launch'; readonly agentId: string; readonly projectId: string }
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
): readonly DropTarget[] {
  return [...agents, ...projects];
}

/** Wraps, because a ring that stops at its ends strands a keyboard user. */
export function stepRing(length: number, index: number, delta: number): number {
  if (length === 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/**
 * What dropping `agentId` on `target` means (§5.3's table).
 *
 * Dropping an agent on **another agent card** is a board reorder: dnd-kit's
 * sortable context owns that element, and §5.3's third row — the pair create
 * dialog — lands with the assignment view (M9), where §5.3 already says "until
 * then the target is inert".
 */
export function dropOutcome(agentId: string, target: DropTarget | undefined): DropOutcome {
  if (target === undefined) return { kind: 'none' };
  if (target.kind === 'project') {
    if (target.refusal !== undefined) {
      return { kind: 'refused', reason: `${target.label} is ${target.refusal}.` };
    }
    return { kind: 'launch', agentId, projectId: target.id };
  }
  if (target.id === agentId) return { kind: 'none' };
  return { kind: 'reorder', agentId, overAgentId: target.id };
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
export function overTarget(agentName: string, target: DropTarget | undefined): string {
  if (target === undefined) return `${agentName} is over no target.`;
  if (target.kind === 'agent') {
    return target.label === agentName
      ? `${agentName} is back in its own place.`
      : `Move ${agentName} to ${target.label}'s place.`;
  }
  if (target.refusal !== undefined) {
    return `${target.label} can't be launched on: ${target.refusal}.`;
  }
  return `Launch ${agentName} on ${target.label}.`;
}

export function droppedOn(agentName: string, outcome: DropOutcome, targetLabel?: string): string {
  switch (outcome.kind) {
    case 'launch':
      return `Opening the launch flow for ${agentName} on ${targetLabel ?? 'the project'}. Nothing has started yet.`;
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
