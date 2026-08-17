/**
 * Focus trapping and restoration for every dialog (DESIGN §15).
 *
 * > "`Esc` closing every dialog and sheet, and focus **trapped in modals and
 * > restored on close**."
 *
 * One hook, used by every dialog in the app, because the alternative — each
 * dialog remembering to do it — is the shape in which one of them eventually
 * forgets. `a11y/keyboard.test.tsx` walks the real dialogs through the real hook
 * rather than testing this file in isolation, for the same reason.
 *
 * What it does, and nothing else:
 *
 *  - moves focus into the dialog on open (the caller may focus a specific field
 *    first; this only acts when focus is still outside);
 *  - keeps `Tab` and `Shift+Tab` inside it, wrapping at both ends;
 *  - restores focus to whatever had it when the dialog opened, on close.
 *
 * It deliberately does **not** own `Esc`: closing is the dialog's decision (some
 * confirm first), and §15 asks that every dialog close on `Esc`, which each one
 * does explicitly and is asserted per dialog.
 */

import { useEffect, useState, type RefObject } from 'react';

/** Everything a user can Tab to, in document order. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function focusableWithin(root: HTMLElement): readonly HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Traps focus inside `ref` while it is mounted, and restores it after.
 *
 * @param ref the dialog element
 * @param active `false` leaves focus alone entirely (a closed sheet)
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  /**
   * Whatever opened it — the card's `⋯`, the rail's **Add project**, a menu item.
   *
   * Captured in a lazy initialiser, which runs during the **first render**,
   * because by the time effects run the dialog has usually focused a field of
   * its own (the launch prompt, the quick-add path) and the opener is no longer
   * `document.activeElement`. Restoring to the field the dialog focused would
   * mean restoring to a node that is about to be unmounted — which is exactly
   * the "focus falls to `<body>`" bug this is here to prevent.
   */
  const [restoreTo] = useState<HTMLElement | null>(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );

  useEffect(() => {
    if (!active) return undefined;
    const dialog = ref.current;
    if (dialog === null) return undefined;

    if (!dialog.contains(document.activeElement)) {
      (focusableWithin(dialog)[0] ?? dialog).focus();
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const focusable = focusableWithin(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const current = document.activeElement;
      // The wrap is explicit in both directions: jsdom moves focus for neither,
      // and a real browser would leave the dialog at both ends.
      if (!event.shiftKey && (current === last || !dialog.contains(current))) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && (current === first || !dialog.contains(current))) {
        event.preventDefault();
        last.focus();
      }
    };

    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      // "restored on close" — and only when the trigger is still there, because
      // a dialog that navigated away has nothing to hand focus back to.
      if (restoreTo !== null && restoreTo.isConnected) restoreTo.focus();
    };
  }, [active, ref, restoreTo]);
}
