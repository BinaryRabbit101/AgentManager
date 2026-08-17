/**
 * The screens M1 and M2 route to but do not build yet.
 *
 * They exist because §2.1's ten routes must all be deep-linkable from the first
 * milestone: the ntfy notification and the Electron toast both navigate by URL,
 * and a route that 404s inside the SPA is indistinguishable from a broken
 * history fallback. Each one names the milestone that fills it in, so nobody
 * mistakes a placeholder for a bug.
 */

import type { ReactElement } from 'react';
import { useParams } from 'react-router-dom';

export interface PlaceholderProps {
  readonly title: string;
  readonly milestone: string;
  readonly what: string;
}

export function Placeholder({ title, milestone, what }: PlaceholderProps): ReactElement {
  const params = useParams();
  const id = params['id'];
  return (
    <section>
      <h2>{title}</h2>
      <p className="empty">
        {what} — ui {milestone}.
      </p>
      {id === undefined ? null : (
        <p className="boot-screen__detail" data-route-id={id}>
          {id}
        </p>
      )}
    </section>
  );
}
