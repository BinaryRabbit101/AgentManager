/**
 * The shape every confirm dialog in the app shares (DESIGN §15).
 *
 * §15 asks four things of every dialog — a name, `Esc`, trapped focus, and
 * focus restored to its trigger — and the two confirmations (archive an agent,
 * clean up a worktree) each used to satisfy the first and none of the rest.
 * They now share this shell, so the four are true by construction and the
 * milestone gate has one place to check rather than one per dialog.
 *
 * It renders `children` verbatim: the *content* of a confirmation is the whole
 * point of it — "Remove the worktree on `feature/x`? Its 3 commits will go with
 * it" — and nothing here is allowed to summarise that.
 */

import { useRef, type ReactElement, type ReactNode } from 'react';

import { useFocusTrap } from './focusTrap';

export interface ConfirmDialogProps {
  /** The accessible name, and what a screen reader announces on open. */
  readonly label: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function ConfirmDialog({ label, onClose, children }: ConfirmDialogProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  return (
    <div
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      {children}
    </div>
  );
}
