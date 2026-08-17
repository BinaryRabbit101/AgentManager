/**
 * Toasts — the one transient surface in the app (DESIGN §5.3).
 *
 * There is exactly one thing that needs one: "It applies optimistically and
 * **rolls back with a toast on failure**." A rollback is the case where the
 * screen has just silently un-done something the user did, so it must say so;
 * everything else in this UI reports failure *where the failure happened* (the
 * dialog that submitted, the card that refused), because a message that flies
 * away is the wrong home for a fact the user has to act on.
 *
 * §15's live-region budget is respected: `role="status"` and `aria-live="polite"`
 * on the region, not per message, so several rollbacks in a row are one
 * announcement rather than a queue that talks over itself. Health warnings are
 * explicitly **not** toasts (IMPLEMENTATION §10: "displayed persistently, not as
 * a dismissible toast").
 */

import type { ReactElement } from 'react';

import { useAppStore } from '../state/store';

export function Toasts(): ReactElement {
  const toasts = useAppStore((store) => store.toasts);
  const dismiss = useAppStore((store) => store.dismissToast);

  return (
    <div className="toasts" role="status" aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" data-tone={toast.tone}>
          <span>{toast.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
