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

import { useState, type ReactElement, type ReactNode } from 'react';

import {
  EFFORT_LEVELS,
  MODEL_ALIASES,
  PERMISSION_MODES,
  PERSONA_MODES,
  ROLES,
  SPECIALTIES,
  type Diagnostic,
  type IntegrationCredentialStatus,
  type Role,
  type SuggestedIntegration,
  type SuggestedSkill,
} from '../api/types';

import { REPLACE_PERSONA_WARNING, type EditorModel } from './editorModel';
import { IntegrationsPanel } from './IntegrationsPanel';

export interface AgentEditorProps {
  readonly model: EditorModel;
  readonly onChange: (patch: Partial<EditorModel>) => void;
  /** roster's per-field-group prose, keyed by group name (§7.1). */
  readonly rationale?: Readonly<Record<string, string>>;
  readonly suggestedSkills?: readonly SuggestedSkill[];
  readonly suggestedIntegrations?: readonly SuggestedIntegration[];
  /** roster's `{ secretRef, resolved }` per integration credential (§10). */
  readonly credentials?: readonly IntegrationCredentialStatus[];
  /** roster's diagnostics; the panel picks out the `integrations.*` ones. */
  readonly diagnostics?: readonly Diagnostic[];
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

/**
 * The option value that means "none of the above" in a model picker.
 *
 * A sentinel rather than a second control, because the alias and the full id are
 * one field on the wire (`model.primary`) and splitting them into two inputs
 * would invent a state the schema cannot hold.
 */
const CUSTOM_MODEL = '\u0000custom';

/**
 * Two dozen emoji that still read at card size (§7.1's "emoji avatar (picker)").
 *
 * Curated rather than complete: a full picker is a component, and the field
 * beside this grid already accepts anything the platform can type. These are
 * only the shortcuts for the common cases.
 */
const AVATAR_EMOJI = [
  '🐛',
  '🔍',
  '🧪',
  '📐',
  '🛠️',
  '⚙️',
  '📝',
  '📚',
  '🧭',
  '🚦',
  '🛡️',
  '🧹',
  '🚀',
  '💡',
  '🎯',
  '🧠',
  '🦉',
  '🦊',
  '🐙',
  '🐝',
  '🐢',
  '🦫',
  '🤖',
  '👻',
] as const;

/**
 * `model.primary` / `model.fallback`: a picker over the aliases with an escape.
 *
 * roster validates aliases **warn-not-block** (§8) — a `claude-*` id released
 * after this build must stay typeable — so the closed list cannot be the whole
 * control. The escape is an option rather than a checkbox because "which of
 * these, or something else" is one question.
 */
function ModelPicker({
  id,
  label,
  customLabel,
  emptyLabel,
  value,
  placeholder,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly customLabel: string;
  readonly emptyLabel: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const isAlias = (MODEL_ALIASES as readonly string[]).includes(value);
  // Held, not derived, because a custom id the user has cleared back to `''`
  // must leave the text box on screen rather than snap back to the dropdown.
  const [chose, setChose] = useState(false);
  const custom = chose || (value !== '' && !isAlias);

  return (
    <>
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          value={custom ? CUSTOM_MODEL : value}
          onChange={(event) => {
            if (event.target.value === CUSTOM_MODEL) {
              setChose(true);
              return;
            }
            setChose(false);
            onChange(event.target.value);
          }}
        >
          <option value="">{emptyLabel}</option>
          {MODEL_ALIASES.map((alias) => (
            <option key={alias} value={alias}>
              {alias}
            </option>
          ))}
          <option value={CUSTOM_MODEL}>Custom model id…</option>
        </select>
      </div>
      {custom ? (
        <div className="field">
          <label htmlFor={`${id}-custom`}>{customLabel}</label>
          <input
            id={`${id}-custom`}
            value={value}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      ) : null}
    </>
  );
}

export function AgentEditor({
  model,
  onChange,
  rationale = {},
  suggestedSkills = [],
  suggestedIntegrations = [],
  credentials = [],
  diagnostics = [],
  idPrefix = 'agent',
  children,
}: AgentEditorProps): ReactElement {
  const at = (name: string): string => `${idPrefix}-${name}`;

  // Roles the user asked for through "Add addendum for…". Screen state, not
  // form state: a revealed box left empty writes nothing at all (the absent-key
  // rule in `editorModel.ts`), so it is a fact about this view of the agent
  // rather than about the agent.
  const [revealed, setRevealed] = useState<readonly Role[]>([]);
  const [addendaOpen, setAddendaOpen] = useState(
    ROLES.some((role) => (model.roleAddenda[role] ?? '') !== ''),
  );
  // A role keeps its box once it has one — including after the user empties it,
  // which is how "delete this addendum" is spelled and must stay reachable.
  const shownAddenda = ROLES.filter(
    (role) =>
      model.roles.includes(role) ||
      model.roleAddenda[role] !== undefined ||
      revealed.includes(role),
  );
  const hiddenAddenda = ROLES.filter((role) => !shownAddenda.includes(role));

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
          <div className="editor__avatar">
            <input
              id={at('avatar')}
              value={model.avatarEmoji}
              onChange={(event) => onChange({ avatarEmoji: event.target.value })}
            />
            {/* The picker of §7.1, in its modest form. The field stays beside it
                because the grid is a shortcut, not the set of legal answers. */}
            <div className="editor__emoji" role="group" aria-label="Pick an emoji">
              {AVATAR_EMOJI.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`Use ${emoji}`}
                  aria-pressed={model.avatarEmoji === emoji}
                  onClick={() => onChange({ avatarEmoji: emoji })}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
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
        <ModelPicker
          id={at('model')}
          label="Alias or id"
          customLabel="Custom model id"
          emptyLabel="roster’s default"
          value={model.modelPrimary}
          placeholder="claude-opus-4-1-20250805"
          onChange={(modelPrimary) => onChange({ modelPrimary })}
        />
        <ModelPicker
          id={at('model-fallback')}
          label="Fallback"
          customLabel="Custom fallback model id"
          emptyLabel="none"
          value={model.modelFallback}
          placeholder="claude-sonnet-4-5-20250929"
          onChange={(modelFallback) => onChange({ modelFallback })}
        />
        <div className="field">
          <label htmlFor={at('model-effort')}>Effort</label>
          {/* A hard Zod enum on the server (roster §8), so there is no custom
              escape here — a typo would be a 400 nobody could have predicted. */}
          <select
            id={at('model-effort')}
            value={model.modelEffort}
            onChange={(event) => onChange({ modelEffort: event.target.value })}
          >
            <option value="">default</option>
            {EFFORT_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
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

      {/*
        roster §4's second system-prompt slot. Its own fieldset rather than a
        textarea under each checkbox, because the two answer different
        questions — the boxes above say which seats this agent may take, and
        these say how it behaves once it is in one. The lists are deliberately
        not tied together: roster §4 lets a role carry an addendum without being
        listed, and be listed without one.
      */}
      <fieldset>
        <legend>Role addenda</legend>
        {/*
          Closed unless the agent already has one, because the honest default
          answer to "what do I write here" is "nothing" — five empty boxes on
          every entrance said the opposite, loudly, and owners read that as a
          form they were failing to fill in.
        */}
        <details
          className="editor__addenda"
          open={addendaOpen}
          onToggle={(event) => setAddendaOpen(event.currentTarget.open)}
        >
          <summary>Role addenda — optional, for team seats</summary>
          <p className="editor__note">
            An addendum is extra prompt text appended only when the orchestrator seats this agent in
            that collaboration role (pair or team assignments). Solo runs never read these — most
            agents don’t need any. Emptying a box deletes that addendum.
          </p>
          <Rationale text={rationale['roleAddenda']} />
          {shownAddenda.map((role) => (
            <div className="field" key={role}>
              <label htmlFor={at(`role-addendum-${role}`)}>
                {role}
                {model.roles.includes(role) ? '' : ' (not a listed role)'}
              </label>
              <textarea
                id={at(`role-addendum-${role}`)}
                rows={3}
                value={model.roleAddenda[role] ?? ''}
                placeholder={`How this agent behaves as the ${role}…`}
                onChange={(event) =>
                  onChange({
                    // The key is kept even when the box is emptied: an absent key
                    // means "leave the file alone" and an empty one means "delete
                    // it", and clearing a textarea is the second (editorModel.ts).
                    roleAddenda: { ...model.roleAddenda, [role]: event.target.value },
                  })
                }
              />
            </div>
          ))}
          {hiddenAddenda.length === 0 ? null : (
            <div className="field">
              <label htmlFor={at('role-addendum-add')}>Add addendum for…</label>
              {/* roster §4 keeps the seat list and the addenda independent, so
                  every role stays reachable here — including ones this agent is
                  not listed for. */}
              <select
                id={at('role-addendum-add')}
                value=""
                onChange={(event) => {
                  const role = event.target.value;
                  if (role === '') return;
                  setRevealed([...revealed, role as Role]);
                }}
              >
                <option value="">choose a role…</option>
                {hiddenAddenda.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </div>
          )}
        </details>
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
          {/* §7.1: "wiring an MCP server is the editor's job, not the wizard's".
              It stays that way — but the editor is right here, so say where. */}
          <p className="editor__note" data-manage-integrations="true">
            Suggestions only. Wire one up under <strong>Integrations</strong> below — here now, or
            later on the agent’s page.
          </p>
        </fieldset>
      )}

      {/*
        Last, deliberately. Everything above describes who the agent *is*; this
        says what it can reach outside the sandbox, which is the field group an
        owner comes back to rather than fills in once (ui §7.3).
      */}
      <IntegrationsPanel
        integrations={model.integrations}
        onChange={(integrations) => onChange({ integrations })}
        credentials={credentials}
        diagnostics={diagnostics}
        idPrefix={idPrefix}
      />
    </div>
  );
}
