/**
 * The pattern create dialog (DESIGN §10.4; IMPLEMENTATION §9).
 *
 * > "Driven **entirely** by `GET /api/patterns` (orchestrator §16.9): seats,
 * > allowed roles per seat, defaults, `preferredTier`."
 *
 * Nothing about a pattern is hardcoded here — not the seat names, not which
 * fields are required, not the round cap ceiling. A pattern the server adds
 * later renders without a change to this file, and a pattern that stops
 * requiring an artifact stops requiring it here on the next request.
 *
 * **Two steps, and the reason is the acceptance criterion**: "surfaces every
 * server `warning` before the user confirms". The warnings (`scope_overlap`,
 * `projection_exceeds_budget`) are computed *by the server, from the members
 * and scope*, so there is no honest way to show them before asking. So the
 * first submit posts `autoStart: false` — orchestrator mints the assignment and
 * parks it at `planned` without running a turn — the warnings and any `gate`
 * are shown, and only an explicit **Start** advances it. Nothing has run when
 * the warnings appear, which is exactly what "before the user confirms" has to
 * mean against an API that computes them from the created row.
 *
 * A returned `gate` ends the flow: no Start button, one sentence, and a link to
 * the card. §10.4: "a returned `gate` renders as 'waiting for your approval'",
 * and IMPLEMENTATION §9 makes "prevents any 'it's running' impression" the test.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useFocusTrap } from '../a11y/focusTrap';
import { useProjects, usePatterns, useRoster } from '../api/queries';
import type { ApiFailure } from '../api/result';
import {
  projectLaunchRefusal,
  type AgentView,
  type AssignmentWarning,
  type CreateAssignmentResult,
  type GateSpec,
  type PatternSummary,
  type SeatCandidate,
} from '../api/types';
import { useHasOrchestrator, useServices } from '../app/AppContext';
import { useAppStore, type PairIntent } from '../state/store';

/** The seat → agent choice being assembled. Roles come from the pattern's seat. */
type SeatChoice = Readonly<Record<string, { readonly agentId: string; readonly role: string }>>;

/**
 * §10.4: every agent is a candidate for every seat; declared roles **rank**.
 *
 * Owner decision (2026-08-18): capabilities are hints, never gates — who works
 * together is the user's call, and a picker that hides agents is a gate wearing
 * a dropdown. The server sends `candidates` per seat when it can read the
 * roster; when it cannot, the roster the board already has is offered whole,
 * with the agents that declare a matching role listed first — the same ranking
 * the server applies, rather than an empty or a narrowed picker.
 */
export function candidatesFor(
  pattern: PatternSummary,
  seatKey: string,
  agents: readonly AgentView[],
): readonly SeatCandidate[] {
  const fromServer = pattern.candidates?.[seatKey];
  if (fromServer !== undefined) return fromServer;
  const seat = pattern.seats.find((one) => one.key === seatKey);
  const roles = seat?.roles ?? [];
  const declares = (agent: AgentView): boolean =>
    (agent.definition.capabilities?.roles ?? []).some((role) => roles.includes(role));
  return agents
    .filter((agent) => agent.archivedAt === null)
    // A stable partition, not a sort: role-matchers first, roster order kept
    // inside each half, so nothing here invents an order the server did not.
    .filter(declares)
    .concat(agents.filter((agent) => agent.archivedAt === null && !declares(agent)))
    .map((agent) => ({
      agentId: agent.definition.id,
      name: agent.definition.name,
      roles: agent.definition.capabilities?.roles ?? [],
      openAssignments: 0,
      available: true,
    }));
}

/** The first role the agent declares that this seat allows — the server's rule. */
export function roleForSeat(
  seatRoles: readonly string[],
  agentRoles: readonly string[],
): string | undefined {
  return agentRoles.find((role) => seatRoles.includes(role)) ?? seatRoles[0];
}

export interface PatternCreateDialogProps {
  readonly intent: PairIntent;
  readonly onClose: () => void;
}

export function PatternCreateDialog({ intent, onClose }: PatternCreateDialogProps): ReactElement {
  const { client } = useServices();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const hasOrchestrator = useHasOrchestrator();
  const patterns = usePatterns(client, hasOrchestrator);
  const roster = useRoster(client);
  const projects = useProjects(client);

  const [patternId, setPatternId] = useState(intent.patternId ?? 'pair');
  const pattern = useMemo(
    () => (patterns.data?.patterns ?? []).find((one) => one.id === patternId),
    [patterns.data, patternId],
  );

  const agents = useMemo(() => roster.data?.agents ?? [], [roster.data]);
  const launchable = useMemo(
    () => (projects.data?.projects ?? []).filter((one) => projectLaunchRefusal(one) === undefined),
    [projects.data],
  );

  const [projectId, setProjectId] = useState<string>(intent.projectId ?? '');
  const [seats, setSeats] = useState<SeatChoice>({});
  const [goal, setGoal] = useState('');
  const [scopePaths, setScopePaths] = useState('');
  const [artifactPath, setArtifactPath] = useState('');
  const [roundCap, setRoundCap] = useState('');
  const [tokenBudget, setTokenBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | undefined>();
  const [created, setCreated] = useState<CreateAssignmentResult | undefined>();
  /** The agents a `409` named — one prompt for the whole list (§13.4). */
  const [grantPrompt, setGrantPrompt] = useState<readonly string[] | undefined>();

  const goalRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    goalRef.current?.focus();
  }, []);
  // §15: trapped while it is open, restored to the card that opened it.
  useFocusTrap(dialogRef);

  /**
   * Seat pre-fill from the drag (§5.3): "the dragged agent in the drafting seat
   * and the target in the critic seat", plus the pattern's own defaults for the
   * cap and the budget. Runs when the pattern arrives, and never again — it is a
   * pre-fill, not a value the dialog owns.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (pattern === undefined || seeded.current) return;
    seeded.current = true;
    const dragged = [intent.agentId, intent.withAgentId].filter(
      (one): one is string => one !== null && one !== undefined,
    );
    const next: Record<string, { agentId: string; role: string }> = {};
    pattern.seats.forEach((seat, index) => {
      const agentId = dragged[index];
      if (agentId === undefined) return;
      const declared = agents.find((agent) => agent.definition.id === agentId);
      const role = roleForSeat(seat.roles, declared?.definition.capabilities?.roles ?? []);
      if (role === undefined) return;
      next[seat.key] = { agentId, role };
    });
    setSeats(next);
    setRoundCap(pattern.defaults.roundCap === null ? '' : String(pattern.defaults.roundCap));
    setTokenBudget(
      pattern.defaults.tokenBudget === null ? '' : String(pattern.defaults.tokenBudget),
    );
  }, [agents, intent.agentId, intent.withAgentId, pattern]);

  /**
   * §13.4's extra tap, for the two-seat case.
   *
   * IMPLEMENTATION §10: "a pattern launch with two ungranted agents prompts
   * **once** from the `409` body's list, not twice." That is a property of the
   * *body*, not of the loop: remote's gate names every ungranted agent in one
   * refusal, so one refusal is one prompt however many seats it covers.
   */
  async function create(confirmRemoteAccess = false): Promise<void> {
    if (pattern === undefined || busy) return;
    setBusy(true);
    setFailure(undefined);
    const members = pattern.seats
      .map((seat) => seats[seat.key])
      .filter((choice): choice is { agentId: string; role: string } => choice !== undefined)
      .map((choice) => ({ agentId: choice.agentId, role: choice.role }));
    const paths = scopePaths
      .split(',')
      .map((path) => path.trim())
      .filter((path) => path !== '');
    const result = await client.request<CreateAssignmentResult>('/assignments', {
      method: 'POST',
      body: {
        projectId,
        pattern: pattern.id,
        members,
        ...(goal === '' ? {} : { goal }),
        scope: {
          paths,
          ...(artifactPath === '' ? {} : { artifactPath }),
        },
        ...(roundCap === '' ? {} : { roundCap: Number(roundCap) }),
        ...(tokenBudget === '' ? {} : { tokenBudget: Number(tokenBudget) }),
        // The whole point of step one: created, warned about, not started.
        autoStart: false,
        ...(confirmRemoteAccess ? { confirmRemoteAccess: true } : {}),
      },
    });
    setBusy(false);
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

  async function start(assignmentId: string): Promise<void> {
    setBusy(true);
    const result = await client.request(
      `/assignments/${encodeURIComponent(assignmentId)}/advance`,
      {
        method: 'POST',
        body: {},
      },
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

  return (
    <div
      className="dialog pattern-create"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pattern-heading"
      ref={dialogRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <h2 id="pattern-heading">Start a pair</h2>

      {hasOrchestrator ? null : (
        <p className="notice" data-tone="danger" role="alert">
          The orchestrator module is not running, so no assignment can be created.
        </p>
      )}

      {created === undefined ? (
        <>
          <div className="field">
            <label htmlFor="pattern-pattern">Pattern</label>
            <select
              id="pattern-pattern"
              value={patternId}
              onChange={(event) => {
                seeded.current = false;
                setPatternId(event.target.value);
              }}
            >
              {(patterns.data?.patterns ?? []).map((one) => (
                <option key={one.id} value={one.id}>
                  {one.id}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="pattern-project">Project</label>
            <select
              id="pattern-project"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Choose a project…</option>
              {launchable.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </select>
          </div>

          {(pattern?.seats ?? []).map((seat) => {
            const chosen = seats[seat.key];
            return (
              <fieldset key={seat.key} className="pattern-create__seat" data-seat={seat.key}>
                <legend>
                  {seat.key}
                  <span className="pattern-create__roles">{` · ${seat.roles.join(' / ')}`}</span>
                  {seat.preferredTier === undefined ? null : (
                    <span className="pattern-create__tier">{` · prefers ${seat.preferredTier}`}</span>
                  )}
                </legend>
                <div className="field">
                  {/* The accessible name is the `aria-label`; a visible label
                      would repeat the legend a screen reader already read. */}
                  <select
                    aria-label={`${seat.key} agent`}
                    value={chosen?.agentId ?? ''}
                    onChange={(event) => {
                      const agentId = event.target.value;
                      const declared = agents.find((agent) => agent.definition.id === agentId);
                      const role = roleForSeat(
                        seat.roles,
                        declared?.definition.capabilities?.roles ?? [],
                      );
                      setSeats((was) => {
                        if (agentId === '' || role === undefined) {
                          const { [seat.key]: _dropped, ...rest } = was;
                          return rest;
                        }
                        return { ...was, [seat.key]: { agentId, role } };
                      });
                    }}
                  >
                    <option value="">Choose an agent…</option>
                    {(pattern === undefined ? [] : candidatesFor(pattern, seat.key, agents)).map(
                      (candidate) => (
                        <option key={candidate.agentId} value={candidate.agentId}>
                          {`${candidate.name} — ${String(candidate.openAssignments)} open`}
                        </option>
                      ),
                    )}
                  </select>
                </div>
              </fieldset>
            );
          })}

          <label className="field">
            <span>Goal</span>
            <input ref={goalRef} value={goal} onChange={(event) => setGoal(event.target.value)} />
          </label>
          <label className="field">
            <span>Scope paths (comma separated)</span>
            <input value={scopePaths} onChange={(event) => setScopePaths(event.target.value)} />
          </label>
          <label className="field">
            <span>
              Artifact path
              {pattern?.requires.artifactPath === true ? ' (required by this pattern)' : ''}
            </span>
            <input
              value={artifactPath}
              onChange={(event) => setArtifactPath(event.target.value)}
              required={pattern?.requires.artifactPath === true}
            />
          </label>
          <label className="field">
            <span>
              Round cap
              {pattern?.maxRoundCap === null || pattern?.maxRoundCap === undefined
                ? ''
                : ` (max ${String(pattern.maxRoundCap)})`}
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
            <span>Token budget</span>
            <input
              type="number"
              min={1}
              value={tokenBudget}
              onChange={(event) => setTokenBudget(event.target.value)}
            />
          </label>

          {failure === undefined ? null : (
            <p className="notice" data-tone="danger" role="alert">
              {failure.message}
            </p>
          )}

          {/* Never presented as an error (§13.4) — one question, one tap. */}
          {grantPrompt === undefined ? null : (
            <div className="notice" data-tone="info" data-grant-prompt="true" role="note">
              <p>
                {`Allow ${grantPrompt
                  .map(
                    (id) =>
                      agents.find((agent) => agent.definition.id === id)?.definition.name ?? id,
                  )
                  .join(' and ')} to be started remotely?`}
              </p>
              <button
                type="button"
                className="button"
                data-variant="primary"
                disabled={busy}
                onClick={() => {
                  setGrantPrompt(undefined);
                  void create(true);
                }}
              >
                Allow and continue
              </button>
            </div>
          )}

          <div className="launch__actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="button"
              data-variant="primary"
              disabled={busy || !hasOrchestrator}
              onClick={() => void create()}
            >
              Review
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
 * Step two: every warning the server returned, then an explicit Start.
 *
 * When a `gate` came back there is **no** Start button at all — the assignment
 * is waiting for an approval the user has to give in the inbox, and offering to
 * start it here would be the "it's running" impression the criterion forbids.
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
        <ul className="pattern-create__warnings">
          {created.warnings.map((warning: AssignmentWarning) => (
            <li key={warning.code} className="notice" data-tone="warn" data-warning={warning.code}>
              {warning.message}
            </li>
          ))}
        </ul>
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

/** Mounted once at the app root, like the launch flow, for the same reason. */
export function PatternCreateHost(): ReactElement | null {
  const intent = useAppStore((store) => store.pair);
  const closePair = useAppStore((store) => store.closePair);
  if (intent === null) return null;
  return (
    <div className="dialog-scrim">
      <PatternCreateDialog intent={intent} onClose={closePair} />
    </div>
  );
}
