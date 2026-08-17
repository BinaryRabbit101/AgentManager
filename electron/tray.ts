/**
 * The tray menu (DESIGN §1.5 #3).
 *
 * > "Tray icon: Open AgentManager, "N questions waiting" (opens the inbox deep
 * > link), Stop background service (`POST /api/service/shutdown`), Quit. Closing
 * > the window never stops the core."
 *
 * Four rows, and the ordering matters: **Quit** (leave the app, core keeps
 * running) sits below **Stop background service** (stop the core) so the
 * destructive one is not the one under the thumb. The two are genuinely different
 * and the labels say so, because "quit" meaning "stop the agents that were
 * working while you were away" is the surprise foundation §4.1 exists to prevent.
 *
 * A pure template builder, because the interesting part is the label arithmetic
 * and the click targets — both of which are assertable without a display.
 */

import type { MenuItemSpec } from './host.js';

/**
 * Declared as function *properties* rather than methods, deliberately: each one
 * is handed straight to a menu row and called detached from the object, which is
 * exactly what a method signature makes unsound.
 */
export interface TrayActions {
  readonly openApp: () => void;
  /** Focuses the window on `/questions` — the inbox deep link. */
  readonly openQuestions: () => void;
  /** `POST /api/service/shutdown`. Stops the **core**, not the window. */
  readonly stopBackgroundService: () => void;
  /** Closes the app. The core keeps running (foundation §4.1). */
  readonly quit: () => void;
}

/**
 * §2.2's badge, in words.
 *
 * `null` means "nothing has said yet" and reads as the neutral label rather than
 * as zero — the same rule the rail badge follows, because a tray that claims "no
 * questions waiting" before the inbox has been read is claiming something the app
 * does not know.
 */
export function questionsLabel(open: number | null): string {
  if (open === null) return 'Questions';
  if (open === 0) return 'No questions waiting';
  if (open === 1) return '1 question waiting';
  return `${String(open)} questions waiting`;
}

export function trayTooltip(open: number | null): string {
  return open === null || open === 0 ? 'AgentManager' : `AgentManager — ${questionsLabel(open)}`;
}

export function trayMenu(open: number | null, actions: TrayActions): readonly MenuItemSpec[] {
  return [
    { id: 'open', label: 'Open AgentManager', click: actions.openApp },
    {
      id: 'questions',
      label: questionsLabel(open),
      // Nothing to open when there is nothing waiting; still shown, so the count
      // is readable at a glance without opening the window.
      enabled: open !== null && open > 0,
      click: actions.openQuestions,
    },
    {
      id: 'stop-core',
      label: 'Stop background service',
      click: actions.stopBackgroundService,
    },
    { id: 'quit', label: 'Quit', click: actions.quit },
  ];
}
