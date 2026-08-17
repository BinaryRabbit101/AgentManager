/**
 * The card's `⋯` menu (DESIGN §5.2, §5.4).
 *
 * §5.4 is a hard requirement — "the phone browser has no drag, and keyboard
 * users must not be second class" — and this is the agent→project row of its
 * table: **Launch on…**, which opens the same launch flow the drop opens, with
 * the project picker unset instead of pre-filled.
 *
 * §5.2 lists six more entries. **Edit**, **Duplicate** and **Export** arrive with
 * M8, which is what they open; **Start a pair…** (M9) and **Allow remote
 * starts** (M10) are still absent rather than stubbed, because a menu item that
 * opens nothing is worse than one that is not there yet.
 *
 * Duplicate posts and then navigates rather than opening a dialog: roster's
 * `POST /agents/:id/duplicate` mints the second folder and returns the
 * definition, and §7.2 says the editor opens "directly" on that — so the editor
 * the user lands in is already editing a real, independent agent.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactElement } from 'react';
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
  const pushToast = useAppStore((store) => store.pushToast);
  const { client } = useServices();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const hostRef = useRef<HTMLDivElement>(null);

  async function duplicate(): Promise<void> {
    setOpen(false);
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
          <li role="none">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
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
