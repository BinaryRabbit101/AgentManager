# WO1 — Agent editor: pickers for closed sets, role addenda made legible

**Element:** ui only (plus additive constants in `web/src/api/types.ts`). **Amends:** ui
`DESIGN.md` §7.1 (the Model and Role-addenda rows of the section table). No server change; the
wire format posted by `toCreateBody` is byte-identical for equivalent input.

## Context

`web/src/agents/AgentEditor.tsx` renders one form for all three entrances (wizard step 3,
duplicate, `/agents/:id`). Today:

- **Model** (`AgentEditor.tsx:169-193`): `primary`, `fallback`, `effort` are free-text `<input>`s.
  Server truth: `MODEL_ALIASES = ['default','best','opus','sonnet','haiku','opusplan']`
  (`src/modules/roster/schema.ts:254`) — *warn-not-block*, full `claude-*` ids stay legal (roster
  DESIGN §8); `EFFORT_LEVELS = ['low','medium','high','xhigh','max']` (schema.ts:258) — a **hard
  enum**, so a typo is an unexplained 400.
- **Role addenda** (`AgentEditor.tsx:271-301`): five `<textarea rows=3>`, one per member of
  `ROLES`, always all visible, no explanation of when an addendum is read. Truth: an addendum is
  appended to the system prompt **only when the orchestrator seats the agent in that collaboration
  role** (`compileSession.ts:229-242`, roster DESIGN §4); solo sessions never read them.
- Web constants live in `web/src/api/types.ts` (hand mirror of schema.ts). `EFFORT_LEVELS` and
  `MODEL_ALIASES` are missing from it.

## The fix

### 1. Model pickers

- `model.primary`: a `<select>` over `MODEL_ALIASES` plus a final **"Custom model id…"** option
  that reveals a text input (pre-filled with the current value when it is not an alias). Loading
  an agent whose stored value is not an alias selects the custom option automatically. The empty
  choice stays available as "roster's default" exactly like the permission-mode select does today.
- `model.fallback`: same control, plus the empty "none" choice.
- `model.effort`: `<select>` over `EFFORT_LEVELS` + empty "default". No custom escape — the
  schema is a closed enum.
- Add `MODEL_ALIASES` and `EFFORT_LEVELS` to `web/src/api/types.ts` beside `PERMISSION_MODES`,
  with the same "hand mirror of roster schema.ts" comment discipline.
- `EditorModel` fields stay plain strings; only the controls change. `toCreateBody` untouched.

### 2. Emoji avatar picker

ui DESIGN §7.1 already promises "emoji avatar (picker)". Ship the modest version: a small grid of
~24 curated emoji (mix of faces/animals/objects that read at card size) that clicks into the
existing `avatarEmoji` field, with the free-text input kept beside it for anything else. No new
avatar kinds (file/initials UI stays deferred, §7.3.1).

### 3. Role addenda: collapsed, explained, scoped to relevant roles

- Wrap the fieldset content in a `<details>` (closed by default **unless** any addendum is
  non-empty on load), summary "Role addenda — optional, for team seats".
- Lead with two sentences of teaching, on screen: *"An addendum is extra prompt text appended
  only when the orchestrator seats this agent in that collaboration role (pair or team
  assignments). Solo runs never read these — most agents don't need any."*
- Render a textarea only for roles that are **checked in Roles above or already have content**
  (content on an unchecked role keeps today's "(not a listed role)" label). Remaining roles are
  reachable through one "Add addendum for…" `<select>` that reveals the chosen textarea.
- Wire behaviour is unchanged: emptied box ⇒ `null` (delete file), untouched roles absent
  (`editorModel.ts roleAddendaBody`). Do not change `editorModel.ts` serialisation.

## Acceptance tests (vitest `--project web`, scoped to `web/src/agents`)

- Model select round-trips: alias in → alias posted; a stored `claude-opus-5` loads into the
  custom input and posts back verbatim; effort select posts only enum members or omits the key.
- Emoji grid click sets the avatar field; typed emoji still accepted.
- Role addenda: with no content and no roles checked, zero textareas render inside the closed
  details; checking a role reveals its box; loading an agent with a skeptic addendum opens the
  details and shows exactly that box plus boxes for checked roles; emptying it still posts
  `roleAddenda: { skeptic: null }`.
- Existing `editorModel.test.ts` and `AgentDetail.test.tsx` save-path tests stay green unmodified
  (proof the wire format did not move).
