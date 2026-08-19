/**
 * The permissions fieldset (ui DESIGN §7.1, roster §6.1/§6.3) — WO2.
 *
 * It used to be a mode `<select>` and three empty textareas over a grammar the
 * owner had no way to learn: "knowing what to write for allow, deny, ask is
 * nearly impossible." Meanwhile roster already held twenty curated rules with
 * plain-language descriptions and showed them only to Claude, during drafting.
 * So each bucket is now its rules **as removable chips** plus one **Add rule**
 * button, and the button opens the catalogue.
 *
 * Three ways in, and the third is the point: the catalogue teaches, Compose
 * builds the shape correctly, and **Raw rule is always there** because roster's
 * grammar is wider than any picker and a form that cannot express a legal rule
 * is worse than a textarea. That is also why the catalogue is only ever a
 * suggestion — an entry whose `suggest` disagrees with the open bucket renders a
 * quiet note and adds anyway.
 *
 * Nothing here validates. `permissionRules.ts` predicts what roster's normaliser
 * will do and this renders the prediction; Save still posts and roster still
 * decides. Its own model is untouched: the buckets are the same newline-joined
 * strings `toCreateBody` has always read, so the wizard, Duplicate and the agent
 * page all get this control without a byte of plumbing.
 */

import { useState, type ReactElement, type ReactNode } from 'react';

import { PERMISSION_MODES, type PermissionCatalogue } from '../api/types';

import type { EditorModel } from './editorModel';
import type { IntegrationForm } from './integrationsModel';
import {
  BUCKET_HELP,
  RULE_BUCKETS,
  catalogueSections,
  chipsOf,
  composeRule,
  ruleWarnings,
  toolOptions,
  withRule,
  withoutRule,
  type RuleBucket,
} from './permissionRules';

export interface PermissionsPanelProps {
  readonly model: EditorModel;
  readonly onChange: (patch: Partial<EditorModel>) => void;
  /** roster's `rationale['permissions']`, already rendered by the caller. */
  readonly rationale?: ReactNode;
  /** `GET /api/roster/permission-catalogue`, or absent — see the picker. */
  readonly catalogue?: PermissionCatalogue | undefined;
  readonly idPrefix?: string;
}

/**
 * The shared picker, opened under one bucket at a time.
 *
 * One picker rather than three because the three lists differ in *meaning* and
 * not in vocabulary: the same rule is legal in all of them, and an owner reading
 * "deny — Bash(rm *)" has learned something about the allow list too.
 */
function RulePicker({
  bucket,
  catalogue,
  integrations,
  idPrefix,
  onAdd,
}: {
  readonly bucket: RuleBucket;
  readonly catalogue: PermissionCatalogue | undefined;
  readonly integrations: readonly IntegrationForm[];
  readonly idPrefix: string;
  readonly onAdd: (rule: string) => void;
}): ReactElement {
  const tools = toolOptions(catalogue?.tools, integrations);
  const [tool, setTool] = useState(tools[0] ?? '');
  const [pattern, setPattern] = useState('');
  const [raw, setRaw] = useState('');
  const composed = composeRule(tool, pattern);

  return (
    <div className="editor__picker" role="group" aria-label={`Add a rule to ${bucket}`}>
      {catalogue === undefined ? (
        // Not an error banner: the form is entirely usable without the
        // catalogue, and a red box would say otherwise. One quiet sentence, so
        // an owner who expected a list knows why there isn't one.
        <p className="editor__note" data-catalogue="unavailable">
          The suggested-rules list couldn’t be loaded from the core. Compose a rule below, or type
          one in — everything still saves the same way.
        </p>
      ) : (
        catalogueSections(catalogue.rules).map((section) => (
          <div className="editor__picker-group" key={section.group}>
            <h4>{section.group}</h4>
            <ul>
              {section.entries.map((entry) => (
                <li key={entry.rule}>
                  <button type="button" onClick={() => onAdd(entry.rule)}>
                    <code>{entry.rule}</code>
                    <span> — {entry.description}</span>
                    {entry.suggest === bucket ? null : (
                      <span className="editor__hint" data-suggest={entry.suggest}>
                        {' '}
                        (usually {entry.suggest})
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      <div className="editor__compose">
        <div className="field">
          <label htmlFor={`${idPrefix}-rule-tool`}>Tool</label>
          <select
            id={`${idPrefix}-rule-tool`}
            value={tool}
            onChange={(event) => setTool(event.target.value)}
          >
            {tools.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-rule-pattern`}>Pattern (optional)</label>
          <input
            id={`${idPrefix}-rule-pattern`}
            value={pattern}
            placeholder="npm run test:*"
            onChange={(event) => setPattern(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="button"
          disabled={composed === ''}
          onClick={() => {
            onAdd(composed);
            setPattern('');
          }}
        >
          Add <code>{composed}</code>
        </button>
      </div>

      {/* Always present, catalogue or no catalogue: roster accepts any
          `Tool` / `Tool(pattern)` string and a picker that cannot spell one is a
          worse textarea. */}
      <div className="editor__compose">
        <div className="field">
          <label htmlFor={`${idPrefix}-rule-raw`}>Raw rule</label>
          <input
            id={`${idPrefix}-rule-raw`}
            value={raw}
            placeholder="Bash(gh pr view*)"
            onChange={(event) => setRaw(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="button"
          disabled={raw.trim() === ''}
          onClick={() => {
            onAdd(raw);
            setRaw('');
          }}
        >
          Add rule
        </button>
      </div>
    </div>
  );
}

export function PermissionsPanel({
  model,
  onChange,
  rationale,
  catalogue,
  idPrefix = 'agent',
}: PermissionsPanelProps): ReactElement {
  const at = (name: string): string => `${idPrefix}-${name}`;
  /** Which bucket's picker is open — one at a time, and screen state only. */
  const [open, setOpen] = useState<RuleBucket | undefined>();

  return (
    <fieldset>
      <legend>Permissions</legend>
      {rationale}
      {/* §7.1: "a plain-language note that deny wins and allow is only
          auto-approval". Said here because it is the single most common
          misreading of a permission list. */}
      <p className="editor__note">
        Deny always wins. Allow is auto-approval, not a restriction — anything not allowed still
        runs, it just asks first.
      </p>
      <div className="field">
        <label htmlFor={at('permission-mode')}>Permission mode</label>
        <select
          id={at('permission-mode')}
          value={model.permissionMode}
          onChange={(event) => onChange({ permissionMode: event.target.value })}
        >
          <option value="">roster’s default</option>
          {PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </div>

      {RULE_BUCKETS.map((bucket) => {
        const rules = chipsOf(model[bucket]);
        const warnings = ruleWarnings(bucket, rules);
        return (
          <div className="field" key={bucket} role="group" aria-label={bucket}>
            <span className="editor__bucket">{bucket}</span>
            <p className="editor__note">{BUCKET_HELP[bucket]}</p>
            {rules.length === 0 ? (
              <p className="empty">No {bucket} rules.</p>
            ) : (
              <ul className="editor__chips" aria-label={`${bucket} rules`}>
                {rules.map((rule, index) => (
                  <li className="editor__chip" key={`${rule}-${String(index)}`}>
                    <code>{rule}</code>
                    <button
                      type="button"
                      aria-label={`Remove ${rule} from ${bucket}`}
                      onClick={() => onChange({ [bucket]: withoutRule(model[bucket], index) })}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="button"
              aria-expanded={open === bucket}
              onClick={() => setOpen(open === bucket ? undefined : bucket)}
            >
              Add rule to {bucket}
            </button>
            {open === bucket ? (
              <RulePicker
                bucket={bucket}
                catalogue={catalogue}
                integrations={model.integrations}
                idPrefix={idPrefix}
                onAdd={(rule) => onChange({ [bucket]: withRule(model[bucket], rule) })}
              />
            ) : null}
            {warnings.map((warning) => (
              <p
                className="notice"
                data-tone="warn"
                data-rule-warning={warning.code}
                key={`${warning.code}-${warning.rule}`}
              >
                {warning.message}
              </p>
            ))}
          </div>
        );
      })}
    </fieldset>
  );
}
