/**
 * The launch flow (DESIGN §6) — agent × project × prompt, in under a minute.
 *
 * > "**The fast path is: drop, type, Enter.** Everything else is collapsed and
 * > pre-filled."
 *
 * That sentence is the whole design of this file. The prompt is autofocused,
 * `Enter` submits, and every other control is either pre-filled from the gesture
 * or inside a closed `<details>`. Reached three ways — a drop, the card `⋯`
 * menu, a project's **Launch an agent…** — and it is the *same* component every
 * time (§5.4), so there is no "mobile launch" to keep in step with a desktop one.
 *
 * Two things are never collapsed, and both are about privilege the user would
 * otherwise not see (§6):
 *
 * - the project's **elevation** with its mandatory reason;
 * - the same banner **disabled with the work-edition reason** when
 *   `policy.allowPermissionElevation` is false.
 *
 * Neither depends on roster's `/validate` — see `permissionPreview.ts` for why
 * that matters right now.
 *
 * Submit is `POST /api/assignments/solo` (orchestrator §16.7): orchestrator mints
 * the trivial assignment and starts the first session, and the UI navigates to
 * `/sessions/:id`. There is no second code path for "one agent".
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useProject, useProjects, useRoster, useWorkItems } from '../api/queries';
import type { ApiFailure } from '../api/result';
import {
  projectLaunchRefusal,
  type AgentView,
  type CreateSoloResult,
  type Project,
} from '../api/types';
import {
  useHasModule,
  useHasOrchestrator,
  usePermissionElevationPolicy,
  useServices,
} from '../app/AppContext';
import { workItemPromptSeed } from '../projects/workItems';
import { useAppStore, type LaunchIntent } from '../state/store';

import {
  elevationBanner,
  fetchPermissionPreview,
  type PermissionPreview,
} from './permissionPreview';

/** §6: "Role defaults to `implementer` where the agent declares it, else `capabilities.roles[0]`." */
export function defaultRole(agent: AgentView | undefined): string | undefined {
  const roles = agent?.definition.capabilities?.roles ?? [];
  if (roles.includes('implementer')) return 'implementer';
  return roles[0];
}

/** §6: "When the flow is opened from a project with `defaults.agentIds`, `agentIds[0]` is pre-selected." */
export function preselectedAgentId(
  intent: LaunchIntent,
  projectDefaults: readonly string[] | undefined,
): string | null {
  if (intent.agentId !== null) return intent.agentId;
  return projectDefaults?.[0] ?? null;
}

function launchableProjects(projects: readonly Project[]): readonly Project[] {
  return projects.filter((project) => projectLaunchRefusal(project) === undefined);
}

export interface LaunchFlowProps {
  readonly intent: LaunchIntent;
  readonly onClose: () => void;
}

export function LaunchFlow({ intent, onClose }: LaunchFlowProps): ReactElement {
  const { client } = useServices();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const roster = useRoster(client);
  const projects = useProjects(client);
  const hasOrchestrator = useHasOrchestrator();
  const hasRemote = useHasModule('remote');
  const policy = usePermissionElevationPolicy();

  const [projectId, setProjectId] = useState<string | null>(intent.projectId);
  const project = useProject(client, projectId);
  const projectDefaults = project.data?.defaults.agentIds;

  const [agentIdRaw, setAgentId] = useState<string | null>(intent.agentId);
  const agentId = agentIdRaw ?? preselectedAgentId(intent, projectDefaults);

  // §8.2 region 4 / §5.3 row 2: work items now have an HTTP surface, so the
  // Details multi-select is real and a dropped item arrives attached.
  const workItems = useWorkItems(client, projectId ?? '');
  const openItems = useMemo(
    () => (workItems.data?.workItems ?? []).filter((item) => item.status !== 'done'),
    [workItems.data],
  );
  const [selectedItems, setSelectedItems] = useState<readonly string[]>(intent.workItemIds ?? []);
  const attached = useMemo(
    () => openItems.filter((item) => selectedItems.includes(item.id)),
    [openItems, selectedItems],
  );

  const [prompt, setPrompt] = useState('');
  const [promptSeeded, setPromptSeeded] = useState(false);
  const [role, setRole] = useState<string | undefined>(undefined);
  const [write, setWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | undefined>();
  const [preview, setPreview] = useState<PermissionPreview | undefined>();

  const dialogRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const agents = useMemo(
    () => (roster.data?.agents ?? []).filter((agent) => agent.archivedAt === null),
    [roster.data],
  );
  const agent = agents.find((one) => one.definition.id === agentId);
  const options = useMemo(() => launchableProjects(projects.data?.projects ?? []), [projects.data]);

  // "…autofocused". The prompt is the only thing the fast path types into, so it
  // is where focus lands even when the pickers are still empty.
  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  /**
   * §5.3: a dropped work item seeds its `title` into the prompt.
   *
   * Once, and only while the field is untouched — the seed is a head start, not
   * a value the flow owns, and re-seeding over something the user typed would
   * lose their sentence the moment the item list refetched.
   */
  useEffect(() => {
    if (promptSeeded || prompt !== '') return;
    const seed = attached[0];
    if (seed === undefined) return;
    setPromptSeeded(true);
    setPrompt(workItemPromptSeed(seed));
  }, [attached, prompt, promptSeeded]);

  const effectiveRole = role ?? defaultRole(agent);

  const banner = elevationBanner(
    project.data?.defaults.permissionElevation,
    policy.allowed,
    policy.layer,
  );

  async function openPreview(): Promise<void> {
    if (agentId === null || projectId === null || preview !== undefined) return;
    setPreview(await fetchPermissionPreview(client, agentId, projectId));
  }

  async function submit(): Promise<void> {
    if (agentId === null || projectId === null || prompt.trim() === '' || busy) return;
    setBusy(true);
    setFailure(undefined);
    const result = await client.request<CreateSoloResult>('/assignments/solo', {
      method: 'POST',
      body: {
        projectId,
        agentId,
        prompt,
        ...(effectiveRole === undefined ? {} : { role: effectiveRole }),
        ...(write ? { write: true } : {}),
        // §8.2: the created assignment carries them, and projects flips each
        // linked item to `in_progress` server-side — the UI never sets a status
        // it does not own (§4).
        ...(selectedItems.length === 0 ? {} : { workItemIds: selectedItems }),
      },
    });
    setBusy(false);
    if (result.kind === 'ok') {
      // `['projects']` covers the list, the one project, its activity and its
      // work items — the last of which just changed status server-side.
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      onClose();
      navigate(`/sessions/${encodeURIComponent(result.value.sessionId)}`);
      return;
    }
    setFailure(result);
  }

  const ready = agentId !== null && projectId !== null && prompt.trim() !== '' && hasOrchestrator;

  return (
    <div
      className="dialog launch"
      role="dialog"
      aria-modal="true"
      aria-labelledby="launch-heading"
      ref={dialogRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <h2 id="launch-heading">Launch</h2>

      {hasOrchestrator ? null : (
        // §3.5: "there is no launch path at all without it… the board renders
        // with launch disabled and one explanatory banner."
        <p className="notice" data-tone="danger" role="alert">
          The orchestrator module is not running, so nothing can be launched. Every launch goes
          through it — AgentManager never starts a session directly.
        </p>
      )}

      <div className="launch__pickers">
        <label className="field">
          <span>Agent</span>
          <select
            aria-label="Agent"
            value={agentId ?? ''}
            onChange={(event) => setAgentId(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">Choose an agent…</option>
            {agents.map((one) => (
              <option key={one.definition.id} value={one.definition.id}>
                {one.definition.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>on</span>
          <select
            aria-label="Project"
            value={projectId ?? ''}
            onChange={(event) => {
              setProjectId(event.target.value === '' ? null : event.target.value);
              setPreview(undefined);
            }}
          >
            <option value="">Choose a project…</option>
            {options.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="field">
        <label htmlFor="launch-prompt">
          {agent === undefined
            ? 'What should the agent do?'
            : `What should ${agent.definition.name} do?`}
        </label>
        <textarea
          id="launch-prompt"
          ref={promptRef}
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            // "drop, type, Enter". Shift+Enter still writes a newline, because a
            // multi-line brief is a normal thing to want.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </div>

      <details className="launch__section">
        <summary>
          Details
          <span className="launch__summary-line">
            {` ${effectiveRole ?? 'no role'} · ${write ? 'write' : 'read only'} · ${
              attached.length === 0
                ? 'no work items'
                : `${String(attached.length)} work item${attached.length === 1 ? '' : 's'}`
            }`}
          </span>
        </summary>
        <label className="field">
          <span>Role</span>
          <select
            aria-label="Role"
            value={effectiveRole ?? ''}
            onChange={(event) =>
              setRole(event.target.value === '' ? undefined : event.target.value)
            }
          >
            <option value="">Let orchestrator decide</option>
            {(agent?.definition.capabilities?.roles ?? []).map((one) => (
              <option key={one} value={one}>
                {one}
              </option>
            ))}
          </select>
        </label>
        <label className="launch__toggle">
          <input
            type="checkbox"
            checked={write}
            onChange={(event) => setWrite(event.target.checked)}
          />
          Let this agent write to the project
        </label>
        {/* §6's third Details control: the multi-select over the project's open
            items. Empty is rendered as a sentence rather than an empty box. */}
        <fieldset className="launch__work-items">
          <legend>Work items</legend>
          {openItems.length === 0 ? (
            <p className="empty">This project has no open work items.</p>
          ) : (
            openItems.map((item) => (
              <label key={item.id} className="launch__toggle">
                <input
                  type="checkbox"
                  checked={selectedItems.includes(item.id)}
                  onChange={(event) =>
                    setSelectedItems((was) =>
                      event.target.checked
                        ? [...was, item.id]
                        : was.filter((one) => one !== item.id),
                    )
                  }
                />
                {item.title}
              </label>
            ))
          )}
        </fieldset>
      </details>

      {/*
        §5.3: "its `scopePaths` shown as a scope hint". Outside the collapsed
        Details, because a narrowed scope changes what the agent can touch and
        that is not a detail.
      */}
      {attached.length === 0 ? null : (
        <p className="launch__scope" data-work-items={attached.length}>
          Scoped to{' '}
          {attached.flatMap((item) => item.scopePaths).length === 0
            ? 'the whole project — the attached items name no paths'
            : [...new Set(attached.flatMap((item) => item.scopePaths))].join(', ')}
        </p>
      )}

      <details
        className="launch__section"
        onToggle={(event) => {
          if ((event.target as HTMLDetailsElement).open) void openPreview();
        }}
      >
        <summary>Permissions</summary>
        {preview === undefined ? (
          <p className="empty">Reading the effective permissions…</p>
        ) : preview.state === 'ready' ? (
          <dl className="launch__permissions">
            <dt>Mode</dt>
            <dd>{preview.effective.mode}</dd>
            <dt>Allow</dt>
            <dd>{preview.effective.allow.join(', ') || 'nothing beyond the defaults'}</dd>
            <dt>Deny</dt>
            <dd>{preview.effective.deny.join(', ') || 'nothing'}</dd>
            <dt>Ask</dt>
            <dd>{preview.effective.ask.join(', ') || 'nothing'}</dd>
          </dl>
        ) : (
          <p className="notice" data-tone="danger" role="alert">
            {preview.message}
          </p>
        )}
      </details>

      {/*
        §6: never collapsed. "Invisible privilege escalation is the failure mode
        this exists to prevent, so it is shown before launch and again in the
        session header."
      */}
      {banner.elevation === null ? null : (
        <div
          className="launch__elevation"
          data-permitted={banner.permitted ? 'true' : 'false'}
          role="note"
        >
          <strong>Elevated permissions</strong>
          <p>{banner.elevation.allow.join(', ')}</p>
          <p className="launch__reason">Reason: {banner.elevation.reason}</p>
          {banner.permitted ? null : (
            <p className="launch__reason">
              {banner.disabledReason}
              {banner.layer === null ? '' : ` — set by the ${banner.layer} layer`}
            </p>
          )}
        </div>
      )}

      {hasRemote ? (
        // §6's remote toggle. The remote module is feature-detected, never
        // 404-probed (§3.5, §13.5), so this is absent until the element ships
        // and absent in the work edition for the same reason.
        <label className="launch__toggle">
          <input type="checkbox" />
          Allow remote starts for {agent?.definition.name ?? 'this agent'}
        </label>
      ) : null}

      {failure === undefined ? null : (
        <p className="notice" data-tone="danger" role="alert" data-error-code={failure.code ?? ''}>
          {/* The server's message, verbatim (§3.1) — never a stack trace. */}
          {failure.message}
          {failure.kind === 'rate-limited' ? (
            <>
              {' '}
              <Link to="/usage">See the queue</Link>
            </>
          ) : null}
        </p>
      )}

      <div className="launch__actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button"
          data-variant="primary"
          disabled={!ready || busy}
          onClick={() => void submit()}
        >
          Launch ⏎
        </button>
      </div>
    </div>
  );
}

/** Mounted once at the app root; renders only while an intent is open. */
export function LaunchFlowHost(): ReactElement | null {
  const intent = useAppStore((store) => store.launch);
  const closeLaunch = useAppStore((store) => store.closeLaunch);
  if (intent === null) return null;
  return (
    <div className="dialog-scrim">
      <LaunchFlow intent={intent} onClose={closeLaunch} />
    </div>
  );
}
