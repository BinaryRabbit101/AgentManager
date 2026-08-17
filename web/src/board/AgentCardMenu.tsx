/**
 * The card's `⋯` menu (DESIGN §5.2, §5.4).
 *
 * §5.4 is a hard requirement — "the phone browser has no drag, and keyboard
 * users must not be second class" — and this is the agent→project row of its
 * table: **Launch on…**, which opens the same launch flow the drop opens, with
 * the project picker unset instead of pre-filled.
 *
 * §5.2's other entries: **Edit**, **Duplicate** and **Export** (M8), and
 * **Start a pair…** (M9) — §5.4's pointer-free equivalent of dropping one card
 * on another, opening the same dialog the drop opens. Remote starts are granted
 * from the launch flow's toggle and from settings (§13.2), not from here: a
 * grant is a decision about an agent, and the card carries its *state* as a
 * badge rather than a second control that could disagree with the first.
 *
 * Duplicate posts and then navigates rather than opening a dialog: roster's
 * `POST /agents/:id/duplicate` mints the second folder and returns the
 * definition, and §7.2 says the editor opens "directly" on that — so the editor
 * the user lands in is already editing a real, independent agent.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { queryKeys } from '../api/queries';
import type { AgentView } from '../api/types';
import { useServices } from '../app/AppContext';
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
  const openPair = useAppStore((store) => store.openPair);
  const pushToast = useAppStore((store) => store.pushToast);
  const { client } = useServices();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const hostRef = useRef<HTMLDivElement>(null);

  async function duplicate(): Promise<void> {
    close();
    const result = await client.request<AgentView>(
      `/roster/agents/${encodeURIComponent(agentId)}/duplicate`,
      { method: 'POST', body: {} },
    );
    if (result.kind !== 'ok') {
      pushToast(result.message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    navigate(`/agents/${encodeURIComponent(result.value.definition.id)}`);
  }

  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * §15, and the reason it matters beyond the menu itself.
   *
   * Focus moves **into** the menu when it opens, and back to the `⋯` when it
   * closes — by `Esc` or by picking something. The second half is what makes a
   * dialog opened from here restorable: `useFocusTrap` remembers whatever had
   * focus when the dialog mounted, and a menu item that has already unmounted
   * is not somewhere focus can go back to.
   */
  const close = useCallback((): void => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    hostRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close, open]);

  return (
    <div className="card-menu" ref={hostRef}>
      <button
        type="button"
        ref={triggerRef}
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
                close();
                openLaunch({ agentId, projectId: null, origin: 'agent-menu' });
              }}
            >
              Launch on…
            </button>
          </li>
          <li role="none">
            {/*
              §5.4's agent→agent row: the pointer-free equivalent of dropping
              one card on another. It opens the *same* dialog the drop opens,
              with this card in the drafting seat and the critic seat to pick.
            */}
            <button
              type="button"
              role="menuitem"
              disabled={archived}
              onClick={() => {
                close();
                openPair({ agentId, withAgentId: null });
              }}
            >
              Start a pair…
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                navigate(`/agents/${encodeURIComponent(agentId)}`);
              }}
            >
              Edit
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              disabled={archived}
              onClick={() => void duplicate()}
            >
              Duplicate
            </button>
          </li>
          <li role="none">
            {/* An archived agent keeps Export (§5.2): the pack is how its work
                leaves the machine, and archiving is not deletion. */}
            <a role="menuitem" href={`/api/roster/agents/${encodeURIComponent(agentId)}/export`}>
              Export
            </a>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
