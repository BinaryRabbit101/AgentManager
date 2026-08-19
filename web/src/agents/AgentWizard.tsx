/**
 * The agent wizard (DESIGN §7.1) — describe → draft → review, inside a minute.
 *
 * Three steps and one hard number: "**Under a minute** from clicking New agent to
 * a saved card on the board … with a one-sentence description and no edits."
 * Everything here is shaped by that. Step 1 is one autofocused textarea. Step 2
 * is a wait, not a form. Step 3 is prefilled and its Save button is reachable
 * without touching anything.
 *
 * The two rules that are easy to get wrong, both roster §12.4's:
 *
 * - **The user's edits always win.** Save posts the form, not the draft.
 * - **Redraft never silently overwrites.** The fresh draft is presented *beside*
 *   the current one and swapped only on an explicit click — and only that click
 *   discards in-progress edits.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { queryKeys, usePermissionCatalogue } from '../api/queries';
import type { ApiFailure } from '../api/result';
import { MODEL_TIERS, type AgentView, type DraftResponse } from '../api/types';
import { useServices } from '../app/AppContext';

import { AgentEditor } from './AgentEditor';
import { fromDraft, hasEdits, toCreateBody, type EditorModel } from './editorModel';

/** §7.1 step 2: "past 20s an inline 'still working' note appears". */
export const SLOW_DRAFT_MS = 20_000;

type Step = 'describe' | 'drafting' | 'review';

export function AgentWizard(): ReactElement {
  const { client } = useServices();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Fetched at step 1 so step 3's rule picker is already populated — the whole
  // wizard is measured against "under a minute", and a spinner inside a fieldset
  // spends some of it (§7.1, WO2).
  const catalogue = usePermissionCatalogue(client);

  const [step, setStep] = useState<Step>('describe');
  const [description, setDescription] = useState('');
  const [tier, setTier] = useState('');
  const [response, setResponse] = useState<DraftResponse | undefined>();
  const [model, setModel] = useState<EditorModel | undefined>();
  const [baseline, setBaseline] = useState<EditorModel | undefined>();
  /** The redraft's answer, held *beside* the form until it is swapped in. */
  const [pending, setPending] = useState<DraftResponse | undefined>();
  const [failure, setFailure] = useState<ApiFailure | undefined>();
  const [slow, setSlow] = useState(false);
  const [saving, setSaving] = useState(false);
  const describeRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    describeRef.current?.focus();
  }, []);

  useEffect(() => {
    if (step !== 'drafting') {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_DRAFT_MS);
    return () => clearTimeout(timer);
  }, [step]);

  async function draft(current: EditorModel | undefined): Promise<DraftResponse | undefined> {
    setFailure(undefined);
    const result = await client.request<DraftResponse>('/roster/draft', {
      method: 'POST',
      body: {
        description,
        ...(tier === '' ? {} : { hints: { modelTier: tier } }),
        // §7.1: redraft re-calls `/draft` "with the original description plus the
        // current edits as context". Never merged server-side — it only shapes
        // the next prompt (roster §12.1).
        ...(current === undefined ? {} : { currentDraft: toCreateBody(current) }),
      },
    });
    if (result.kind === 'ok') return result.value;
    setFailure(result);
    return undefined;
  }

  async function start(): Promise<void> {
    setStep('drafting');
    const answer = await draft(undefined);
    if (answer === undefined) {
      setStep('describe');
      return;
    }
    const next = fromDraft(answer);
    setResponse(answer);
    setModel(next);
    setBaseline(next);
    setStep('review');
  }

  async function redraft(): Promise<void> {
    const answer = await draft(model);
    if (answer !== undefined) setPending(answer);
  }

  async function save(): Promise<void> {
    if (model === undefined) return;
    setSaving(true);
    setFailure(undefined);
    const result = await client.request<AgentView>('/roster/agents', {
      method: 'POST',
      body: toCreateBody(model, {
        origin: 'drafted',
        suggestedSkills: response?.suggestedSkills ?? [],
      }),
    });
    setSaving(false);
    if (result.kind === 'ok') {
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      navigate(`/agents/${encodeURIComponent(result.value.definition.id)}`);
      return;
    }
    setFailure(result);
  }

  if (step === 'describe' || step === 'drafting') {
    return (
      <section aria-labelledby="wizard-heading">
        <h2 id="wizard-heading">New agent</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <div className="field">
            <label htmlFor="wizard-description">Describe them in a sentence</label>
            <textarea
              id="wizard-description"
              ref={describeRef}
              rows={4}
              value={description}
              placeholder="Someone who watches our PHP sites for 500s and patches them, but always writes a failing test first"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="wizard-tier">Model tier</label>
            <select id="wizard-tier" value={tier} onChange={(event) => setTier(event.target.value)}>
              <option value="">let Claude choose</option>
              {MODEL_TIERS.map((one) => (
                <option key={one} value={one}>
                  {one}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="button"
            data-variant="primary"
            disabled={description.trim().length < 10 || step === 'drafting'}
          >
            Draft this agent
          </button>
        </form>

        {step === 'drafting' ? (
          <p className="empty" data-step="drafting">
            Drafting {description.trim().slice(0, 80)}…
          </p>
        ) : null}
        {slow ? <p className="notice">Still working — this is taking longer than usual.</p> : null}
        {failure === undefined ? null : (
          <p className="notice" data-tone="danger" role="alert">
            {failure.message}
          </p>
        )}
      </section>
    );
  }

  if (model === undefined || response === undefined) return <section />;

  return (
    <section aria-labelledby="wizard-heading">
      <h2 id="wizard-heading">Review this agent</h2>

      <AgentEditor
        model={model}
        onChange={(patch) => setModel({ ...model, ...patch })}
        rationale={response.rationale}
        suggestedSkills={response.suggestedSkills}
        suggestedIntegrations={response.suggestedIntegrations}
        catalogue={catalogue.data}
        idPrefix="wizard"
      >
        {response.degraded ? (
          <p className="notice" data-tone="warn" data-degraded="true">
            Claude couldn’t finish this draft — here’s what it produced; fill in the rest. Every
            field below is editable and the agent can still be saved.
          </p>
        ) : null}
        {/* roster's warnings, verbatim (§3.1: the UI does not paraphrase). */}
        {response.warnings.map((warning) => (
          <p key={warning} className="notice" data-tone="warn" data-warning="draft">
            {warning}
          </p>
        ))}
      </AgentEditor>

      <div className="launch__actions">
        <button type="button" className="button" onClick={() => void redraft()}>
          Redraft
        </button>
        <button
          type="button"
          className="button"
          data-variant="primary"
          disabled={saving || model.name.trim() === ''}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>

      {failure === undefined ? null : (
        <p className="notice" data-tone="danger" role="alert">
          {failure.message}
        </p>
      )}

      {pending === undefined ? null : (
        <aside className="editor__redraft" aria-labelledby="redraft-heading">
          <h3 id="redraft-heading">A fresh draft</h3>
          {/*
            §7.1: presented **beside** the current one for an explicit swap,
            "never a silent overwrite". The warning is only shown when a swap
            would actually cost something.
          */}
          {baseline !== undefined && hasEdits(model, baseline) ? (
            <p className="notice" data-tone="warn" data-warning="redraft-edits">
              You have edited this form. Using the fresh draft replaces your edits.
            </p>
          ) : null}
          <dl className="debug-panel">
            <dt>Name</dt>
            <dd>{pending.draft.name ?? '—'}</dd>
            <dt>Specialty</dt>
            <dd>{pending.draft.specialty ?? '—'}</dd>
            <dt>Tagline</dt>
            <dd>{pending.draft.tagline ?? '—'}</dd>
          </dl>
          <button
            type="button"
            className="button"
            onClick={() => {
              const next = fromDraft(pending);
              setResponse(pending);
              setModel(next);
              setBaseline(next);
              setPending(undefined);
            }}
          >
            Use the fresh draft
          </button>
          <button type="button" className="button" onClick={() => setPending(undefined)}>
            Keep my edits
          </button>
        </aside>
      )}
    </section>
  );
}
