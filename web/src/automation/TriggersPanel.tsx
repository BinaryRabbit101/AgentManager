/**
 * Background triggers, rendered (DESIGN §8.2 region 5 and §13.1's Automation
 * section; orchestrator §2.8, WO8).
 *
 * One component, two placements: the project page passes a `projectId` and gets
 * that project's schedules; settings → Automation passes none and gets every
 * one, with the project named on each row. Two components would be two answers
 * to "what does a trigger row say", and they would drift.
 *
 * Each row carries exactly what §2.8 pins: the template, the seats, the schedule,
 * an enabled toggle, the last run (linked to its assignment), the next fire, and
 * **the reason** when the last fire did not launch. That last one is the point of
 * the surface: an unattended feature whose refusals are invisible is an
 * unattended feature nobody trusts.
 *
 * **Nothing here polls** (§3.4, §16). `trigger.fired|skipped|blocked|disabled`
 * invalidate `['triggers']`, so an overnight run is on the screen the next time
 * it is looked at without a timer anywhere in this file.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { queryKeys, useTriggers } from '../api/queries';
import { failureOf } from '../api/result';
import type { Trigger, TriggerRunResult } from '../api/types';
import { useServices } from '../app/AppContext';
import { useAppStore } from '../state/store';

export interface TriggersPanelProps {
  /** Omit for the global list; pass one to scope the panel to a project page. */
  readonly projectId?: string;
  /** The heading id, so the surrounding `<section>` can label itself. */
  readonly headingId: string;
}

/** "every 60 minutes, 08:00–22:00" — the schedule as the owner stated it. */
export function scheduleLabel(trigger: Trigger): string {
  const every =
    trigger.everyMinutes % 60 === 0 && trigger.everyMinutes >= 60
      ? `every ${String(trigger.everyMinutes / 60)} hour${trigger.everyMinutes === 60 ? '' : 's'}`
      : `every ${String(trigger.everyMinutes)} minutes`;
  if (trigger.activeHours === null) return every;
  const pad = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;
  return `${every}, ${pad(trigger.activeHours.from)}–${pad(trigger.activeHours.to)}`;
}

/**
 * The one line that says why nothing is happening, or `null`.
 *
 * A `fired` outcome produces nothing: the last run itself is the answer, and a
 * chip that said "fired" beside a link to the assignment would be noise.
 */
export function outcomeNote(trigger: Trigger): string | null {
  if (!trigger.enabled) {
    return trigger.lastOutcome === 'disabled'
      ? `Switched itself off — ${trigger.lastOutcomeReason ?? 'repeated failures'}`
      : 'Switched off';
  }
  if (trigger.lastOutcome === 'blocked') {
    return `Did not run — ${trigger.lastOutcomeReason ?? 'preflight was not green'}`;
  }
  if (trigger.lastOutcome === 'skipped') {
    return `Skipped — ${trigger.lastOutcomeReason ?? 'not this time'}`;
  }
  return null;
}

/** An absolute instant as a short local time; the empty string for `null`. */
function when(iso: string | null): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString();
}

export function TriggersPanel({ projectId, headingId }: TriggersPanelProps): ReactElement {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const triggers = useTriggers(client, projectId);
  const pushToast = useAppStore((store) => store.pushToast);
  const [busy, setBusy] = useState<string | undefined>();

  const rows = triggers.data?.triggers ?? [];

  async function refresh(): Promise<void> {
    // Both keys, because the two placements read under different ones and a
    // change made on the project page is equally true in settings.
    await queryClient.invalidateQueries({ queryKey: queryKeys.triggers });
  }

  async function setEnabled(trigger: Trigger, enabled: boolean): Promise<void> {
    setBusy(trigger.id);
    const result = await client.request(`/triggers/${encodeURIComponent(trigger.id)}`, {
      method: 'PATCH',
      body: { enabled },
    });
    setBusy(undefined);
    if (result.kind !== 'ok') {
      pushToast(result.message);
      return;
    }
    await refresh();
  }

  async function runNow(trigger: Trigger): Promise<void> {
    setBusy(trigger.id);
    const result = await client.request<TriggerRunResult>(
      `/triggers/${encodeURIComponent(trigger.id)}/run`,
      { method: 'POST' },
    );
    setBusy(undefined);
    if (result.kind !== 'ok') {
      pushToast(result.message);
      return;
    }
    // A block or a skip is an answer, not a failure — say which, in the words
    // the server used, rather than a cheerful "started".
    pushToast(
      result.value.outcome === 'fired'
        ? 'The trigger started an assignment.'
        : `The trigger did not run — ${result.value.reason ?? result.value.outcome}.`,
    );
    await refresh();
  }

  if (triggers.isError) {
    return (
      <p className="notice" data-tone="danger" role="alert">
        {failureOf(triggers.error)?.message ?? 'The triggers could not be read.'}
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="empty">
        No background triggers{projectId === undefined ? '' : ' on this project'}. A trigger runs a
        task template on a schedule — it starts nothing until its preflight is green.
      </p>
    );
  }

  return (
    <ul aria-labelledby={headingId} className="triggers">
      {rows.map((trigger) => {
        const note = outcomeNote(trigger);
        return (
          <li key={trigger.id} data-trigger-id={trigger.id} data-enabled={String(trigger.enabled)}>
            <div className="triggers__head">
              <strong>{trigger.templateId}</strong>
              <span className="triggers__seats">{trigger.agentIds.join(', ')}</span>
              <span className="badge" data-status={trigger.enabled ? 'open' : 'closed'}>
                {scheduleLabel(trigger)}
              </span>
            </div>

            <dl className="triggers__facts">
              <div>
                <dt>Next fire</dt>
                <dd>{trigger.enabled ? when(trigger.nextFireAt) : '—'}</dd>
              </div>
              <div>
                <dt>Last run</dt>
                <dd>
                  {trigger.lastRun === null ? (
                    '—'
                  ) : (
                    <Link to={`/assignments/${trigger.lastRun.assignmentId}`}>
                      {when(trigger.lastRun.createdAt)}
                    </Link>
                  )}
                </dd>
              </div>
              <div>
                <dt>Runs today</dt>
                <dd>
                  {trigger.runsToday}
                  {trigger.maxRunsPerDay === null ? '' : ` / ${String(trigger.maxRunsPerDay)}`}
                </dd>
              </div>
              {projectId === undefined ? (
                <div>
                  <dt>Project</dt>
                  <dd>
                    <Link to={`/projects/${trigger.projectId}`}>{trigger.projectId}</Link>
                  </dd>
                </div>
              ) : null}
            </dl>

            {note === null ? null : (
              <p className="notice" data-tone={trigger.enabled ? 'warn' : 'danger'}>
                {note}
              </p>
            )}

            <div className="triggers__actions">
              <label className="field">
                <input
                  type="checkbox"
                  checked={trigger.enabled}
                  disabled={busy === trigger.id}
                  onChange={(event) => void setEnabled(trigger, event.target.checked)}
                />
                Enabled
              </label>
              <button
                type="button"
                className="button"
                disabled={busy === trigger.id}
                onClick={() => void runNow(trigger)}
              >
                Run now
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
