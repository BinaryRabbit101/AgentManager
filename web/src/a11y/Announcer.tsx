/**
 * The polite live region (DESIGN §15; IMPLEMENTATION §11).
 *
 * > "**Live regions, used sparingly.** A polite region announces status
 * > transitions ('Priya's session finished'), a question arriving, and drag
 * > events. Streaming assistant text is **not** announced — the transcript
 * > region is `aria-live="off"` with a 'new output' affordance — because
 * > announcing every token makes a screen reader unusable."
 *
 * The budget is the design. Three kinds of thing are announced here; drag events
 * are dnd-kit's own assertive region (`board/dnd.ts` writes the sentences); and
 * the transcript is silent by construction (`session/SessionView.tsx`).
 * Everything else on the screen is read when the user goes to it.
 *
 * Announcements are derived from the **event feed**, not from render, so a card
 * repainting for any other reason cannot make the app talk.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactElement } from 'react';

import { queryKeys } from '../api/queries';
import type { EventFrame, RosterListView } from '../api/types';
import { useServices } from '../app/AppContext';

/** How many sentences to keep in the region at once. */
const KEEP = 3;

/**
 * The sentence for a frame, or `undefined` for the ones that say nothing.
 *
 * Exported because it is the whole policy: what is announced, and in what
 * words. `a11y/liveRegions.test.tsx` asserts over this rather than over three
 * levels of markup.
 */
export function announcementFor(
  frame: EventFrame,
  nameOf: (agentId: string) => string,
): string | undefined {
  const agentId = frame.ids['agentId'];
  const who = agentId === undefined ? 'An agent' : nameOf(agentId);
  switch (frame.type) {
    case 'session.started':
      return `${who} started working.`;
    case 'session.ended':
      return `${who}'s session finished.`;
    case 'session.paused':
      return `${who}'s session paused.`;
    case 'session.orphaned':
      return `${who}'s session was orphaned.`;
    case 'assignment.question.raised':
      return 'A question is waiting for you.';
    case 'assignment.question.answered':
      return 'That question is answered.';
    case 'assignment.halted':
      return 'An assignment halted and needs you.';
    case 'runner.ratelimited':
      return 'Rate limited — new sessions are paused until it clears.';
    default:
      // Everything else is a repaint, not news. In particular `session.delta`,
      // `session.message` and `session.tool.*` are never announced — they are
      // the streaming text §15 forbids reading aloud, and they do not even
      // reach the global feed (§3.3).
      return undefined;
  }
}

export function Announcer(): ReactElement {
  const { events } = useServices();
  const queryClient = useQueryClient();
  const [said, setSaid] = useState<readonly string[]>([]);

  useEffect(() => {
    /**
     * The roster is **read** from the cache, never fetched.
     *
     * This region is mounted on every screen, including `/questions` — which
     * §11.1 requires to be **one request cold**, and IMPLEMENTATION §5 makes a
     * second request there a milestone failure. So the name is a nicety taken
     * from whatever the board already loaded, and "An agent finished" is the
     * honest fallback when nothing has.
     */
    const nameOf = (agentId: string): string =>
      queryClient
        .getQueryData<RosterListView>(queryKeys.roster)
        ?.agents.find((agent) => agent.definition.id === agentId)?.definition.name ?? 'An agent';
    return events.on((frame) => {
      const sentence = announcementFor(frame, nameOf);
      if (sentence === undefined) return;
      setSaid((was) => [...was, sentence].slice(-KEEP));
    });
  }, [events, queryClient]);

  return (
    <div className="visually-hidden" role="status" aria-live="polite" data-announcer="true">
      {said.map((sentence, index) => (
        <p key={`${sentence}-${String(index)}`}>{sentence}</p>
      ))}
    </div>
  );
}
