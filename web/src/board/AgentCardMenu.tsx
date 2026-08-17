/**
 * The card's `⋯` menu (DESIGN §5.2, §5.4).
 *
 * §5.4 is a hard requirement — "the phone browser has no drag, and keyboard
 * users must not be second class" — and this is the agent→project row of its
 * table: **Launch on…**, which opens the same launch flow the drop opens, with
 * the project picker unset instead of pre-filled.
 *
 * §5.2 lists six more entries (Start a pair…, Duplicate, Edit, Export, Pin,
 * Allow remote starts, Archive). Each belongs to the milestone that builds what
 * it opens — M8 for the editor, M9 for the pair dialog, M10 for the remote
 * grant — and a menu item that opens nothing is worse than one that is not there
 * yet, so they are absent rather than stubbed.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';

import { useAppStore } from '../state/store';

export interface AgentCardMenuProps {
  readonly agentId: string;
  readonly agentName: string;
  /** An archived agent's actions are reduced to Restore/Export (§5.2). */
  readonly archived: boolean;
}

export function AgentCardMenu({ agentId, agentName, archived }: AgentCardMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const openLaunch = useAppStore((store) => store.openLaunch);
  const hostRef = useRef<HTMLDivElement>(null);

  // §15: `Esc` closes it and focus returns to the trigger that opened it.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      hostRef.current?.querySelector<HTMLElement>('button')?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="card-menu" ref={hostRef}>
      <button
        type="button"
        className="card-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${agentName}`}
        onClick={() => setOpen((was) => !was)}
      >
        ⋯
      </button>
      {open ? (
        <ul className="card-menu__list" role="menu" aria-label={`${agentName} actions`}>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              disabled={archived}
              onClick={() => {
                setOpen(false);
                openLaunch({ agentId, projectId: null, origin: 'agent-menu' });
              }}
            >
              Launch on…
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
