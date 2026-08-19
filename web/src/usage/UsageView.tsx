/**
 * The usage view (DESIGN §12; IMPLEMENTATION §10).
 *
 * Three panels, each labelled with its provenance, "because runner §7.4's
 * honesty contract is the whole point of the screen". The contract, restated so
 * it cannot be lost in a refactor:
 *
 * - **No percentage, no gauge, no "remaining", no "% of plan", no "quota".**
 *   These numbers are AgentManager's own metering; the plan window is not
 *   visible to this process and the screen must not imply otherwise. The
 *   acceptance test asserts the literal strings over the rendered output.
 * - **Tokens are the unit.** A dollar figure appears once, in the per-assignment
 *   table, under the label runner gives it — *estimated model cost* — and never
 *   as spend (§4, runner §7.3).
 *
 * `GET /api/runner/usage` is **runner's own M11** and is not served yet. That is
 * not a reason to draw an empty chart: when the request fails the first panel
 * says, in one sentence, that the windows are not being kept, which is true and
 * is not a zero. Everything else on this screen reads routes that exist.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { useAssignments, useRunnerQueue, useRunnerUsage } from '../api/queries';
import { failureOf } from '../api/result';
import { CAPACITY_MAX, CAPACITY_MIN, type QueueEntry, type RunnerQueue } from '../api/types';
import { useServices } from '../app/AppContext';
import {
  budgetLine,
  currentRound,
  formatTokens,
  phaseInFlight,
  phaseWord,
} from '../assignments/conversation';
import { CAPACITY_RAISE_REASON, canRaiseCapacity, isRemoteClient } from '../remote/access';
import { useAppStore } from '../state/store';

export function UsageView(): ReactElement {
  const { client } = useServices();
  const usage = useRunnerUsage(client);
  const queue = useRunnerQueue(client);
  const assignments = useAssignments(client);
  const remote = isRemoteClient(client);

  return (
    <section className="usage" aria-labelledby="usage-heading">
      <h2 id="usage-heading">Usage</h2>

      {/* Panel 1 — what AgentManager used. */}
      <section className="panel" aria-labelledby="usage-own">
        <h3 id="usage-own">What AgentManager used</h3>
        {usage.isPending ? (
          <p className="empty">Reading the windows…</p>
        ) : usage.isError || usage.data === undefined ? (
          <p className="empty" data-panel-state="unavailable">
            AgentManager is not keeping rolling usage windows yet, so there is nothing honest to
            show here — the sessions below are the live picture.{' '}
            {failureOf(usage.error)?.message ?? ''}
          </p>
        ) : (
          <>
            <p className="panel__provenance" data-source={usage.data.own.source}>
              {`Source: ${usage.data.own.source}`}
            </p>
            <dl className="usage__windows">
              {(
                [
                  ['Last 5 hours', usage.data.own.window5h],
                  ['Last 7 days', usage.data.own.window7d],
                ] as const
              ).map(([label, window]) => (
                <div key={label} className="usage__window">
                  <dt>{label}</dt>
                  <dd className="usage__number">
                    {`${formatTokens(window.inputTokens)} in · ${formatTokens(
                      window.outputTokens,
                    )} out`}
                  </dd>
                  <dd>{`${String(window.sessions)} session${window.sessions === 1 ? '' : 's'} since ${window.since}`}</dd>
                </div>
              ))}
            </dl>
            {/* The API's own disclaimer, in full (§12). */}
            <p className="panel__disclaimer">{usage.data.disclaimer}</p>
          </>
        )}
      </section>

      {/* Panel 2 — queue and rate limits. */}
      <QueuePanel queue={queue} remote={remote} />

      {/* Panel 3 — per-assignment spend, in tokens. */}
      <section className="panel" aria-labelledby="usage-assignments">
        <h3 id="usage-assignments">Open assignments</h3>
        <p className="panel__provenance">Source: orchestrator’s assignment records</p>
        {assignments.data === undefined || assignments.data.assignments.length === 0 ? (
          <p className="empty">Nothing is open.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Agents</th>
                  <th scope="col">Pattern</th>
                  <th scope="col">Phase</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Rounds</th>
                </tr>
              </thead>
              <tbody>
                {assignments.data.assignments.map((assignment) => (
                  <tr key={assignment.id} data-assignment-id={assignment.id}>
                    <td>
                      <Link to={`/assignments/${encodeURIComponent(assignment.id)}`}>
                        {assignment.members.map((member) => member.agentId).join(', ')}
                      </Link>
                    </td>
                    <td>{assignment.pattern}</td>
                    <td>{phaseWord(assignment.phase)}</td>
                    <td>{budgetLine(assignment.tokensUsed, assignment.tokenBudget).text}</td>
                    {/*
                      Rounds, counted the way the assignment header counts them:
                      the round in flight, not the last one finished (§10.2).
                    */}
                    <td data-round-in-flight={phaseInFlight(assignment) ? 'true' : 'false'}>
                      {assignment.roundCap === null
                        ? String(
                            currentRound(assignment.roundsUsed, null, phaseInFlight(assignment)),
                          )
                        : `${String(currentRound(assignment.roundsUsed, assignment.roundCap, phaseInFlight(assignment)))} of ${String(assignment.roundCap)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}

function QueuePanel({
  queue,
  remote,
}: {
  readonly queue: ReturnType<typeof useRunnerQueue>;
  readonly remote: boolean;
}): ReactElement {
  const { client } = useServices();
  const pushToast = useAppStore((store) => store.pushToast);
  const rateLimit = useAppStore((store) => store.rateLimit);
  const [busy, setBusy] = useState(false);
  const data: RunnerQueue | undefined = queue.data;
  const [capacity, setCapacity] = useState<number | null>(null);
  const shown = capacity ?? data?.capacity ?? CAPACITY_MIN;
  const mayRaise = canRaiseCapacity(remote);

  /**
   * The cool-down strip (§12 panel 2).
   *
   * `until` and `source` come from the `runner.ratelimited` event, which is the
   * only place `source` exists; the queue's `coolingUntil` is the same deadline
   * seen from the other side and is what a cold load has. Both are shown, and
   * the strip appears when either says so — "a queue that has silently stopped
   * moving is the worst failure mode for a background service".
   */
  const cooling = data?.cooling === true || rateLimit !== null;
  const until = rateLimit?.until ?? data?.coolingUntil ?? null;

  const entries: readonly QueueEntry[] = data?.entries ?? [];
  const blocked = useMemo(() => entries.filter((entry) => entry.blockedReason !== null), [entries]);

  async function setCap(next: number): Promise<void> {
    setBusy(true);
    const result = await client.request<{ maxConcurrent: number }>('/runner/capacity', {
      method: 'PUT',
      body: { maxConcurrent: next },
    });
    setBusy(false);
    if (result.kind !== 'ok') {
      pushToast(result.message);
      return;
    }
    setCapacity(result.value.maxConcurrent);
    await queue.refetch();
  }

  return (
    <section className="panel" aria-labelledby="usage-queue">
      <h3 id="usage-queue">Queue and rate limits</h3>
      <p className="panel__provenance">Source: runner’s scheduler</p>

      {cooling ? (
        <p className="notice cooldown" data-tone="warn" data-cooldown="true" role="status">
          <strong>
            {until === null
              ? 'Cooling down — admissions are paused.'
              : `Cooling until ${new Date(until).toLocaleTimeString()} — admissions are paused.`}
          </strong>{' '}
          {rateLimit === null ? null : (
            <span
              data-cooldown-source={rateLimit.source}
            >{`Observed via ${rateLimit.source}. ${rateLimit.hint}`}</span>
          )}
        </p>
      ) : null}

      {data === undefined ? (
        <p className="empty">Reading the queue…</p>
      ) : (
        <>
          <p>
            {`${String(data.running)} running · ${String(data.queued)} queued · ${String(
              data.blocked,
            )} blocked · cap ${String(data.capacity)}`}
          </p>

          <div className="field">
            <label htmlFor="usage-capacity">Concurrent sessions</label>
            <input
              id="usage-capacity"
              type="number"
              min={CAPACITY_MIN}
              max={CAPACITY_MAX}
              value={shown}
              disabled={busy}
              onChange={(event) => setCapacity(Number(event.target.value))}
            />
            <button
              type="button"
              className="button"
              disabled={busy || shown === data.capacity || (shown > data.capacity && !mayRaise)}
              title={shown > data.capacity && !mayRaise ? CAPACITY_RAISE_REASON : undefined}
              data-control="capacity"
              onClick={() => void setCap(shown)}
            >
              {shown > data.capacity ? 'Raise' : 'Lower'}
            </button>
            {mayRaise ? null : (
              // §13.4: shown disabled **with the reason**, never hidden and
              // never a raw 403 after the fact.
              <p className="settings__layer" data-reason="capacity-raise">
                {CAPACITY_RAISE_REASON}
              </p>
            )}
          </div>

          {entries.length === 0 ? (
            <p className="empty">Nothing is queued.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Session</th>
                    <th scope="col">Position</th>
                    <th scope="col">Priority</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr
                      key={entry.sessionId}
                      data-session-id={entry.sessionId}
                      data-blocked={entry.blockedReason === null ? 'false' : 'true'}
                    >
                      <td>
                        <Link to={`/sessions/${encodeURIComponent(entry.sessionId)}`}>
                          {entry.agentId}
                        </Link>
                      </td>
                      <td>{entry.position === null ? '—' : String(entry.position)}</td>
                      <td>{entry.priority}</td>
                      <td data-blocked-reason={entry.blockedReason ?? ''}>
                        {entry.blockedReason ?? entry.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {blocked.length === 0 ? null : (
            <p className="settings__layer">{`${String(blocked.length)} entr${
              blocked.length === 1 ? 'y is' : 'ies are'
            } blocked and will not start until the reason clears.`}</p>
          )}
        </>
      )}
    </section>
  );
}
