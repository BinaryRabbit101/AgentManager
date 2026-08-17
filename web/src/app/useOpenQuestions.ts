/**
 * §2.2's badge count, read from the server (`GET /api/orchestrator/status`).
 *
 * **This closes ui M5's deliberate degrade.** The inbox badge was the inbox's own
 * length, bumped by `assignment.question.raised` / `.answered`, because the
 * endpoint was orchestrator M9 and had not landed. It has landed, and the shape
 * of the degrade was always "the rendering, the words and the tests do not
 * change — only where the value is read", so this is the one accessor that
 * changed and nothing downstream did.
 *
 * The events still drive the number between fetches, and they must: §11.1 wants
 * the badge inside a second of a card arriving, and a refetch round-trip is not
 * that. The query is what makes a **cold load** and a **reconnect** right — which
 * counting frames from zero never could, because a client that boots with three
 * questions already open counts them as none.
 */

import { useEffect } from 'react';

import type { ApiClient } from '../api/client';
import { useOrchestratorStatus } from '../api/queries';
import { useAppStore } from '../state/store';

export function useOpenQuestions(client: ApiClient): number | null {
  const status = useOrchestratorStatus(client);
  const open = status.data?.questions.open;

  useEffect(() => {
    if (open === undefined) return;
    useAppStore.getState().setOpenQuestions(open);
  }, [open]);

  // The store rather than the query, so a `raised` frame shows before the
  // invalidated query has come back.
  return useAppStore((store) => store.openQuestions);
}
