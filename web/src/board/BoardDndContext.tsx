/**
 * One `DndContext` over the board **and** the rail (DESIGN §5.3).
 *
 * > "One `DndContext` wraps the board and the rail. The draggable payload is
 * > `{ type: 'agent', agentId }`; every droppable declares `{ type, … }` and the
 * > drop handler dispatches on it."
 *
 * Three sensors, as §5.3 pins them: `PointerSensor`, `TouchSensor` (250ms
 * long-press, 5px tolerance) and `KeyboardSensor`. HTML5 native drag-and-drop is
 * not used — it does not fire on touch, cannot be driven from the keyboard, and
 * cannot render a custom preview.
 *
 * The keyboard sensor walks `dnd.ts`'s ring rather than geometry (see that file
 * for why), which is also what makes `collisionDetection` here a two-branch
 * function: a keyboard drag resolves to the ring entry the arrows have reached,
 * a pointer or touch drag resolves by real collision. Both end in the same
 * `onDragEnd`, so there is one drop path and one set of consequences.
 */

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type ScreenReaderInstructions,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { useCallback, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';

import {
  buildRing,
  cancelled,
  dropOutcome,
  droppedOn,
  overTarget,
  pickedUp,
  stepRing,
  type DropOutcome,
  type DropTarget,
} from './dnd';

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'Press space to pick up an agent. Use the arrow keys to move between the other cards and the ' +
    'projects. Press space again to drop, or escape to cancel. Nothing is started by the drop ' +
    'itself — the launch flow opens first.',
};

export interface BoardDndContextProps {
  /** Every card, in the order the board shows them. */
  readonly agentTargets: readonly DropTarget[];
  readonly projectTargets: readonly DropTarget[];
  readonly onDrop: (outcome: DropOutcome) => void;
  readonly children: ReactNode;
}

export function BoardDndContext({
  agentTargets,
  projectTargets,
  onDrop,
  children,
}: BoardDndContextProps): ReactElement {
  const ring = useMemo(
    () => buildRing(agentTargets, projectTargets),
    [agentTargets, projectTargets],
  );
  const ringRef = useRef(ring);
  ringRef.current = ring;

  /** Where the arrow keys have got to. Reset on every pick-up. */
  const ringIndex = useRef(0);
  const keyboardDrag = useRef(false);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const labelOf = useCallback(
    (id: UniqueIdentifier | null | undefined): DropTarget | undefined =>
      id === null || id === undefined
        ? undefined
        : ringRef.current.find((target) => target.id === String(id)),
    [],
  );

  /**
   * The arrow keys, as a ring walk.
   *
   * Returning a *changed* coordinate is what makes dnd-kit re-run collision
   * detection; the value itself is never read for a keyboard drag, because
   * `collision` below answers from the ring. Returning `undefined` for any other
   * key leaves it to the page, which is what keeps `Tab` and `Esc` working.
   */
  const coordinateGetter = useCallback<KeyboardCoordinateGetter>((event, args) => {
    const delta =
      event.code === 'ArrowDown' || event.code === 'ArrowRight'
        ? 1
        : event.code === 'ArrowUp' || event.code === 'ArrowLeft'
          ? -1
          : 0;
    if (delta === 0) return undefined;
    keyboardDrag.current = true;
    ringIndex.current = stepRing(ringRef.current.length, ringIndex.current, delta);
    const base = args.currentCoordinates;
    return { x: base.x, y: base.y + delta };
  }, []);

  const collision = useCallback<CollisionDetection>((args) => {
    if (keyboardDrag.current) {
      const target = ringRef.current[ringIndex.current];
      if (target === undefined) return [];
      const container = args.droppableContainers.find(
        (candidate) => String(candidate.id) === target.id,
      );
      return container === undefined
        ? []
        : [{ id: container.id, data: { droppableContainer: container, value: 0 } }];
    }
    const within = pointerWithin(args);
    return within.length > 0 ? within : rectIntersection(args);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // §5.3: a 250ms long-press, so a scroll on a phone is a scroll.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter }),
  );

  const activeLabel = labelOf(activeId)?.label ?? 'the agent';

  const announcements = useMemo<Announcements>(
    () => ({
      onDragStart: ({ active }) => pickedUp(labelOf(active.id)?.label ?? 'the agent'),
      onDragOver: ({ active, over }) =>
        overTarget(labelOf(active.id)?.label ?? 'the agent', labelOf(over?.id)),
      onDragEnd: ({ active, over }) => {
        const target = labelOf(over?.id);
        const name = labelOf(active.id)?.label ?? 'the agent';
        return droppedOn(name, dropOutcome(String(active.id), target), target?.label);
      },
      onDragCancel: ({ active }) => cancelled(labelOf(active.id)?.label ?? 'the agent'),
    }),
    [labelOf],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
      onDragStart={({ active }) => {
        keyboardDrag.current = false;
        // The lift starts on the card itself, so the first arrow press moves to
        // the *next* target rather than to an arbitrary one.
        ringIndex.current = Math.max(
          0,
          ringRef.current.findIndex((target) => target.id === String(active.id)),
        );
        setActiveId(String(active.id));
        setOverId(null);
      }}
      onDragOver={({ over }) => setOverId(over === null ? null : String(over.id))}
      onDragCancel={() => {
        setActiveId(null);
        setOverId(null);
      }}
      onDragEnd={({ active, over }) => {
        setActiveId(null);
        setOverId(null);
        onDrop(dropOutcome(String(active.id), labelOf(over?.id)));
      }}
    >
      <SortableContext
        items={agentTargets.map((target) => target.id)}
        strategy={rectSortingStrategy}
      >
        <div className="board-dnd" data-dragging={activeId === null ? 'false' : 'true'}>
          {children}
        </div>
      </SortableContext>

      {/*
        §5.3's floating label — "Launch **Priya** on **littlepocketmuseum**" —
        carried by the drag preview rather than pinned to a corner, because it
        describes the thing under the cursor.
      */}
      <DragOverlay dropAnimation={null}>
        {activeId === null ? null : (
          <div
            className="drag-preview"
            data-refused={labelOf(overId)?.refusal === undefined ? 'false' : 'true'}
          >
            {overTarget(activeLabel, labelOf(overId))}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
