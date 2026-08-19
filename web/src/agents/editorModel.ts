/**
 * The agent editor's form model (DESIGN §7.1, §7.2).
 *
 * One model, three entrances — a draft, a duplicate, and an existing agent —
 * because roster designed drafting to be **stateless** precisely so that "draft →
 * tweak → save" and "duplicate → tweak → save" could be the same component
 * (roster §15, decision 8). Two forms would be two places for the two paths to
 * disagree.
 *
 * The rule that shapes every function here is roster §12.4's:
 *
 * > "The **user's edits always win.** There is no merge, no re-draft-on-save, no
 * > server-side reconciliation — the object the wizard posts is the object that
 * > is written."
 *
 * So {@link toCreateBody} is a *projection of the form and nothing else*: it
 * reads no draft, consults no default that is not visible in the form, and adds
 * nothing the user did not see. That is what makes "the saved definition is
 * byte-equal to what the form posted" a property of the code rather than a
 * hope.
 */

import type { AgentDraft, AgentView, DraftResponse, Role, SuggestedSkill } from '../api/types';

import { integrationsBody, integrationsOf, type IntegrationForm } from './integrationsModel';

/**
 * Everything the form holds, as strings where the form holds strings.
 *
 * Rule lists are **held** as text, one rule per line, and since WO2 they are
 * *edited* as chips over a picker (`PermissionsPanel.tsx`). The storage did not
 * change with the control, deliberately: newline-joined text round-trips an
 * arbitrary rule without inventing a grammar for it, so the raw escape hatch and
 * the catalogue write into the same field and {@link toCreateBody} never learned
 * that anything happened.
 */
export interface EditorModel {
  readonly name: string;
  readonly specialty: string;
  readonly tagline: string;
  readonly tags: string;
  readonly avatarEmoji: string;
  /** `persona.md`, verbatim. Never normalised — see {@link toCreateBody}. */
  readonly personaText: string;
  readonly personaMode: string;
  readonly modelPrimary: string;
  readonly modelFallback: string;
  readonly modelEffort: string;
  readonly permissionMode: string;
  readonly allow: string;
  readonly deny: string;
  readonly ask: string;
  readonly roles: readonly string[];
  readonly overseer: boolean;
  /**
   * `roles/<role>.md` bodies, verbatim, keyed by role (roster §4).
   *
   * A role with no addendum has no key — the same distinction the wire format
   * draws, carried all the way into the form so that clearing a textarea can
   * mean "delete the file" rather than "write an empty one".
   */
  readonly roleAddenda: Readonly<Partial<Record<Role, string>>>;
  /** Suggested skills the user ticked. Untouched ones write nothing (§12.4). */
  readonly acceptedSkills: readonly string[];
  /**
   * Per-agent MCP servers (roster §10), as a list rather than a record.
   *
   * A record keyed by name cannot be edited: renaming a server would have to
   * delete one key and create another on every keystroke, and two half-typed
   * names would collide on `''`. The list is the editable shape and
   * {@link toCreateBody} turns it back into the record roster's schema wants.
   */
  readonly integrations: readonly IntegrationForm[];
}

export const EMPTY_MODEL: EditorModel = Object.freeze({
  name: '',
  specialty: 'general',
  tagline: '',
  tags: '',
  avatarEmoji: '',
  personaText: '',
  personaMode: 'append',
  modelPrimary: '',
  modelFallback: '',
  modelEffort: '',
  permissionMode: '',
  allow: '',
  deny: '',
  ask: '',
  roles: [],
  overseer: false,
  roleAddenda: {},
  acceptedSkills: [],
  integrations: [],
});

/** One rule per line, blank lines dropped. The inverse of {@link linesOf}. */
export function rulesOf(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function linesOf(rules: readonly string[] | undefined): string {
  return (rules ?? []).join('\n');
}

/** `POST /api/roster/draft`'s answer, as a form (§7.1 step 3). */
export function fromDraft(response: DraftResponse): EditorModel {
  const draft: AgentDraft = response.draft;
  return {
    ...EMPTY_MODEL,
    name: draft.name ?? '',
    specialty: draft.specialty ?? 'general',
    tagline: draft.tagline ?? '',
    tags: (draft.tags ?? []).join(', '),
    avatarEmoji: draft.avatar?.value ?? '',
    personaText: response.persona,
    personaMode: draft.persona?.mode ?? 'append',
    modelPrimary: draft.model?.primary ?? '',
    modelFallback: draft.model?.fallback ?? '',
    modelEffort: draft.model?.effort ?? '',
    permissionMode: draft.permissions?.mode ?? '',
    allow: linesOf(draft.permissions?.allow),
    deny: linesOf(draft.permissions?.deny),
    ask: linesOf(draft.permissions?.ask),
    roles: draft.capabilities?.roles ?? [],
    overseer: draft.capabilities?.overseer ?? false,
    // Drafting proposes which seats the agent suits, never the per-seat prose:
    // an addendum is written against a collaboration the agent has actually
    // been in, and the wizard has not seen one (roster §16's line on Claude
    // writing skill bodies applies to these for the same reason).
    roleAddenda: {},
    acceptedSkills: [],
    // Drafting *suggests* integrations and never configures one — `/draft`
    // returns `suggestedIntegrations` with `secretRef` placeholders and no
    // credential (roster §12.3), which is a read-only list, not a definition.
    // Wiring a server is the editor's job (ui §7.1).
    integrations: [],
  };
}

/** An existing agent — the duplicate path and `/agents/:id` (§7.2, §7.3). */
export function fromAgent(agent: AgentView): EditorModel {
  const definition = agent.definition;
  return {
    ...EMPTY_MODEL,
    name: definition.name,
    specialty: definition.specialty,
    tagline: definition.tagline ?? '',
    tags: (definition.tags ?? []).join(', '),
    avatarEmoji: definition.avatar?.kind === 'emoji' ? definition.avatar.value : '',
    personaText: agent.persona,
    personaMode: definition.persona?.mode ?? 'append',
    modelPrimary: definition.model?.primary ?? '',
    modelFallback: definition.model?.fallback ?? '',
    modelEffort: definition.model?.effort ?? '',
    permissionMode: definition.permissions?.mode ?? '',
    allow: linesOf(definition.permissions?.allow),
    deny: linesOf(definition.permissions?.deny),
    ask: linesOf(definition.permissions?.ask),
    roles: definition.capabilities?.roles ?? [],
    overseer: definition.capabilities?.overseer ?? false,
    roleAddenda: { ...agent.roleAddenda },
    acceptedSkills: [],
    // Refs only — `definition.integrations` is the API's copy, and roster never
    // puts a resolved credential in it (§10). Whatever is in the form is
    // therefore already safe to render.
    integrations: integrationsOf(definition.integrations),
  };
}

/**
 * What the form posts. **This is the whole of what gets written.**
 *
 * Three things it deliberately does not do:
 *
 * - **It does not normalise `personaText`.** Not a trim, not a line-ending
 *   rewrite, not a trailing newline. roster §4 wants `persona.md` to round-trip
 *   byte-for-byte through the textarea, and every "helpful" normalisation is a
 *   byte the user did not ask to change.
 * - **It does not merge with the draft.** Fields the user cleared are omitted,
 *   not restored from what Claude suggested.
 * - **It does not invent a default.** An empty model field means the key is
 *   absent, so roster's own schema defaults apply — one owner of a default.
 */
export interface ToCreateBodyOptions {
  readonly origin?: string;
  readonly suggestedSkills?: readonly SuggestedSkill[];
  /**
   * Which request this body is for, and it changes exactly one key.
   *
   * roster's `patch` reads `null` as "clear this field" and an absent key as
   * "leave it alone" (`service.ts`) — the distinction that makes removing a
   * tagline possible at all. Removing an agent's *last* integration needs the
   * same spelling, and `create` cannot take it (the schema has no `null` there,
   * and there is nothing to clear on a definition that does not exist yet). So
   * an empty list is `null` under `patch` and simply absent under `create`.
   */
  readonly mode?: 'create' | 'patch';
}

export function toCreateBody(
  model: EditorModel,
  options: ToCreateBodyOptions = {},
): Record<string, unknown> {
  const tags = model.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
  const permissions = {
    ...(model.permissionMode === '' ? {} : { mode: model.permissionMode }),
    ...(rulesOf(model.allow).length === 0 ? {} : { allow: rulesOf(model.allow) }),
    ...(rulesOf(model.deny).length === 0 ? {} : { deny: rulesOf(model.deny) }),
    ...(rulesOf(model.ask).length === 0 ? {} : { ask: rulesOf(model.ask) }),
  };
  const accepted = (options.suggestedSkills ?? []).filter((skill) =>
    model.acceptedSkills.includes(skill.name),
  );
  const roleAddenda = roleAddendaBody(model);
  const integrations = integrationsBody(model.integrations);
  const hasIntegrations = Object.keys(integrations).length > 0;

  return {
    name: model.name,
    specialty: model.specialty,
    ...(model.tagline === '' ? {} : { tagline: model.tagline }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(model.avatarEmoji === '' ? {} : { avatar: { kind: 'emoji', value: model.avatarEmoji } }),
    persona: { mode: model.personaMode },
    ...(model.modelPrimary === ''
      ? {}
      : {
          model: {
            primary: model.modelPrimary,
            ...(model.modelFallback === '' ? {} : { fallback: model.modelFallback }),
            ...(model.modelEffort === '' ? {} : { effort: model.modelEffort }),
          },
        }),
    ...(Object.keys(permissions).length === 0 ? {} : { permissions }),
    ...(hasIntegrations
      ? { integrations }
      : options.mode === 'patch'
        ? { integrations: null }
        : {}),
    ...(model.roles.length === 0 && !model.overseer
      ? {}
      : { capabilities: { overseer: model.overseer, roles: model.roles } }),
    // §12.4: accepting one creates `skills/<name>/SKILL.md` **and** adds the name
    // to `skills.names`. Declining writes nothing, which is why an empty list
    // omits both keys rather than sending `mode: 'none'`.
    ...(accepted.length === 0
      ? {}
      : {
          skills: { mode: 'declared', names: accepted.map((skill) => skill.name) },
          acceptedSkills: accepted.map((skill) => ({
            name: skill.name,
            description: skill.description,
          })),
        }),
    personaText: model.personaText,
    ...(Object.keys(roleAddenda).length === 0 ? {} : { roleAddenda }),
    ...(options.origin === undefined ? {} : { meta: { origin: options.origin } }),
  };
}

/**
 * The role addenda as the wire wants them: body, `null` to delete, or absent.
 *
 * A role the form never showed a body for is absent, so an agent's untouched
 * addenda are not rewritten on every save. A role whose box the user emptied is
 * `null` — roster's `composePersona` skips whitespace-only slots so that "no
 * addendum" and "an empty one" compose byte-identically, which makes deleting
 * the file the canonical way to spell the state the user just asked for. That is
 * a choice about **which** file to write, not a normalisation of its bytes: a
 * body with anything in it is sent exactly as typed, like `personaText`.
 */
function roleAddendaBody(model: EditorModel): Readonly<Partial<Record<Role, string | null>>> {
  const out: Partial<Record<Role, string | null>> = {};
  for (const [role, body] of Object.entries(model.roleAddenda)) {
    out[role as Role] = body.trim() === '' ? null : body;
  }
  return out;
}

/**
 * Whether the form has been touched since it was filled from a draft (§7.1).
 *
 * The redraft guard: "Redraft re-calls `/draft` … and presents the fresh draft
 * **beside** the current one for an explicit swap — never a silent overwrite."
 * Comparing the model to the baseline it was created from is what tells the
 * screen whether a swap would cost the user anything.
 */
export function hasEdits(model: EditorModel, baseline: EditorModel): boolean {
  return JSON.stringify(model) !== JSON.stringify(baseline);
}

/**
 * roster's own sentence about `replace`, quoted (§7.1, roster `draft.ts`).
 *
 * The server sends this in `warnings[]` when *it* suggests `replace`; when the
 * **user** picks it in the editor there is no server round-trip to carry a
 * warning, and the same fact still has to be said. Quoted rather than reworded so
 * the two paths read identically.
 */
export const REPLACE_PERSONA_WARNING =
  'Suggested `replace` persona mode — this agent will not receive Claude Code’s coding ' +
  'guidance (DESIGN §5).';
