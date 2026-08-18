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
 * on another, opening the same dialog the drop opens.
 *
 * **Allow remote starts** is §5.2's home-edition entry and §13.2's "the same
 * toggle appears on the board card". It is the only place on the board a grant
 * can be *ended*: the launch flow's toggle grants and cannot take it back, so
 * without this the badge names a deadline the card cannot act on. Two controls
 * for one grant cannot disagree — both PUT the same idempotent route and both
 * repaint from `remote.agent.access.*` (§3.4).
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
import type { AgentView, RemoteGrantView } from '../api/types';
import { useServices } from '../app/AppContext';
import { useAppStore } from '../state/store';

export interface AgentCardMenuProps {
  readonly agentId: string;
  readonly agentName: string;
  /** An archived agent's actions are reduced to Restore/Export (§5.2). */
  readonly archived: boolean;
  /**
   * §5.2 marks **Allow remote starts** home-edition-only, so this is the
   * module's presence and not a grant's: in the work edition remote is not
   * loaded and the entry is absent rather than disabled, which is §13.5's rule
   * for a capability that does not exist.
   */
  readonly remoteAvailable: boolean;
  /** The live grant, or `undefined` when this agent has none (`GET /api/remote/agents`). */
  readonly grant: RemoteGrantView | undefined;
}

export function AgentCardMenu({
  agentId,
  agentName,
  archived,
  remoteAvailable,
  grant,
}: AgentCardMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const openLaunch = useAppStore((store) => store.openLaunch);
  const openPair = useAppStore((store) => store.openPair);
  const pushToast = useAppStore((store) => store.pushToast);
  const { client } = useServices();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const hostRef = useRef<HTMLDivElement>(null);

  // `GET /api/remote/agents` lists what is *currently allowed* — remote's
  // `grants.list` drops lapsed rows rather than reporting them disabled, and
  // every row it does return carries `enabled: true`. So presence is the state,
  // and an expiry that passed while the board sat open reads as "not granted"
  // here exactly as it does at the gate.
  const granted = grant !== undefined;

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

  /**
   * §13.2's toggle. `PUT …/access` is the same idempotent route settings uses,
   * so the two controls converge rather than race; the invalidation matches
   * `RemoteSection`'s so the badge clears without waiting for the event.
   */
  async function setRemoteAccess(enabled: boolean): Promise<void> {
    close();
    const result = await client.request(`/remote/agents/${encodeURIComponent(agentId)}/access`, {
      method: 'PUT',
      body: { enabled },
    });
    if (result.kind !== 'ok') {
      pushToast(result.message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.remoteAgents });
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
          {remoteAvailable ? (
            <li role="none">
              {/*
                A checkbox item, not two verbs: §13.2 calls this a toggle, and
                `aria-checked` is what tells a screen reader which way it is set
                without the label having to change under the user.
              */}
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={granted}
                className="card-menu__toggle"
                data-remote-toggle={agentId}
                // An archived agent cannot be launched, so a grant on one is a
                // deadline against nothing.
                disabled={archived}
                onClick={() => void setRemoteAccess(!granted)}
              >
                <span className="card-menu__mark" aria-hidden="true">
                  {granted ? '✓' : ''}
                </span>
                Allow remote starts
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
