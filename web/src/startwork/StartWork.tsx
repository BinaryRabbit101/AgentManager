/**
 * **Start work** — the one flow (DESIGN §6; orchestrator §16.7, §16.9, §3.5).
 *
 * > Pick a project, pick one or more agents, describe the task, go.
 *
 * That sentence replaces two dialogs. Assigning agents to work is what this app
 * is *for*, and until now it was split between a solo "Launch an agent…" and a
 * "Start a pair…", reached differently from different screens, with drag-and-
 * drop as the only path to some of it — so the user had to choose the shape of
 * the collaboration before they had chosen the project, the people or the task.
 * Now the shape is the **last** question, and it is asked by the selection:
 *
 * | Selected | Offered (§6) |
 * |---|---|
 * | 1 | solo — `POST /api/assignments/solo`, exactly as before |
 * | 2 | **Adversarial pair** (§3.3) or **Independently** — two solos |
 * | 3+ | **Team** (an overseer lead, §3.5) or **Independently** — N solos |
 *
 * Four things are preserved from the flows this replaces, and each is a rule
 * about privilege or honesty rather than a convenience:
 *
 * - **The fast path is drop, type, Enter.** When the gesture named an agent and
 *   a project, the task box is autofocused and `Enter` starts (§6).
 * - **The elevation banner is never collapsed**, and renders *disabled with the
 *   work-edition reason* when policy forbids it (§6, §13.5). Invisible privilege
 *   escalation is the failure mode it exists to prevent.
 * - **A `409 remote_access_required` is not an error** (§13.4, remote §12.5):
 *   one question, one tap, and the original request is retried atomically.
 * - **Every server `warning` is surfaced before the assignment starts** (§10.4).
 *   `role_not_declared` and `lead_not_overseer` are warnings now, not refusals
 *   (owner decision 2026-08-18), so they render as advice beside an enabled
 *   **Start** — never as a blocker.
 *
 * Nobody is hidden. The agent list is the whole live roster, archived agents
 * excepted, with declared roles shown as a **hint**: "a dialog that hid the
 * agents which did not declare the seat's role would be the capability gate the
 * decision removed, moved into the UI" (§16-9).
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useFocusTrap } from '../a11y/focusTrap';
import {
  useAssignments,
  usePatterns,
  useProject,
  useProjects,
  useRoster,
  useWorkItems,
} from '../api/queries';
import type { ApiFailure } from '../api/result';
import type {
  AgentView,
  AssignmentWarning,
  CreateAssignmentResult,
  CreateSoloResult,
  GateSpec,
  PatternSummary,
} from '../api/types';
import {
  useHasModule,
  useHasOrchestrator,
  usePermissionElevationPolicy,
  useServices,
} from '../app/AppContext';
import { Avatar } from '../board/Avatar';
import {
  elevationBanner,
  fetchPermissionPreview,
  type PermissionPreview,
} from '../launch/permissionPreview';
import { workItemPromptSeed } from '../projects/workItems';
import { isRemoteClient } from '../remote/access';
import { useAppStore, type StartWorkIntent } from '../state/store';

import {
  declaredRoles,
  defaultRole,
  goalWithWorkers,
  launchableProjects,
  openAssignmentCounts,
  patternFor,
  patternRequest,
  preselectedAgentIds,
  rankForSeats,
  refusedProjects,
  scopePathList,
  seatMembers,
  soloRequest,
  startBlocker,
  teamworkFor,
  teamworkOptions,
  type Teamwork,
} from './model';

/** An agent's name for a prompt, falling back to its id (§5.2's deleted-agent rule). */
function nameFor(agents: readonly AgentView[], agentId: string): string {
  return agents.find((one) => one.definition.id === agentId)?.definition.name ?? agentId;
}

/** The one-line description of each shape, in the radio's own label (§15). */
const TEAMWORK_LABELS: Readonly<Record<Teamwork, string>> = {
  solo: 'On their own',
  pair: 'As an adversarial pair — one drafts, the other looks for the hole in it',
  independent: 'Independently — one assignment each, same brief',
  team: 'As a team — one leads, and splits the work into child assignments',
};

export interface StartWorkProps {
  readonly intent: StartWorkIntent;
  readonly onClose: () => void;
}

export function StartWork({ intent, onClose }: StartWorkProps): ReactElement {
  const { client } = useServices();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const hasOrchestrator = useHasOrchestrator();
  const hasRemote = useHasModule('remote');
  const policy = usePermissionElevationPolicy();

  const roster = useRoster(client);
  const projects = useProjects(client);
  const patterns = usePatterns(client, hasOrchestrator);
  // §10.4's "current open-assignment count", counted from the list the app
  // already reads for home and `/assignments` rather than from a new endpoint.
  const openAssignments = useAssignments(client, 'open');

  // --- 1. Project --------------------------------------------------------
  const [projectId, setProjectId] = useState<string>(intent.projectId ?? '');
  /** §6: the project step is *skipped* when the gesture carried one — and still changeable. */
  const [changingProject, setChangingProject] = useState(intent.projectId === null);
  const project = useProject(client, projectId === '' ? null : projectId);

  const launchable = useMemo(
    () => launchableProjects(projects.data?.projects ?? []),
    [projects.data],
  );
  const refused = useMemo(() => refusedProjects(projects.data?.projects ?? []), [projects.data]);

  // --- 2. Agents ---------------------------------------------------------
  const agents = useMemo(
    // §5.2: an archived agent cannot be launched, so it is the one exclusion —
    // and it is a fact about the agent's lifecycle, not about its capabilities.
    () => (roster.data?.agents ?? []).filter((agent) => agent.archivedAt === null),
    [roster.data],
  );
  const counts = useMemo(
    () => openAssignmentCounts(openAssignments.data?.assignments ?? []),
    [openAssignments.data],
  );

  const [selectedRaw, setSelected] = useState<readonly string[] | null>(
    intent.agentIds.length === 0 ? null : intent.agentIds,
  );
  // Until the user touches the list, the project's own `defaults.agentIds` fill
  // it in (projects §1.2) — a pre-fill, never a value this dialog owns.
  const selectedIds = selectedRaw ?? preselectedAgentIds(intent, project.data?.defaults.agentIds);
  /**
   * The same selection, resolved against the roster — for display and seating.
   *
   * **Ids are what the flow counts and submits**, never these. The roster is a
   * query, so for the first frame after a drop it has answered nothing, and a
   * count taken from the resolved list would read zero — which would disable
   * the Start button under a user who is already typing. §6's fast path is
   * "drop, type, Enter", and a race that eats the Enter is that path failing.
   */
  const selected = useMemo(
    () =>
      selectedIds.flatMap((id) => {
        const agent = agents.find((one) => one.definition.id === id);
        return agent === undefined ? [] : [agent];
      }),
    [agents, selectedIds],
  );
  const count = selectedIds.length;

  // --- 3. Task -----------------------------------------------------------
  const workItems = useWorkItems(client, projectId);
  const openItems = useMemo(
    () => (workItems.data?.workItems ?? []).filter((item) => item.status !== 'done'),
    [workItems.data],
  );
  const [selectedItems, setSelectedItems] = useState<readonly string[]>(intent.workItemIds ?? []);
  const attached = useMemo(
    () => openItems.filter((item) => selectedItems.includes(item.id)),
    [openItems, selectedItems],
  );

  const [task, setTask] = useState('');
  const [taskSeeded, setTaskSeeded] = useState(false);
  const [role, setRole] = useState<string | undefined>(undefined);
  const [write, setWrite] = useState(false);

  // --- 4. How they work --------------------------------------------------
  const [teamworkChoice, setTeamworkChoice] = useState<Teamwork | null>(null);
  const teamwork = teamworkFor(count, teamworkChoice);
  const options = teamworkOptions(count);
  const patternId = patternFor(teamwork);
  const pattern: PatternSummary | undefined = useMemo(
    () => (patterns.data?.patterns ?? []).find((one) => one.id === patternId),
    [patterns.data, patternId],
  );

  const [swapped, setSwapped] = useState(false);
  const [leadRaw, setLead] = useState<string | null>(null);
  const leadId =
    leadRaw !== null && selectedIds.includes(leadRaw) ? leadRaw : (selectedIds[0] ?? null);

  const [scopePaths, setScopePaths] = useState('');
  const [artifactPath, setArtifactPath] = useState('');
  const [roundCap, setRoundCap] = useState('');
  const [tokenBudget, setTokenBudget] = useState('');

  // --- submission --------------------------------------------------------
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | undefined>();
  const [preview, setPreview] = useState<PermissionPreview | undefined>();
  /** The agents a `409` named, or `undefined` while none has been refused. */
  const [grantPrompt, setGrantPrompt] = useState<readonly string[] | undefined>();
  const [allowRemote, setAllowRemote] = useState(false);
  /** A parked pattern assignment, awaiting its explicit **Start** (§10.4). */
  const [created, setCreated] = useState<CreateAssignmentResult | undefined>();
  /**
   * The solos that already exist, for the independent path's retry.
   *
   * A `409` names one request's agent, so a selection where one agent is granted
   * and another is not gets through partly. Retrying the whole selection would
   * launch the granted one twice, so the retry skips what already started.
   */
  const startedRef = useRef<Set<string>>(new Set());

  const dialogRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);

  // "…drop, type, Enter". The task is the only thing the fast path types into.
  useEffect(() => {
    taskRef.current?.focus();
  }, []);

  // §15: focus trapped here and restored to whatever opened the flow.
  useFocusTrap(dialogRef);

  /**
   * §5.3: a dropped work item seeds its `title` into the task.
   *
   * Once, and only while the field is untouched — the seed is a head start, not
   * a value the flow owns, and re-seeding over something the user typed would
   * lose their sentence the moment the item list refetched.
   */
  useEffect(() => {
    if (taskSeeded || task !== '') return;
    const seed = attached[0];
    if (seed === undefined) return;
    setTaskSeeded(true);
    setTask(workItemPromptSeed(seed));
  }, [attached, task, taskSeeded]);

  /**
   * The pattern's own defaults for the cap and the budget (§10.4).
   *
   * Seeded once per pattern, so switching between **pair** and **team** brings
   * each one's numbers — and the overseer's budget arrives as `''`, because
   * §7.2 gives it no default and the form must collect it: "a default cap on
   * work that creates more work is a number nobody agreed to".
   */
  const seededPattern = useRef<string | null>(null);
  useEffect(() => {
    if (pattern === undefined || seededPattern.current === pattern.id) return;
    seededPattern.current = pattern.id;
    setRoundCap(pattern.defaults.roundCap === null ? '' : String(pattern.defaults.roundCap));
    setTokenBudget(
      pattern.defaults.tokenBudget === null ? '' : String(pattern.defaults.tokenBudget),
    );
  }, [pattern]);

  /** The one selected id, for the solo-only controls — known before the roster is. */
  const soloAgentId = count === 1 ? selectedIds[0] : undefined;
  const soloAgent = selected.length === 1 ? selected[0] : undefined;
  const effectiveRole = role ?? defaultRole(soloAgent);
  const seated = useMemo(() => {
    const ranked = rankForSeats(pattern?.seats ?? [], selected);
    return swapped ? [...ranked].reverse() : ranked;
  }, [pattern, selected, swapped]);

  const banner = elevationBanner(
    project.data?.defaults.permissionElevation,
    policy.allowed,
    policy.layer,
  );

  const blocker = startBlocker({
    hasOrchestrator,
    projectId: projectId === '' ? null : projectId,
    agentCount: count,
    task,
    teamwork,
    tokenBudget,
    // Only the overseer: `validate.ts` refuses a budget-less `overseer` and
    // accepts a budget-less `pair`, and §10.4's "refuses nothing client-side
    // that the server would accept" is the rule this line keeps.
    requiresTokenBudget: teamwork === 'team',
  });

  async function openPreview(): Promise<void> {
    if (soloAgentId === undefined || projectId === '' || preview !== undefined) return;
    setPreview(await fetchPermissionPreview(client, soloAgentId, projectId));
  }

  /**
   * The solo submit — §6's, unchanged, run once per agent.
   *
   * One agent is a solo; N agents "independently" is N of exactly this call,
   * which is what makes the independent option cost no second code path
   * (§16.7: "there is no second code path for one agent").
   */
  async function startSolos(confirmRemoteAccess: boolean): Promise<void> {
    const targets = selectedIds.filter((id) => !startedRef.current.has(id));
    let firstSession: string | undefined;
    const warned: AssignmentWarning[] = [];

    for (const agentId of targets) {
      const agent = agents.find((one) => one.definition.id === agentId);
      const result = await client.request<CreateSoloResult>('/assignments/solo', {
        method: 'POST',
        body: soloRequest({
          projectId,
          agentId,
          prompt: task,
          // One agent takes the Options role the user may have chosen; N agents
          // each take their own default, because one picker cannot honestly
          // name a role for a list of different agents.
          role: count === 1 ? effectiveRole : defaultRole(agent),
          write,
          workItemIds: selectedItems,
          confirmRemoteAccess,
        }),
      });
      if (result.kind === 'grant-required') {
        setGrantPrompt(result.agentIds.length === 0 ? [agentId] : result.agentIds);
        return;
      }
      if (result.kind !== 'ok') {
        setFailure(result);
        return;
      }
      startedRef.current.add(agentId);
      warned.push(...result.value.warnings);
      firstSession ??= result.value.sessionId;
    }

    // `['projects']` covers the list, the one project, its activity and its
    // work items — the last of which just changed status server-side.
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
    // §10.4's warnings, for the path that has no review step: a solo starts
    // immediately by design, so its advice arrives as a toast rather than
    // silently. `role_not_declared` is the one that actually shows up here.
    for (const warning of warned) useAppStore.getState().pushToast(warning.message, 'info');
    onClose();
    if (firstSession !== undefined) {
      navigate(`/sessions/${encodeURIComponent(firstSession)}`);
    }
  }

  /**
   * The pattern submit — parked, warned about, then explicitly started (§10.4).
   *
   * `pair` seats the two selected agents by §3.3's roles; `overseer` seats
   * **one** member, the lead, because its workers are not seats of it at all —
   * they hold seats in the child assignments the lead mints (§3.5). The others
   * ride along in the goal as a suggestion, which the copy beside it says out
   * loud.
   */
  async function createPattern(confirmRemoteAccess: boolean): Promise<void> {
    if (pattern === undefined) return;
    const lead = selected.find((agent) => agent.definition.id === leadId) ?? selected[0];
    if (teamwork === 'team' && lead === undefined) return;

    const members =
      teamwork === 'team' && lead !== undefined
        ? seatMembers(pattern.seats, [lead])
        : seatMembers(pattern.seats, seated);
    const workers =
      teamwork === 'team'
        ? selected
            .filter((agent) => agent.definition.id !== lead?.definition.id)
            .map((agent) => ({ id: agent.definition.id, name: agent.definition.name }))
        : [];

    const result = await client.request<CreateAssignmentResult>('/assignments', {
      method: 'POST',
      body: patternRequest({
        projectId,
        pattern: pattern.id === 'overseer' ? 'overseer' : 'pair',
        members,
        goal: teamwork === 'team' ? goalWithWorkers(task, workers) : task,
        scopePaths: scopePathList(scopePaths),
        artifactPath,
        roundCap,
        tokenBudget,
        confirmRemoteAccess,
      }),
    });
    if (result.kind === 'grant-required') {
      setGrantPrompt(
        result.agentIds.length === 0 ? members.map((one) => one.agentId) : result.agentIds,
      );
      return;
    }
    if (result.kind !== 'ok') {
      setFailure(result);
      return;
    }
    setCreated(result.value);
    await queryClient.invalidateQueries({ queryKey: ['assignments'] });
  }

  /**
   * §6's submit, and §13.4's one extra tap.
   *
   * A `409 remote_access_required` is **not an error** (remote §12.5): the sheet
   * swaps to "Allow Priya to be started remotely?", one tap grants, and the
   * original request is retried automatically. `confirmRemoteAccess: true` is
   * remote §6.3's atomic form — grant and start in one call — so the retry is
   * one request rather than a grant followed by a race. The prompt is raised
   * **once**, from the `409` body's list, however many agents it names.
   */
  async function submit(confirmRemoteAccess = false): Promise<void> {
    if (blocker !== undefined || busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      if (patternId === null) await startSolos(confirmRemoteAccess);
      else await createPattern(confirmRemoteAccess);
    } finally {
      setBusy(false);
    }
  }

  async function start(assignmentId: string): Promise<void> {
    setBusy(true);
    const result = await client.request(
      `/assignments/${encodeURIComponent(assignmentId)}/advance`,
      { method: 'POST', body: {} },
    );
    setBusy(false);
    if (result.kind !== 'ok') {
      setFailure(result);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['assignments'] });
    onClose();
    navigate(`/assignments/${encodeURIComponent(assignmentId)}`);
  }

  const projectName =
    project.data?.name ??
    (projects.data?.projects ?? []).find((one) => one.id === projectId)?.name ??
    projectId;

  return (
    <div
      className="dialog startwork"
      role="dialog"
      aria-modal="true"
      aria-labelledby="startwork-heading"
      ref={dialogRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <h2 id="startwork-heading">Start work</h2>

      {hasOrchestrator ? null : (
        // §3.5: "there is no launch path at all without it… the board renders
        // with launch disabled and one explanatory banner."
        <p className="notice" data-tone="danger" role="alert">
          The orchestrator module is not running, so nothing can be started. Every launch goes
          through it — AgentManager never starts a session directly.
        </p>
      )}

      {created === undefined ? (
        <>
          {/* --- 1. Project ------------------------------------------------ */}
          <div className="startwork__step">
            <h3>Project</h3>
            {changingProject ? (
              <>
                <label className="field">
                  {/* The visible label is the only one: an `aria-label` beside
                      it would name the same control twice, which is one name
                      too many for anything that asks "the Project field". */}
                  <span>Project</span>
                  <select
                    value={projectId}
                    onChange={(event) => {
                      setProjectId(event.target.value);
                      setPreview(undefined);
                    }}
                  >
                    <option value="">Choose a project…</option>
                    {launchable.map((one) => (
                      <option key={one.id} value={one.id}>
                        {one.name}
                      </option>
                    ))}
                  </select>
                </label>
                {/*
                  §5.3: an unlaunchable project "dims and its tooltip says why".
                  Off the drag surface the same rule is a sentence: shown with
                  the reason, never quietly missing from the list.
                */}
                {refused.length === 0 ? null : (
                  <ul className="startwork__refusals">
                    {refused.map((entry) => (
                      <li key={entry.project.id} data-project-id={entry.project.id}>
                        {entry.project.name} can’t be started on: {entry.refusal}.
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="startwork__chosen">
                <span data-project-id={projectId}>{projectName}</span>{' '}
                <button
                  type="button"
                  className="button"
                  data-variant="quiet"
                  onClick={() => setChangingProject(true)}
                >
                  Change project
                </button>
              </p>
            )}
          </div>

          {/* --- 2. Agents ------------------------------------------------- */}
          <fieldset className="startwork__step startwork__agents">
            <legend>Who works on it</legend>
            {agents.length === 0 ? (
              <p className="empty">
                No agents yet — describe someone in a sentence and Claude will draft them.
              </p>
            ) : (
              <ul className="startwork__roster">
                {agents.map((agent) => {
                  const id = agent.definition.id;
                  const roles = declaredRoles(agent);
                  const open = counts.get(id) ?? 0;
                  const hint =
                    roles.length === 0 ? 'no declared roles' : `suits ${roles.join(', ')}`;
                  return (
                    <li key={id} data-agent-id={id}>
                      <label className="startwork__agent">
                        {/*
                          A checkbox per agent: the multi-select §15 asks for
                          without a listbox nobody can drive from a keyboard, and
                          a 44px row on a coarse pointer.

                          The `aria-label` says the same three things the row
                          shows, in a fixed order beginning with the name. The
                          wrapping label would otherwise name the box by whatever
                          the avatar happened to contribute first, which is not a
                          name a screen-reader user can predict — and which two
                          agents whose taglines both mention a third would make
                          ambiguous.
                        */}
                        <input
                          type="checkbox"
                          aria-label={`${agent.definition.name} — ${String(open)} open · ${hint}`}
                          checked={selectedIds.includes(id)}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? [...selectedIds, id]
                                : selectedIds.filter((one) => one !== id),
                            )
                          }
                        />
                        <Avatar
                          agentId={id}
                          name={agent.definition.name}
                          avatar={agent.definition.avatar}
                        />
                        <span className="startwork__agent-name">{agent.definition.name}</span>
                        <span className="startwork__agent-meta">
                          {agent.definition.tagline ?? agent.definition.specialty}
                        </span>
                        <span className="badge" data-open-assignments={open}>
                          {open} open
                        </span>
                        {/*
                          The hint, and only ever a hint (§16-9, owner decision
                          2026-08-18): declared roles rank a suggestion, they
                          never remove a row or disable a box.
                        */}
                        <span className="startwork__agent-roles" data-roles={roles.join(' ')}>
                          {hint}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>

          {/* --- 3. Task --------------------------------------------------- */}
          <div className="startwork__step">
            <h3>The task</h3>
            <div className="field">
              <label htmlFor="startwork-task">
                {count === 1 && soloAgent !== undefined
                  ? `What should ${soloAgent.definition.name} do?`
                  : 'What should they do?'}
              </label>
              <textarea
                id="startwork-task"
                ref={taskRef}
                rows={3}
                value={task}
                onChange={(event) => setTask(event.target.value)}
                onKeyDown={(event) => {
                  // "drop, type, Enter". Shift+Enter still writes a newline,
                  // because a multi-line brief is a normal thing to want.
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            </div>

            <details className="launch__section startwork__options">
              <summary>
                Options
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
                  {(soloAgent?.definition.capabilities?.roles ?? []).map((one) => (
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
                Let them write to the project
              </label>
              {/* §6's work-item multi-select over the project's open items. */}
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
              §5.3: "its `scopePaths` shown as a scope hint". Outside the
              collapsed options, because a narrowed scope changes what the agent
              can touch and that is not a detail.
            */}
            {attached.length === 0 ? null : (
              <p className="launch__scope" data-work-items={attached.length}>
                Scoped to{' '}
                {attached.flatMap((item) => item.scopePaths).length === 0
                  ? 'the whole project — the attached items name no paths'
                  : [...new Set(attached.flatMap((item) => item.scopePaths))].join(', ')}
              </p>
            )}
          </div>

          {/* --- 4. How they work ------------------------------------------ */}
          <fieldset className="startwork__step startwork__teamwork" data-teamwork={teamwork}>
            <legend>How they work</legend>
            {count === 0 ? (
              <p className="empty">Pick at least one agent above.</p>
            ) : count === 1 ? (
              <p className="startwork__note">
                One agent, on their own. This starts a session straight away.
              </p>
            ) : (
              options.map((option) => (
                <label key={option} className="launch__toggle">
                  <input
                    type="radio"
                    name="startwork-teamwork"
                    value={option}
                    checked={teamwork === option}
                    onChange={() => setTeamworkChoice(option)}
                  />
                  {TEAMWORK_LABELS[option]}
                </label>
              ))
            )}

            {teamwork === 'pair' && seated.length === 2 ? (
              <p className="startwork__note" data-seats="pair">
                {`${seated[0]?.definition.name ?? '?'} drafts · ${
                  seated[1]?.definition.name ?? '?'
                } reviews.`}{' '}
                <button
                  type="button"
                  className="button"
                  data-variant="quiet"
                  onClick={() => setSwapped((was) => !was)}
                >
                  Swap seats
                </button>
              </p>
            ) : null}

            {teamwork === 'team' ? (
              <>
                <label className="field">
                  <span>Lead</span>
                  <select
                    aria-label="Lead"
                    value={leadId ?? ''}
                    onChange={(event) => setLead(event.target.value)}
                  >
                    {selected.map((agent) => (
                      <option key={agent.definition.id} value={agent.definition.id}>
                        {agent.definition.name}
                      </option>
                    ))}
                  </select>
                </label>
                {/*
                  orchestrator §3.5: the workers are **not** seats of this
                  assignment — they hold seats in the children the lead mints —
                  so the others ride in the goal as a preference. Saying that out
                  loud is the whole point of this sentence: the lead has
                  `list_roster` and decides.
                */}
                <p className="startwork__note" data-workers="suggested">
                  The others are suggestions — the lead decides the final split, and mints a child
                  assignment for each piece of work.
                </p>
              </>
            ) : null}

            {/* The pattern's own required fields, driven by `GET /api/patterns`. */}
            {pattern === undefined ? null : (
              <div className="startwork__pattern-fields">
                <label className="field">
                  <span>Scope paths (comma separated)</span>
                  <input
                    value={scopePaths}
                    onChange={(event) => setScopePaths(event.target.value)}
                  />
                </label>
                {pattern.requires.artifactPath ? (
                  <label className="field">
                    <span>Artifact path (required by this pattern)</span>
                    <input
                      value={artifactPath}
                      onChange={(event) => setArtifactPath(event.target.value)}
                      required
                    />
                  </label>
                ) : null}
                <label className="field">
                  <span>
                    Round cap
                    {pattern.maxRoundCap === null ? '' : ` (max ${String(pattern.maxRoundCap)})`}
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={roundCap}
                    onChange={(event) => setRoundCap(event.target.value)}
                  />
                </label>
                <label className="field">
                  {/* Tokens. §16.8 pins the unit and this dialog does not convert it. */}
                  <span>
                    Token budget
                    {teamwork === 'team' ? ' (required — a team has no default)' : ''}
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={tokenBudget}
                    onChange={(event) => setTokenBudget(event.target.value)}
                    required={teamwork === 'team'}
                  />
                </label>
              </div>
            )}
          </fieldset>

          {/* --- privilege, never collapsed (§6) --------------------------- */}
          {soloAgentId === undefined ? null : (
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
          )}

          {/*
            §6: never collapsed. "Invisible privilege escalation is the failure
            mode this exists to prevent, so it is shown before launch and again
            in the session header."
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

          {hasRemote && count > 0 ? (
            // §6's remote toggle. The remote module is feature-detected, never
            // 404-probed (§3.5, §13.5), so this is absent in the work edition.
            //
            // At the desk it pre-authorises by calling `PUT /api/remote/agents/
            // :id/access` for every selected agent; over the tailnet it rides
            // the start as `confirmRemoteAccess` instead, which is the same
            // grant made atomically (remote §6.3).
            <label className="launch__toggle">
              <input
                type="checkbox"
                checked={allowRemote}
                data-control="allow-remote"
                onChange={(event) => {
                  setAllowRemote(event.target.checked);
                  if (!event.target.checked || isRemoteClient(client)) return;
                  for (const agentId of selectedIds) {
                    void client.request(`/remote/agents/${encodeURIComponent(agentId)}/access`, {
                      method: 'PUT',
                      body: { enabled: true },
                    });
                  }
                }}
              />
              {`Allow remote starts for ${selectedIds
                .map((id) => nameFor(agents, id))
                .join(' and ')}`}
            </label>
          ) : null}

          {/*
            §13.4: "May need one extra tap: `409` → grant prompt → automatic
            retry. **Never presented as an error.**" So this is not the failure
            notice — it is a question, asked once, listing every agent named.
          */}
          {grantPrompt === undefined ? null : (
            <div className="notice" data-tone="info" data-grant-prompt="true" role="note">
              <p>
                {`Allow ${grantPrompt
                  .map((one) => nameFor(agents, one))
                  .join(' and ')} to be started remotely?`}
              </p>
              <button
                type="button"
                className="button"
                data-variant="primary"
                disabled={busy}
                onClick={() => {
                  setGrantPrompt(undefined);
                  void submit(true);
                }}
              >
                {patternId === null ? 'Allow and start' : 'Allow and continue'}
              </button>
            </div>
          )}

          {failure === undefined ? null : (
            <p
              className="notice"
              data-tone="danger"
              role="alert"
              data-error-code={failure.code ?? ''}
            >
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
            {/* The reason the button is off, in words, rather than a mystery. */}
            {blocker === undefined ? null : (
              <p className="startwork__blocker" data-blocker="true">
                {blocker}
              </p>
            )}
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="button"
              data-variant="primary"
              disabled={blocker !== undefined || busy}
              onClick={() => void submit()}
            >
              {patternId === null ? 'Start work ⏎' : 'Review'}
            </button>
          </div>
        </>
      ) : (
        <ReviewStep
          created={created}
          busy={busy}
          onCancel={onClose}
          onStart={() => void start(created.assignmentId)}
        />
      )}
    </div>
  );
}

/**
 * Step two of a pattern start: every warning the server returned, then Start.
 *
 * The warnings are **advisory** (§10.4, owner decision 2026-08-18):
 * `role_not_declared` and `lead_not_overseer` say what the seating costs, not
 * that it is refused, so **Start** stays enabled beside them. A returned `gate`
 * is the one thing that removes it — the assignment is waiting for an approval
 * the user gives in the inbox, and offering to start it here would be the "it's
 * running" impression the criterion forbids.
 */
function ReviewStep({
  created,
  busy,
  onCancel,
  onStart,
}: {
  readonly created: CreateAssignmentResult;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onStart: () => void;
}): ReactElement {
  const gate: GateSpec | undefined = created.gate;
  return (
    <div className="pattern-create__review">
      <p data-created={created.assignmentId}>
        {`Created and parked — nothing has started. Phase: ${created.phase}.`}
      </p>

      {created.warnings.length === 0 ? (
        <p className="empty">No warnings.</p>
      ) : (
        <>
          <p className="startwork__note">
            Worth knowing before you start — none of these stops it:
          </p>
          <ul className="pattern-create__warnings" data-advisory="true">
            {created.warnings.map((warning: AssignmentWarning) => (
              <li
                key={warning.code}
                className="notice"
                data-tone="warn"
                data-warning={warning.code}
              >
                {warning.message}
              </li>
            ))}
          </ul>
        </>
      )}

      {gate === undefined ? null : (
        <p className="notice" data-tone="warn" data-gate="true" role="note">
          Waiting for your approval — {gate.reason}.{' '}
          <Link
            to={
              gate.questionId === undefined
                ? '/questions'
                : `/questions/${encodeURIComponent(gate.questionId)}`
            }
          >
            Open the card
          </Link>
        </p>
      )}

      <div className="launch__actions">
        <button type="button" className="button" onClick={onCancel}>
          Close
        </button>
        <Link className="button" to={`/assignments/${encodeURIComponent(created.assignmentId)}`}>
          Open the assignment
        </Link>
        {gate === undefined ? (
          <button
            type="button"
            className="button"
            data-variant="primary"
            disabled={busy}
            onClick={onStart}
          >
            Start
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Mounted once at the app root; renders only while an intent is open.
 *
 * One host, because there is one flow. It sits above every route so that
 * opening it from a project card survives the navigation that card would
 * otherwise cause (§5.4, §6).
 */
export function StartWorkHost(): ReactElement | null {
  const intent = useAppStore((store) => store.startWork);
  const close = useAppStore((store) => store.closeStartWork);
  if (intent === null) return null;
  return (
    <div className="dialog-scrim">
      <StartWork intent={intent} onClose={close} />
    </div>
  );
}
