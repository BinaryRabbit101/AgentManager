/**
 * The one place the event feed is wired to the caches and the store (§3.3, §3.4).
 *
 * The stream is a singleton and this hook is mounted once, at the app root. It
 * does three things and nothing else: mirror the connection state into the
 * store, fold session lifecycle events into the derived fleet status, and hand
 * every frame to §3.4's map.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { AvatarCache } from '../api/avatars';
import type { EventStream } from '../events/EventStream';
import { plan } from '../events/invalidation';
import { useAppStore } from '../state/store';

export function useEventStream(events: EventStream, avatars: AvatarCache): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const setConnection = useAppStore.getState().setConnection;
    const ingest = useAppStore.getState().ingest;

    setConnection(events.state);
    const offState = events.onStateChange(setConnection);

    const offEvent = events.on((frame) => {
      const outcome = plan(frame);
      if (outcome.sessionLifecycle) ingest(frame);
      for (const agentId of outcome.avatars) avatars.invalidate(agentId);
      for (const key of outcome.invalidate) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    });

    events.start();
    return () => {
      offEvent();
      offState();
      events.stop();
    };
  }, [avatars, events, queryClient]);
}
