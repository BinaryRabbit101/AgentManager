/**
 * The agent editor (DESIGN §7.1 step 3, §7.2, §7.3).
 *
 * **One component, three entrances.** The wizard's review step, Duplicate, and
 * `/agents/:id` all render this — roster made drafting stateless so that they
 * could (roster §15, decision 8), and honouring that is the difference between
 * one form and three that drift.
 *
 * Every group carries its `rationale` beside it when there is one, because that
 * is "the thing that makes the wizard feel like a collaborator rather than a slot
 * machine" (§7.1). When there is none — the duplicate and edit paths — the space
 * is simply absent; an empty explanation box is worse than no box.
 *
 * Nothing here composes, merges or defaults: `editorModel.ts` owns what the form
 * *is* and what it posts, and this file owns only how it looks and reads.
 */

import type { ReactElement, ReactNode } from 'react';

import {
  PERMISSION_MODES,
  PERSONA_MODES,
  ROLES,
  SPECIALTIES,
  type SuggestedIntegration,
  type SuggestedSkill,
} from '../api/types';

import { REPLACE_PERSONA_WARNING, type EditorModel } from './editorModel';

export interface AgentEditorProps {
  readonly model: EditorModel;
  readonly onChange: (patch: Partial<EditorModel>) => void;
  /** roster's per-field-group prose, keyed by group name (§7.1). */
  readonly rationale?: Readonly<Record<string, string>>;
  readonly suggestedSkills?: readonly SuggestedSkill[];
  readonly suggestedIntegrations?: readonly SuggestedIntegration[];
  /** An id prefix, so two editors side by side (redraft) keep distinct labels. */
  readonly idPrefix?: string;
  /** Rendered above the form — the "cloned from" line, the degraded banner. */
  readonly children?: ReactNode;
}

function Rationale({ text }: { readonly text: string | undefined }): ReactElement | null {
  if (text === undefined || text === '') return null;
  return (
    <p className="editor__rationale" data-rationale="true">
      {text}
    </p>
  );
}

export function AgentEditor({
  model,
  onChange,
  rationale = {},
  suggestedSkills = [],
  suggestedIntegrations = [],
  idPrefix = 'agent',
  children,
}: AgentEditorProps): ReactElement {
  const at = (name: string): string => `${idPrefix}-${name}`;

  return (
    <div className="editor">
      {children}

      <fieldset>
        <legend>Identity</legend>
        <Rationale text={rationale['specialty'] ?? rationale['identity']} />
        <div className="field">
          <label htmlFor={at('name')}>Name</label>
          <input
            id={at('name')}
            value={model.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={at('avatar')}>Avatar emoji</label>
          <input
            id={at('avatar')}
            value={model.avatarEmoji}
            onChange={(event) => onChange({ avatarEmoji: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={at('tagline')}>Tagline</label>
          <input
            id={at('tagline')}
            value={model.tagline}
            onChange={(event) => onChange({ tagline: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={at('specialty')}>Specialty</label>
          {/* The closed enum of roster §3.1 — never a free-text field. */}
          <select
            id={at('specialty')}
            value={model.specialty}
            onChange={(event) => onChange({ specialty: event.target.value })}
          >
            {SPECIALTIES.map((specialty) => (
              <option key={specialty} value={specialty}>
                {specialty}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={at('tags')}>Tags</label>
          <input
            id={at('tags')}
            value={model.tags}
            onChange={(event) => onChange({ tags: event.target.value })}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Persona</legend>
        <Rationale text={rationale['persona']} />
        <div className="field">
          <label htmlFor={at('persona-mode')}>Persona mode</label>
          <select
            id={at('persona-mode')}
            value={model.personaMode}
            onChange={(event) => onChange({ personaMode: event.target.value })}
          >
            {PERSONA_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </div>
        {model.personaMode === 'replace' ? (
          <p className="notice" data-tone="warn" data-warning="persona-replace">
            {REPLACE_PERSONA_WARNING}
          </p>
        ) : null}
        <div className="field">
          <label htmlFor={at('persona')}>persona.md</label>
          {/*
            A plain textarea, and deliberately so (§20): it round-trips
            byte-for-byte, which a WYSIWYG or a live-preview editor does not.
          */}
          <textarea
            id={at('persona')}
            rows={12}
            value={model.personaText}
            onChange={(event) => onChange({ personaText: event.target.value })}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Model</legend>
        <Rationale text={rationale['model']} />
        <div className="field">
          <label htmlFor={at('model')}>Alias or id</label>
          <input
            id={at('model')}
            value={model.modelPrimary}
            placeholder="sonnet"
            onChange={(event) => onChange({ modelPrimary: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={at('model-fallback')}>Fallback</label>
          <input
            id={at('model-fallback')}
            value={model.modelFallback}
            onChange={(event) => onChange({ modelFallback: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={at('model-effort')}>Effort</label>
          <input
            id={at('model-effort')}
            value={model.modelEffort}
            onChange={(event) => onChange({ modelEffort: event.target.value })}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Permissions</legend>
        <Rationale text={rationale['permissions']} />
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
        {(['allow', 'deny', 'ask'] as const).map((bucket) => (
          <div className="field" key={bucket}>
            <label htmlFor={at(bucket)}>{bucket}</label>
            <textarea
              id={at(bucket)}
              rows={4}
              value={model[bucket]}
              onChange={(event) => onChange({ [bucket]: event.target.value })}
            />
          </div>
        ))}
      </fieldset>

      <fieldset>
        <legend>Roles</legend>
        <Rationale text={rationale['roles'] ?? rationale['capabilities']} />
        {ROLES.map((role) => (
          <label key={role} className="launch__toggle">
            <input
              type="checkbox"
              checked={model.roles.includes(role)}
              onChange={(event) =>
                onChange({
                  roles: event.target.checked
                    ? [...model.roles, role]
                    : model.roles.filter((one) => one !== role),
                })
              }
            />
            {role}
          </label>
        ))}
        <label className="launch__toggle">
          <input
            type="checkbox"
            checked={model.overseer}
            onChange={(event) => onChange({ overseer: event.target.checked })}
          />
          This one coordinates others
        </label>
      </fieldset>

      {suggestedSkills.length === 0 ? null : (
        <fieldset>
          <legend>Suggested skills</legend>
          <Rationale text={rationale['skills']} />
          {/* Inert until accepted (roster §12.4): ticking one creates
              `skills/<name>/SKILL.md`; leaving it writes nothing at all. */}
          {suggestedSkills.map((skill) => (
            <label key={skill.name} className="launch__toggle">
              <input
                type="checkbox"
                checked={model.acceptedSkills.includes(skill.name)}
                onChange={(event) =>
                  onChange({
                    acceptedSkills: event.target.checked
                      ? [...model.acceptedSkills, skill.name]
                      : model.acceptedSkills.filter((one) => one !== skill.name),
                  })
                }
              />
              <strong>{skill.name}</strong> — {skill.description}
            </label>
          ))}
        </fieldset>
      )}

      {suggestedIntegrations.length === 0 ? null : (
        <fieldset>
          <legend>Suggested integrations</legend>
          {/* Read-only, with the placeholder ref and never a value (§7.1). */}
          <ul>
            {suggestedIntegrations.map((integration) => (
              <li key={integration.name} data-integration={integration.name}>
                <strong>{integration.name}</strong> — {integration.why}
                {integration.secretRef === undefined ? null : (
                  <>
                    {' '}
                    <code>{integration.secretRef}</code>
                  </>
                )}
                <span> — you will need to supply this credential.</span>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
    </div>
  );
}
