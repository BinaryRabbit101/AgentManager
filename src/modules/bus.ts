/**
 * The event bus of DESIGN §6.5.
 *
 * "In-process typed emitter. Events are `{type, ts, ids, payload, persist?}`.
 * Events flagged `persist` are written to the `events` table in the same tick
 * they are emitted; all events are fanned out to WS subscribers. This gives the
 * UI one mechanism for both 'what happened while I was disconnected' (replay
 * from `events` by id watermark) and 'what is happening now' (live stream)."
 *
 * Two properties the implementation exists to guarantee:
 *
 * - **A subscriber cannot break the bus.** Every listener is called inside its
 *   own try/catch, so one throwing handler neither loses the event for the
 *   others nor propagates into the emitter, which is usually mid-transaction
 *   doing something more important than notification.
 * - **Filtering is a subscription concern only.** {@link matchesEventType} is
 *   the same matcher the `events` repository implements in SQL for
 *   `/api/events?types=`, so the live fan-out and the `since=` replay return
 *   the same subset (§6.5, ui §19 R4). Filtering never changes what is emitted,
 *   persisted or replayable.
 */
import type { EventRecord, EventsRepository } from '../storage/index.js';

import type { AppEvent, Clock, EmitEvent, EventBus, EventListener, Unsubscribe } from './types.js';

/**
 * `session.*` matches every type in that namespace (including deeper ones,
 * `session.tool.use`); anything else matches exactly.
 *
 * Mirrors the `type LIKE 'session.%'` predicate of the `events` repository,
 * deliberately down to the edge cases — a bare `*` is an exact match for the
 * type `*`, because a pattern that means "everything" already exists as
 * "no filter at all".
 */
export function matchesEventType(pattern: string, type: string): boolean {
  return pattern.endsWith('.*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
}

/**
 * A predicate over event types for a `types=` list. `undefined` or an empty
 * list means everything, matching the repository's `EventQuery.types`.
 */
export function createEventTypeFilter(
  types: readonly string[] | undefined,
): (type: string) => boolean {
  if (types === undefined || types.length === 0) return () => true;
  const patterns = [...types];
  return (type) => patterns.some((pattern) => matchesEventType(pattern, type));
}

export interface EventBusOptions {
  /** Stamps `ts`. Injectable so tests are not time-dependent (§6.1). */
  readonly clock?: Clock;
  /**
   * Where `persist: true` events go — `store.events` (§1.4).
   *
   * Optional so the bus is testable, and constructible, without a database;
   * without it a `persist: true` event still fans out and simply carries no id.
   */
  readonly events?: Pick<EventsRepository, 'append'>;
  /** A subscriber threw. The composition root logs it (§6.5). */
  readonly onListenerError?: (error: unknown, event: AppEvent) => void;
  /** The `events` row could not be written. */
  readonly onPersistError?: (error: unknown, event: AppEvent) => void;
}

interface Subscription {
  readonly matches: (type: string) => boolean;
  readonly listener: EventListener;
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const clock = options.clock ?? ((): Date => new Date());
  const subscriptions = new Set<Subscription>();

  const persist = (event: AppEvent): string | undefined => {
    if (options.events === undefined) return undefined;
    try {
      const row: EventRecord = options.events.append({
        ts: event.ts,
        type: event.type,
        ...(event.ids.sessionId === undefined ? {} : { sessionId: event.ids.sessionId }),
        ...(event.ids.assignmentId === undefined ? {} : { assignmentId: event.ids.assignmentId }),
        ...(event.ids.projectId === undefined ? {} : { projectId: event.ids.projectId }),
        ...(event.ids.agentId === undefined ? {} : { agentId: event.ids.agentId }),
        ...(event.payload === undefined ? {} : { payload: event.payload }),
      });
      return row.id;
    } catch (error) {
      // A failed audit write must not take down the thing being audited: the
      // emitter is typically mid-session doing the work the event describes.
      // It is reported (the composition root logs it at `error`) and the event
      // still reaches live subscribers — it simply will not survive a restart.
      options.onPersistError?.(error, event);
      return undefined;
    }
  };

  return {
    emit<P>(input: EmitEvent<P>): AppEvent<P> {
      const base: AppEvent<P> = {
        type: input.type,
        ts: input.ts ?? clock().toISOString(),
        ids: input.ids ?? {},
        persist: input.persist === true,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
      };

      const id = base.persist ? persist(base) : undefined;
      const event: AppEvent<P> = id === undefined ? base : { ...base, id };

      // Snapshot: a listener that unsubscribes (or subscribes) during fan-out
      // must not change who receives the event currently being delivered.
      for (const subscription of [...subscriptions]) {
        if (!subscription.matches(event.type)) continue;
        try {
          subscription.listener(event);
        } catch (error) {
          options.onListenerError?.(error, event);
        }
      }

      return event;
    },

    subscribe(
      first: EventListener | readonly string[] | undefined,
      second?: EventListener,
    ): Unsubscribe {
      const listener = typeof first === 'function' ? first : second;
      if (listener === undefined) {
        throw new TypeError(
          'bus.subscribe(listener) or bus.subscribe(types, listener) — no listener was given.',
        );
      }
      const types = typeof first === 'function' ? undefined : first;
      const subscription: Subscription = { matches: createEventTypeFilter(types), listener };
      subscriptions.add(subscription);
      return () => void subscriptions.delete(subscription);
    },

    subscriberCount: () => subscriptions.size,
  };
}
