# WO2 — Permissions you can pick: rule catalogue surfaced, chips + builder instead of raw textareas

**Elements:** roster (catalogue module + one read route), ui (the permissions fieldset).
**Amends:** roster `DESIGN.md` §6.3 (catalogue exposure) and §9.1 (route table); ui `DESIGN.md`
§7.1 (the Permissions row). **Depends on WO1** (same file — `AgentEditor.tsx` — sequenced, not
parallel).

## Context

Owner: "knowing what to write for allow, deny, ask is nearly impossible." Today the fieldset
(`AgentEditor.tsx:196-232`) is a mode `<select>` plus three free-text textareas, one rule per
line, no examples, no client validation. What already exists server-side and is never shown to a
human:

- `PERMISSION_RULE_CATALOGUE` (`src/modules/roster/draft.ts:174-200`): 20 `{ rule, description }`
  pairs, currently only fed into the drafting prompt.
- `PREFLIGHT_TOOL_CATALOGUE` (`src/modules/roster/preflight.ts:44-54`): the 9 named tools.
- Rule shape validation (`schema.ts permissionRuleSchema`) and the SDK-semantics normaliser
  (`sdkRules.ts`: `Write(path)`/`NotebookEdit(path)` → `Edit(path)`; `allow` on `AskUserQuestion`
  lifted to `ask`; `Edit(*)` collapses to bare auto-approve).

## The fix

### 1. One catalogue module, one read route (roster)

- Extract the catalogue into `src/modules/roster/permissionCatalogue.ts` exporting
  `PERMISSION_RULE_CATALOGUE` (moved from `draft.ts`, which re-imports it — the drafting prompt
  must keep using the identical list) and a grouping suitable for the UI: each entry gains a
  `group` (`'read' | 'edit' | 'shell' | 'git' | 'web' | 'other'` — pick sensible members from the
  existing 20) and a `suggest` hint (`'allow' | 'deny' | 'ask'`) drawn from each entry's existing
  description prose. Do not change any `rule` string.
- `GET /api/roster/permission-catalogue` → `{ rules: [...], tools: PREFLIGHT_TOOL_CATALOGUE }`.
  Static, no params, no per-agent data. Add to `routes.ts` and the §9.1 route table.

### 2. The fieldset becomes chips + a builder (ui)

Replace the three textareas in `AgentEditor.tsx` with, per bucket (allow / deny / ask):

- **Current rules as removable chips**, monospace rule text, ✕ to remove.
- One **"Add rule"** control per bucket opening a shared picker with three ways in:
  1. **Catalogue list** — the fetched entries, grouped, each showing `rule` + its plain-language
     description; clicking adds it to the open bucket (entries whose `suggest` differs from the
     bucket render a soft hint, never a refusal).
  2. **Compose** — a tool `<select>` (the 9 catalogue tools **plus** `mcp__<name>__*` entries
     derived live from the integrations currently in the form state) and an optional pattern
     input producing `Tool(pattern)` / bare `Tool`.
  3. **Raw rule** — a free-text escape hatch, always present.
- **Client-side field warnings** (never gates — roster stays the authority): unbalanced
  parenthesis; a `Write(path)`/`NotebookEdit(path)` rule ("stored as Edit(path) — only Edit is
  consulted for file scoping"); `allow` containing `AskUserQuestion` ("will be lifted into ask");
  `Edit(*)` ("collapses to auto-approving all edits"); duplicate rule in the same bucket. Mirror
  the messages from `sdkRules.ts` prose so they cannot drift into contradiction.
- Keep the existing bucket help line and extend it to a one-liner per bucket: allow =
  auto-approve, deny = always blocked and wins over everything, ask = a human answers a card.
- The catalogue is fetched with the app's normal query client; if the fetch fails the picker
  degrades to Compose + Raw (the form must never be unusable offline from the catalogue).

### 3. Serialisation unchanged

`EditorModel.allow/deny/ask` stay newline-joined strings and `toCreateBody`/`rulesOf` stay as
they are — chips parse from and write back into the same model fields, so the wizard, duplicate
and detail entrances all get the new control with no plumbing changes.

## Acceptance tests

- roster (`--project server`, scoped): the route serves exactly the catalogue `draft.ts` consumes
  (same array identity or a parity assertion); every catalogue `rule` passes
  `permissionRuleSchema`.
- web (`--project web`, scoped to `web/src/agents`): chips render from a loaded agent's rules and
  removal posts the shortened list; adding a catalogue entry, a composed `Bash(npm run test:*)`,
  and a raw rule each land in the right bucket of the posted body; the `Write(path)` and
  `AskUserQuestion` warnings render; catalogue fetch failure still allows composing and raw
  entry; an agent with an `mcp` integration named `gmail` offers `mcp__gmail__*` in Compose.
