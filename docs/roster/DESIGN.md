# Roster — Design

The roster is AgentManager's cast of "cloned people." An **agent definition** is a persistent
identity — persona, specialty, model, permissions, skills, integrations — that exists
independently of any project or session. Runner turns a definition into a live Claude Agent SDK
session; orchestrator assigns definitions to work; UI renders them as cards on a board.

Conforms to [architecture.md](../architecture.md) D1–D6. Consumes foundation's storage, config,
secrets, and logging decisions; invents none of its own.

> **SDK surface note.** This design pins itself to the Claude Agent SDK
> (`@anthropic-ai/claude-agent-sdk`) TypeScript `query()` options. Option names below were checked
> against current SDK documentation, but the SDK moves fast: implementation must verify every
> option name and union value against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and
> pin a version range in `package.json`. The **option compiler** (§6) is the single place in the
> codebase that touches SDK option shapes, so an SDK change is a one-file change.

---

## 1. Scope and boundaries

| Roster owns | Roster does not own |
|---|---|
| Agent definition schema, storage, validation | Session execution, streaming, queueing (runner) |
| CRUD, duplicate-and-edit, import/export | Project paths, per-project defaults (projects) |
| Compiling a definition (+ overrides) into SDK session options | Assignments, mailboxes, patterns, budgets enforcement (orchestrator) |
| Declaring what an agent *may* do and *is for* | Deciding what it does *now* (orchestrator) |
| Draft-from-description API | The wizard UI itself (ui) |
| Which capability flags mark an overseer | Overseer behaviour and routing (orchestrator) |
| Secret **references** in integration configs | Secret storage/resolution (foundation) |

Roster is the lowest layer with no dependencies except foundation. Every other element joins on
`agentId`.

---

## 2. Storage layout

### 2.1 Decision

**File-based, one folder per agent, with SQLite reserved for mutable non-definition state.**

Foundation's leaning is "SQLite for structured app state + plain files for personas/transcripts
(git-friendly)". An agent definition is *mostly persona and prose* — a system prompt, skill
markdown, role addenda — with a thin structured header. Splitting the header into SQLite and the
prose into files would give two sources of truth for one object and make `git diff`, review,
duplicate, and export all three-step operations. So the whole definition lives on disk, and the
database holds only what must not churn git history.

```
<libraryRoot>/                         # foundation's `library.root` (default <dataRoot>/library,
                                       # dataRoot from AGENTMANAGER_HOME); a git repo in its own right
  agents/
    priya-bugfix/                      # folder name == agent id (slug, immutable)
      agent.json                       # structured definition (schema v1)
      persona.md                       # the persona / system prompt body
      avatar.png                       # optional; else agent.json carries an emoji or initials
      roles/
        skeptic.md                     # optional per-collaboration-role persona addenda
        architect.md
      skills/                          # per-agent skills, plugin layout (see §7)
        triage-a-stack-trace/
          SKILL.md
      .claude-plugin/
        plugin.json                    # generated, not hand-edited — makes the folder a local plugin
  .archive/
    <id>-<timestamp>/                  # soft-deleted agents (see §9)
  roster.json                          # roster-level metadata: schemaVersion, seededAt
```

Paths are foundation's (foundation §1.2): the library root is `library.root`, resolved beneath
`dataRoot` (env `AGENTMANAGER_HOME`) unless the user relocates it. Roster invents no root of its own
and never reads an environment variable to find one.

`agent.json` is **the** definition; the folder is the unit of copy, export, and version control.
The library being a standalone git repo is what makes "git-versioning the roster" real rather than
aspirational — and **roster owns everything inside it**. The installer creates and ACLs the
directory and stops there (foundation §4.4); on first run roster performs `git init` (never an
auto-commit), writes `roster.json` and `.gitignore`, and seeds the starter agents (§ implementation
M2/M10). One component knows the library's shape, which is the only way the shape stays consistent.

### 2.2 What goes in SQLite

Two tables are roster-adjacent, and neither is a source of truth for a definition.

**`agent_ui_state` — roster-owned**, shipped in roster's own migration set (foundation §1.3), holding
no definition fields:

| `agent_ui_state` | |
|---|---|
| `agent_id` TEXT PK | matches the folder name |
| `board_order` INTEGER | drag-and-drop card position on the roster board |
| `pinned` INTEGER | |
| `last_used_at` TEXT | derived convenience for sorting; authoritative history lives with sessions |

Rationale: board order changes every time the user drags a card. Putting it in `agent.json` would
produce a git diff per drag. It is also worthless in an export.

**`agents` — foundation-owned, rebuildable index** (foundation §1.4). It exists so other elements'
tables can join and filter on an agent without reading the library. Roster **feeds** it: on every
registry mutation, including an externally edited file, roster emits `roster.changed` and pushes the
current projection through the service registry, and foundation writes what it is given. Roster
**never reads it as truth** — every roster read is served from the in-memory registry (§2.3), whose
truth is the files. If the index and the files disagree, the index is wrong and is rebuilt.

Everything else that references an agent (sessions, assignments, mailboxes) stores `agent_id TEXT`
in foundation's database. Referential integrity is advisory: roster guarantees ids are stable and
never reused, and archives rather than deletes (§9), so historical rows always resolve.

### 2.3 In-memory registry

The roster module loads every `agent.json` at startup into an in-memory `Map<AgentId,
ResolvedAgent>`, validates each, and watches the directory (debounced, ~250 ms) for external edits
— so hand-editing a persona in an editor, or `git pull`ing a roster, is a first-class workflow.
Reads are served from memory; writes go through the store (atomic temp-file + rename) and then
update the map. A file that fails validation is kept out of the registry and surfaced as a
`RosterDiagnostic` the UI can display on the board — never a crash, never a silent drop.

---

## 3. Agent definition schema (v1)

`agent.json`. Field names are the wire format for the HTTP API too.

```jsonc
{
  "schemaVersion": 1,
  "id": "priya-bugfix",                     // slug, immutable, [a-z0-9-], unique
  "name": "Priya",                          // display name on the card
  "avatar": { "kind": "emoji", "value": "🐛" },
  //  or   { "kind": "file",  "value": "avatar.png" }
  //  or   { "kind": "initials", "value": "PB", "color": "#7c5cff" }

  "specialty": "bug-patching",              // enum, see §3.1
  "tagline": "Reproduces first, then fixes.",  // one line under the name on the card
  "tags": ["backend", "php"],

  "persona": {
    "mode": "append",                       // "append" | "replace"  — see §5
    "file": "persona.md"
  },

  "model": {
    "primary": "sonnet",                    // alias or full id, see §8
    "fallback": "haiku",                    // optional
    "effort": "high"                        // optional: low|medium|high|xhigh|max
  },

  "permissions": {
    "mode": "acceptEdits",                  // agent's own ceiling, see §6
    "allow": ["Read", "Glob", "Grep", "Edit", "Bash(npm run test:*)"],
    "deny":  ["Bash(rm *)", "Bash(git push*)", "WebFetch"],
    "ask":   ["Bash(git commit*)"]          // expressed via settings block, see §6.3
  },

  "settingSources": ["project"],            // see §7.3; "user"/"local" are rejected

  "skills": {
    "mode": "declared",                     // "declared" | "all" | "none"
    "names": ["triage-a-stack-trace"]       // folder names under skills/
  },

  "integrations": {                         // per-agent MCP servers, see §10
    "gmail": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@example/gmail-mcp"],
      "env": { "GMAIL_TOKEN": { "secretRef": "mcp.gmail.token" } },
      "toolPrefixHint": "mcp__gmail__"      // derived, stored for UI display only
    }
  },

  "capabilities": {
    "overseer": false,                      // see §11
    "roles": ["implementer", "skeptic", "reviewer"]
    // collaboration slots this agent can fill; closed v1 vocabulary:
    // implementer | architect | skeptic | reviewer | overseer (foundation §1.4)
  },

  "defaults": {
    "maxTurns": 60,
    "maxBudgetUsd": 2.50,
    "concurrencyWeight": 1                  // hint to runner's cap; 1 unless heavy
  },

  "meta": {
    "createdAt": "2026-08-16T10:00:00Z",
    "updatedAt": "2026-08-16T10:00:00Z",
    "origin": "drafted",                    // "drafted" | "manual" | "duplicated" | "imported" | "seed"
    "duplicatedFrom": null
  }
}
```

Validation is a Zod schema exported as `@agentmanager/roster` types; the same schema validates
disk loads, HTTP writes, and imports. Unknown top-level keys are **rejected**, not ignored, so a
newer export cannot silently lose fields on an older build.

### 3.1 Specialty

`specialty` is a closed enum in v1 (the UI filters and colour-codes by it, and the drafting wizard
must pick one):

`bug-patching` · `feature-implementation` · `code-review` · `testing` · `documentation` ·
`research` · `email-response` · `overseer` · `general`

`specialty: "overseer"` is a label; `capabilities.overseer` is the switch (§11). Free-form
specialisation goes in `tags` and the persona, not here. Adding an enum member is a schema-version
bump.

### 3.2 Avatar

Three kinds so the UI never has to handle a missing image: an emoji (default, what the wizard
produces), a file inside the agent folder, or initials + colour. Files are served by the core from
the roster directory; the API never returns filesystem paths to the browser, only
`/api/roster/agents/:id/avatar`.

---

## 4. Persona file

`persona.md` is plain markdown with no frontmatter — the whole file is the prompt body. Keeping it
frontmatter-free means the same file can be dropped into `append` or `replace` mode unchanged, and
that non-technical editing (the UI's textarea) round-trips byte-for-byte.

Role addenda in `roles/<role>.md` are optional and appended **after** the persona when the
orchestrator assigns that agent to that collaboration role — so one "Priya" can be a normal
implementer on a solo assignment and a sharpened skeptic inside an adversarial pair, without a
second definition. Composition order is fixed:

```
[Claude Code preset, unless mode=replace]
+ persona.md
+ roles/<role>.md            (only if orchestrator supplied a role)
+ project instructions       (only if projects supplied instructionsPath content)
+ AgentManager runtime block (agent id, agent name, assignment id, orchestrator etiquette)
```

The fourth slot is the project brief: projects resolves `defaults.instructionsPath` and hands the
text over on `ProjectContext` (§13); roster appends it verbatim. It sits after the role addendum
because who the agent *is* outranks where it is pointed, and before the runtime block because the
runtime block is the last word. Note this is **not** the repo's `CLAUDE.md` — `settingSources:
["project"]` already loads that (§7.3). The slot is for briefs the repo does not carry.

The runtime block is generated by roster's option compiler, is short, and is the only text roster
injects on its own behalf. It exists so an agent knows who it is when the orchestrator relays a
message from another agent.

---

## 5. How the persona is applied

**Decision: system-prompt append onto the `claude_code` preset by default; full replacement as an
explicit opt-in; output styles rejected.**

The Agent SDK's `systemPrompt` option takes either a string (total replacement) or
`{ type: 'preset', preset: 'claude_code', append: '…' }`. Two facts drove the decision:

1. **Omitting `systemPrompt` does not give you the Claude Code prompt** — it gives a minimal
   tool-calling prompt. Coding agents lose the tool discipline, file-editing conventions, and
   safety guidance that make them competent. So the preset must be requested explicitly; there is
   no useful "default" to fall back on.
2. **Output styles are filesystem-only** (`~/.claude/output-styles/` or `.claude/output-styles/`)
   and load only when `settingSources` includes `user` or `project`. Reaching them from the SDK
   means the inline `settings` object, and pointing agents at host-machine style files is exactly
   the config leakage §7.3 forbids. The SDK docs recommend `append` or a custom string for
   code-only deployments. Rejected.

So:

| `persona.mode` | Compiles to | Use for |
|---|---|---|
| `append` (default) | `{ type: 'preset', preset: 'claude_code', append: <composed persona> }` | Every agent that touches a codebase |
| `replace` | `<composed persona>` as a plain string | Non-coding identities — the email responder, a pure-research agent — where Claude Code's file-editing framing is noise or actively wrong |

`replace` is a sharp edge: the definition takes on responsibility for tool guidance. The UI must
label it as such, and the drafting wizard only ever proposes `replace` when the drafted specialty
is `email-response` or `research` with no filesystem tools in the allow list.

**Prompt-cache note.** The compiler sets `excludeDynamicSections: true` (SDK ≥ 0.2.98) on the
preset form. Per-session context (cwd, git flag, platform) then moves into the first user message
instead of the system prompt, so N agents launched against N different projects share one cached
prompt prefix. Under D2's shared rate-limit windows this is a real saving, not a micro-optimisation.
If the installed SDK predates the field, the compiler omits it — behaviour is identical, caching is
just worse.

---

## 6. Permissions: roster baseline × project override × assignment scope

### 6.1 The SDK semantics this must respect

Three facts that a naive design gets wrong:

- `allowedTools` is an **auto-approve list, not a restriction list.** Tools not listed still exist
  and fall through to `permissionMode` / `canUseTool`. It cannot be used to lock an agent down.
- `disallowedTools` has two behaviours: a **bare tool name** (`"WebFetch"`) removes the tool
  definition entirely; a **scoped rule** (`"Bash(rm *)"`) keeps the tool and denies matching calls
  in every mode — including `bypassPermissions`.
- Evaluation order is: hooks → deny rules → ask rules → permission mode → allow rules →
  `canUseTool`. Auto-approved calls never reach `canUseTool`.

Consequence: **restriction is expressed with `deny`, never by omission from `allow`.** Roster's
compiler therefore always emits an explicit deny set, and specifies a default-deny `canUseTool`
*policy*: anything not covered by the effective allow set is denied unless a human answers (the
last line of defence). The callback itself is **installed by the runner** (runner DESIGN §5.1),
which implements this policy and layers its question bridge on top — roster's compiler does not
set the `canUseTool` field, and roster remains the sole composer of rules and modes. `permissionMode: "bypassPermissions"` is **not
selectable** from the roster schema at all — the only way to get it would be a foundation-level
config escape hatch, and v1 does not provide one.

### 6.2 Composition

Three layers, resolved by roster at session-launch time:

1. **Roster baseline** — the agent's own `permissions`, the ceiling for that identity.
2. **Project override** — from the projects element's per-project settings.
3. **Assignment scope** — from orchestrator, when an assignment restricts the agent to a subsystem
   or path set.

Composition is **monotonically narrowing**:

| | Rule |
|---|---|
| `deny` | **Union.** Any layer can forbid. Nothing can un-forbid. |
| `ask` | **Union.** Any layer can require a human gate. |
| `allow` | **Intersection.** A project can only remove auto-approvals, never add them. |
| `mode` | **Minimum** on the ordered ladder `plan < dontAsk < default < acceptEdits`. |

The ladder assumes a specific reading of `dontAsk`: **never prompt the user, and auto-reject anything
not already allowed.** On that reading it is *less* permissive than `default` (which prompts, and a
human may say yes) and *more* permissive than `plan` (which executes no mutations at all). If M0's
SDK verification finds `dontAsk` instead behaves as "never prompt, auto-*approve*", the ladder is
wrong and the ordering must be revised before the compiler ships — this is the one place in §6 where
a naming assumption is doing load-bearing work.

Two foundation-level inputs sit outside the three layers. `policy.globalDeny` (foundation §2.3) is
unioned into `deny` before anything else and no layer can remove it. `policy.allowPermissionElevation`
gates the escape hatch below: when it is false — as the work edition sets it — a declared elevation
is dropped and a diagnostic is emitted, rather than silently applied.

Path-scoped rules from an assignment (`Edit(./services/billing/**)`) are intersected into `allow`
and the complement is added to `deny`, so an assignment's scope becomes *enforced*, not advisory —
answering one of orchestrator's open questions from the roster side.

**One escape hatch, deliberately loud.** A project may declare
`permissionElevation: { allow: [...], reason: "..." }`. This is the only way to widen past the
roster baseline. It requires the reason string, it is surfaced on the launch flow and in the
session header, and every elevated session is logged with the elevation set. It exists because a
sandbox project legitimately wants a normally-cautious agent to run freely; it must never be
invisible.

Compilation is a pure function — `compilePermissions(baseline, projectOverride, assignmentScope,
policy) → EffectivePermissions` — with a table-driven test suite. It is the highest-risk logic in
the element, and it is the **only** composer in the system: projects and orchestrator each store and
hand over raw rule inputs, and neither computes an effective set of its own. Two implementations of
this table would disagree, and the disagreement would be a permission bug.

### 6.3 `ask` rules

`ask` rules cannot be expressed through `allowedTools`/`disallowedTools`; they only exist in
settings. The compiler emits them through the SDK's inline `settings` object rather than writing
files. Anything matching an `ask` rule reaches `canUseTool`, which the runner routes to the
orchestrator's question card and the UI's inbox — the same channel as `AskUserQuestion`.

---

## 7. Skills packaging

### 7.1 Decision

**Per-agent `skills/` folder inside the agent folder, mounted as a local plugin.**

Skill discovery via `settingSources` only ever looks at `~/.claude/skills/` (user) and
`<cwd>/.claude/skills/` upward (project). Neither works for us: the agent's skills live with the
*agent*, not with the host machine or the target project, and the same agent must carry its skills
into every project it is pointed at. The supported route for skills outside cwd is the `plugins`
option:

```ts
plugins: [{ type: "local", path: "<libraryRoot>/agents/<id>" }]
```

So the agent folder *is* a plugin. Roster generates `.claude-plugin/plugin.json` (name = agent id,
version = `meta.updatedAt`) on every write; it is not hand-edited and is regenerated if missing.
Skills are then namespaced `<agent-id>:<skill-name>`, which conveniently makes it obvious in a
transcript which agent's skill fired.

Consequences the implementation must handle: a nonexistent plugin path is **silently skipped**, and
`~` is not expanded. The compiler therefore uses absolute paths and the runner asserts that the
`system`/`init` message's `plugins` and `skills` arrays contain what was requested, raising a
session-start diagnostic if not.

### 7.2 Enable set

`skills.mode` maps to the SDK `skills` option: `"declared"` → the exact `names` array, `"all"` →
`"all"`, `"none"` → `[]`. Names must be exact — no wildcards, no padding — or the SDK throws before
the process starts, so roster validates names against the folder listing at write time and again at
launch. Setting the option auto-adds the `Skill` tool; the compiler also adds `"Skill"` to the
effective allow set so it is auto-approved rather than prompting.

Note that skills are a **context filter, not a sandbox**: a disabled skill's files are still
readable via `Read`/`Bash`. Nothing in roster's security model may depend on skill scoping.
`allowed-tools` in SKILL.md frontmatter is ignored under the SDK — tool control is entirely §6.

### 7.3 `settingSources` policy

**Default `["project"]`. `"user"` and `"local"` are rejected by schema validation.**

`project` is what makes an agent respect the target repo's `CLAUDE.md`, `.claude/rules/`, and
`.mcp.json` — genuinely valuable, and the reason a coding agent behaves like a member of that
project's team. `user` and `local` would load the *host machine owner's* personal Claude Code
configuration into every agent: their memory, their hooks, their MCP servers, their output styles.
That is config leakage across an identity boundary and is never what the roster means.

`settingSources: []` is permitted for agents that must be hermetic (the email responder has no
project). Foundation's config also sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and a dedicated
`CLAUDE_CONFIG_DIR` in the child environment, since auto-memory and the global config are read
*regardless* of `settingSources`.

---

## 8. Model selection

`model.primary` accepts either an alias (`opus`, `sonnet`, `haiku`, `default`, `best`, and the
`opusplan` / `[1m]` variants) or a full model id (`claude-opus-5`, `claude-sonnet-5`,
`claude-haiku-4-5`, …). **Aliases are the default and what the wizard produces**: under D2 the
service runs on the owner's subscription, aliases track the current generation without a roster-wide
edit, and the UI's model picker stays three options wide instead of a dropdown of dated ids. Full
ids are allowed for pinning a known-good model to a fussy agent.

Validation is a warn-not-block list: an unrecognised string is accepted with a diagnostic, because
a model released after this build ships must not make an agent unloadable.

`model.fallback` maps to the SDK `fallbackModel`. `model.effort` is passed through where the SDK
exposes it (subagent-level today; top-level where available) and is otherwise dropped with a
diagnostic rather than failing the session.

Cost discipline, which orchestrator depends on: secondary roles (`skeptic`, `reviewer`) should
default to a cheaper model than the primary. Roster expresses this only as the *default* on the
definition; the orchestrator may not silently downgrade a model the user chose — it may only refuse
to start an assignment whose projected cost exceeds its budget.

---

## 9. CRUD, duplicate, import/export

### 9.1 API

All under `/api/roster`, served by the core's router (D3), so the remote listener (D5) covers it
with no roster-specific work.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/agents` | list; includes `uiState` and any `diagnostics` |
| `GET` | `/agents/:id` | full definition + resolved persona text |
| `POST` | `/agents` | create; id derived from name if absent, collision-suffixed |
| `PATCH` | `/agents/:id` | partial update; `id` immutable |
| `DELETE` | `/agents/:id` | archive (soft); `?purge=true` only when no sessions reference it |
| `POST` | `/agents/:id/duplicate` | see below |
| `GET` | `/agents/:id/export` | `.agentpack` (zip) download |
| `POST` | `/import` | multipart `.agentpack`; returns a preview or commits with `?commit=true` |
| `POST` | `/draft` | draft-from-description (§12) |
| `POST` | `/agents/:id/validate` | dry-run compile against a project id, returns effective permissions |
| `GET` | `/agents/:id/avatar` | image or generated placeholder |
| `PUT` | `/agents/:id/avatar` | multipart upload; written into the agent folder as `avatar.png` and sets `avatar: { kind: 'file', value: 'avatar.png' }` (§9.5) |
| `PUT` | `/board-order` | `{ order: string[] }` — whole-list rewrite of `agent_ui_state.board_order` (§9.5) |
| `PATCH` | `/agents/:id/ui-state` | `{ pinned }` — the other `agent_ui_state` field the board toggles |
| WS | `roster.changed` | broadcast on any registry mutation, including external file edits |

`POST /agents/:id/validate` exists for the UI: before launching, show the user the *effective*
permission set for this agent on this project, including any elevation. Permission composition
that the user cannot see is permission composition they will not trust.

### 9.2 Duplicate-and-edit

A first-class operation, not `GET` + `POST`. `POST /agents/:id/duplicate` with an optional
`{ name }`:

- deep-copies the entire folder (persona, roles, skills, avatar);
- mints a new id from the new name (`priya-bugfix` → `priya-bugfix-2` if no name given);
- sets `meta.origin = "duplicated"`, `meta.duplicatedFrom = <sourceId>`, fresh timestamps;
- **copies integrations including `secretRef` names** — the clone points at the same secrets, which
  is almost always intended, and foundation's secret store is keyed by ref not by agent;
- returns the new definition so the UI can open it straight into the editor.

Skills are copied, not linked. Shared skills between agents is a v2 concern; copying keeps the
folder the self-contained unit that export and git-versioning depend on.

### 9.3 Archive vs delete

`DELETE` moves the folder to `roster/.archive/<id>-<timestamp>/` and removes it from the registry.
Sessions and assignments that reference the id still resolve (roster can read archived definitions
for display), and ids are never reused. Hard purge is available only when no session history
references the agent, and is a separate explicit flag — protecting the invariant that a transcript
can always name who produced it.

### 9.4 Import / export

`.agentpack` is a zip of the agent folder plus a `manifest.json`:

```jsonc
{
  "packVersion": 1,
  "schemaVersion": 1,
  "agentId": "priya-bugfix",
  "exportedAt": "…",
  "requiredSecrets": [
    { "ref": "mcp.gmail.token", "usedBy": "integrations.gmail.env.GMAIL_TOKEN",
      "description": "Gmail MCP OAuth token" }
  ]
}
```

**No secret values are ever written into a pack** — only refs and a human-readable manifest of what
the importer must supply. Import is two-phase: `POST /import` returns a preview (proposed id,
collisions, missing secrets, unknown schema fields, skills being added) and `?commit=true` writes
it. On id collision the importer picks a new id and rewrites nothing else. An import whose
`schemaVersion` is newer than the build is refused with the version numbers named, not
best-effort-parsed.

This makes "here's my code-reviewer agent" a shareable artefact, which is the point of file-based
storage.

### 9.5 Writing `agent_ui_state`, and uploading an avatar

**`PUT /board-order { order: string[] }`** (ui §19, R2). Roster owns `board_order` (§2.2) and returns
it as `uiState` on `GET /agents`; this is the write path. It takes the **whole list** and rewrites
every row's `board_order` in one transaction — idempotent, and atomic in the sense that the board
either has the new order or the old one. A per-card `PATCH` was rejected: dragging one card changes
the position of every card after it, so per-card writes would mean N requests and, on a dropped
connection, a torn order with duplicate or missing positions. Ids not in the roster are rejected
(400) rather than silently dropped; ids omitted from `order` keep their relative order after the
listed ones. Emits `roster.changed`. `PATCH /agents/:id/ui-state { pinned }` covers the only other
board-owned field; both write `agent_ui_state` in SQLite and neither touches `agent.json`, which is
the whole reason the table exists.

**`PUT /agents/:id/avatar`** (ui §19, R7) closes the write path for `avatar.kind: 'file'` (§3.2),
which the schema and `GET /agents/:id/avatar` supported but nothing could set. Multipart upload,
capped by size (default 1 MB) and MIME type (`image/png`, `image/jpeg`, `image/webp`), transcoded or
rejected — never stored under a caller-supplied filename. It is written into the agent folder as
`avatar.png` via the same atomic temp-file + rename path as any other authored content (§2.3), and
`agent.json` is updated to `{ "kind": "file", "value": "avatar.png" }` in the same operation, so the
folder stays self-describing and duplicate/export carry the image with no special case. `DELETE` on
the same path removes the file and reverts the definition to its emoji or initials.

---

## 10. Integrations (per-agent MCP servers)

**Decision: yes, the roster schema carries per-agent MCP server configs. Credentials are references
only; resolution is foundation's.**

An email-responder agent is defined by its mailbox access as much as by its persona — the
integration belongs to the identity, not to the project. Putting it anywhere else means the same
agent behaves differently depending on where it is pointed, which is exactly the confusion the
roster exists to prevent.

`integrations` is a `Record<name, IntegrationConfig>` compiled directly into the SDK's `mcpServers`
option:

| Transport | Compiles to |
|---|---|
| `stdio` | `{ command, args, env }` |
| `sse` | `{ type: "sse", url, headers }` |
| `http` | `{ type: "http", url, headers }` — note the programmatic option accepts `"http"` only; `"streamable-http"` is a `.mcp.json`-only alias |

**Credential handling.** Any `env` or `headers` value may be either a literal string or
`{ "secretRef": "<key>" }` — *except* that a key whose name matches `*TOKEN*`, `*KEY*`, `*SECRET*`,
`*PASSWORD*`, or `AUTH*` (case-insensitive) **must** be the `{ secretRef }` form; a literal there is
a schema validation error naming the key. This one rule is the definition of "looks like a
credential" for the whole system — foundation's load-time rejection of credential-shaped values
(foundation §3.3) is this rule applied at a different moment, not a second heuristic with its own
drift. Roster stores only the ref. At session launch the compiler asks
foundation's secret provider to resolve refs; an unresolved ref fails the launch with a clear
"agent Priya needs secret `mcp.gmail.token`" error rather than starting a session whose tools will
silently 401. Secrets never enter `agent.json`, never enter git, never enter an export, and never
appear in a definition returned over the API — the API returns `{ secretRef, resolved: true|false }`
so the UI can show a "needs credential" badge on the card.

Two implementation constraints inherited from the SDK:

- The TypeScript SDK's `env` option **replaces** the child environment rather than merging it. The
  compiler must spread the base environment; losing `PATH` breaks stdio servers in ways that look
  like MCP bugs.
- `${VAR}` expansion works in `.mcp.json` but **not** in the programmatic `mcpServers` option, so
  all interpolation happens in our code.

**Tool naming.** MCP tools are namespaced `mcp__<server>__<tool>`. Permission rules use that form,
and wildcards are supported after the literal prefix (`mcp__gmail__*`, `mcp__gmail__read_*`). Note
`acceptEdits` does **not** auto-approve MCP tools — an integration agent that should not prompt on
every mailbox read needs explicit `mcp__gmail__*` entries in `allow`. Roster's validator warns when
an agent declares an integration but has no matching allow rule, because the failure mode otherwise
is a session that stalls on a permission prompt nobody expected.

Servers report `pending | connected | failed | needs-auth | disabled` in the session's init
message; roster exposes the mapping so the runner can surface `needs-auth` as an actionable card
rather than a generic failure.

---

## 11. What makes an agent overseer-capable

`capabilities.overseer: true`. Under D4 the app orchestrates — AgentManager routes work between
agents; agents do not spawn their own hidden sub-hierarchies. So the overseer flag deliberately does
**not** grant the SDK's `Agent` (subagent) tool. What it grants:

| Overseer gets | Because |
|---|---|
| The `agentmanager` in-process MCP toolset — all six of `list_roster`, `create_assignment`, `send_to_agent`, `read_mailbox`, `report_status`, `request_user_decision` | This is the D4 orchestration surface. A worker agent gets a subset: four of the six (below). |
| Read access to the roster (names, specialties, tags, capabilities — never permissions or integrations) | It cannot delegate to people it cannot see. It has no business knowing their credentials. |
| A higher default `maxTurns` and `maxBudgetUsd` | Coordination is turn-expensive and produces little output per turn. |
| A model floor (validator warns below `sonnet`) | Decomposition and convergence judgement are the tasks least tolerant of a weak model. |
| Permission to be an assignment **lead** | Orchestrator refuses to start a pattern whose lead slot is filled by a non-overseer agent. |
| A required `roles` entry containing `overseer` | Keeps role matching uniform rather than special-casing the flag. |

What it explicitly does **not** get: the `Agent`/subagent tool, write access to other agents'
definitions, the ability to raise its own or anyone else's permission ceiling, or the ability to
approve its own budget overrun. An overseer is a coordinator, not an admin. Any escalation it wants
goes through the orchestrator's approval gate to the human.

**The worker grant is four tools, not two** (orchestrator §17, R1b):

| Tool | Overseer | Worker | Why the worker needs it |
|---|---|---|---|
| `list_roster` | ✔ | — | Delegation needs visibility; a worker delegates nothing. |
| `create_assignment` | ✔ | — | Creating work is the coordinator's act (D4). |
| `send_to_agent` | ✔ | ✔ | Reply to the agent it is paired with. |
| `read_mailbox` | ✔ | ✔ | Receive what was sent to it. |
| `report_status` | ✔ | ✔ | The structured completion channel orchestrator's convergence rule reads. Without it a worker can only report in prose, and there is no machine-readable "done". |
| `request_user_decision` | ✔ | ✔ | Without it a worker's recommendation cannot reach a question card, which disables the per-agent aggregation the product requires. |

None of the four creates work, reveals the roster, or reaches outside the assignment. **All four remain
assignment-scoped inside the MCP server**, not by permission rule: rules match tool *names* and cannot
express "only your own assignment", so the scoping is a check in the tool implementation against the
assignment id the session was launched under (orchestrator §4.2). Roster's contribution is the allow
rules for the tool names and nothing more.

The in-process MCP server itself (`createSdkMcpServer` / `tool`) is built by the orchestrator
element; roster only declares *who is allowed to be handed it*, and compiles the corresponding
`mcp__agentmanager__*` allow rules. When the orchestrator module is disabled
(`modules.orchestrator.enabled: false`), those tools do not exist: the compiler emits a diagnostic
and drops every `mcp__agentmanager__*` rule rather than compiling allow rules for a server that will
never be mounted.

---

## 12. Draft-from-description

The API behind the UI's agent wizard. Stateless: no server-side draft records, no draft ids. The
server returns a complete proposed definition; the user edits it client-side; saving is an ordinary
`POST /agents`. This keeps "draft → tweak → save" and "duplicate → tweak → save" the same code path
in the UI and leaves no orphan state to garbage-collect.

### 12.1 Request

```jsonc
POST /api/roster/draft
{
  "description": "Someone who watches our PHP sites for 500s and patches them, but always writes a failing test first",
  "hints": {                                  // all optional
    "name": "Priya",
    "specialtyHint": "bug-patching",
    "modelTier": "balanced",                  // "fast" | "balanced" | "max"
    "projectId": "littlepocketmuseum",        // lets Claude see stack/tooling for tool suggestions
    "overseer": false
  }
}
```

### 12.2 What Claude generates

One `query()` call, via the same Agent SDK and the same subscription auth as everything else — no
second auth path, no second SDK dependency. It runs deliberately inert: `allowedTools: []`,
`settingSources: []`, `skills: []`, no MCP servers, `permissionMode: "dontAsk"`, a short
`maxTurns`, and `systemPrompt` as a full replacement string (this is not a coding task; the Claude
Code preset is pure overhead here). Model: `sonnet` by default — drafting is a small structured task
and it must feel instant in a wizard.

The Agent SDK has no structured-output constraint, so reliability comes from the harness rather than
the API: the system prompt demands a single fenced JSON object, the response is extracted and
validated against a draft-specific Zod schema, and **one** repair round-trip is attempted on failure
(the validation errors are handed back verbatim). A second failure returns a partial draft — the
fields that did validate, plus the raw text — so the wizard degrades into "here's a starting point,
finish it yourself" rather than a dead end.

Claude is asked to produce:

- `name`, `avatar` (emoji), `tagline`, `specialty` (from the enum), `tags`
- `persona` — the full markdown body, written in second person, 150–400 words, describing working
  style and standards rather than restating tool mechanics
- `personaMode` — `append` unless the specialty is non-coding
- `model` — mapped from `modelTier`, overridable
- `permissions` — a suggested `allow`/`deny`/`ask` set drawn from a fixed catalogue of tool rules
  supplied in the prompt, so it cannot invent tool names that do not exist
- `capabilities.roles` — which collaboration slots this person suits
- `suggestedSkills` — names + one-line descriptions only, **not** skill bodies (writing skills is a
  separate, larger job; see Deferred)
- `suggestedIntegrations` — server names + why, with `secretRef` placeholders and never a credential
- `rationale` — a short string **per field group**, which the wizard renders beside each section

### 12.3 Response

```jsonc
{
  "draft": { /* an agent.json-shaped object, minus id/meta */ },
  "persona": "…markdown…",
  "rationale": {
    "specialty": "The description centres on diagnosing production errors…",
    "permissions": "Given test-first patching, Edit and the test runner are auto-approved; git push is denied…",
    "model": "…"
  },
  "suggestedSkills": [{ "name": "triage-a-stack-trace", "description": "…" }],
  "suggestedIntegrations": [],
  "warnings": ["Suggested `replace` persona mode — this agent will not receive Claude Code's coding guidance."],
  "degraded": false
}
```

### 12.4 Applying the user's tweaks

The wizard edits the returned object directly. On save it `POST`s to `/agents` like any other
create, with `meta.origin: "drafted"`. Two rules keep this honest:

- The **user's edits always win.** There is no merge, no re-draft-on-save, no server-side
  reconciliation — the object the wizard posts is the object that is written.
- `suggestedSkills` are inert until accepted. Accepting one creates
  `skills/<name>/SKILL.md` with the description as a stub and adds the name to `skills.names`; the
  user (or a later agent session) writes the body.

A "redraft" button re-calls `/draft` with the original description plus the user's current edits as
additional context, and returns a fresh independent draft — it never silently overwrites the
in-progress form.

---

## 13. Compiling a definition into a session

The contract runner consumes. One exported function, the only place SDK option shapes appear:

```ts
compileSession(input: {
  agent: ResolvedAgent;
  project?: ProjectContext;          // cwd, permissionOverride, elevation, env, instructions, workspace
  assignment: AssignmentContext;     // id, role, scope rules, budget — always present (D4: every
                                     // session belongs to an assignment, solo included)
  secrets: SecretResolver;
}): Promise<{
  options: ClaudeAgentSdkOptions;    // the object handed to query()
  effective: EffectivePermissions;   // for display and audit
  diagnostics: Diagnostic[];
}>
```

`ProjectContext` is raw input, never a computed result. Its fields:

```ts
interface ProjectContext {
  projectId: string;
  cwd: string;                       // the leased workspace root, not necessarily project.localPath
  permissionOverride?: PermissionSet;        // allow / deny / ask / mode, in roster's vocabulary
  elevation?: { allow: string[]; reason: string };   // the §6.2 escape hatch, gated by policy
  env: EnvEntry[];                   // literal values and secretRefs, already ordered by projects
  instructions?: string;             // resolved project brief text → the §4 fourth slot
  workspace: { kind: 'primary' | 'worktree'; path: string; branch: string | null };
}
```

Roughly:

| Definition | SDK option |
|---|---|
| `persona` + role addendum + **project instructions** + runtime block | `systemPrompt` (§5, §4) |
| `permissions` composed (§6) | `allowedTools`, `disallowedTools`, `permissionMode`, `settings.permissions` for `ask`, default-deny `canUseTool` policy (callback installed by runner) |
| `skills` | `plugins: [{ type: "local", path: agentDir }]` + `skills` |
| `settingSources` | `settingSources` |
| `integrations` (+ resolved secrets) | `mcpServers` (per-agent servers) |
| the orchestration toolset (§11) | `mcpServers.agentmanager` — the per-launch server instance obtained from `ctx.require('orchestrator')?.getSessionToolset({ assignmentId, agentId, role, isOverseer })` |
| `model` | `model`, `fallbackModel` |
| `defaults` | `maxTurns`, `maxBudgetUsd` |
| project | `cwd`, `additionalDirectories` |
| foundation + project + assignment env | `env` — the **final** merge happens here and only here |

**Mounting the orchestration toolset is `compileSession`'s job** (orchestrator §17, R1). Roster calls
`ctx.require('orchestrator')?.getSessionToolset({ assignmentId, agentId, role, isOverseer })` and
places the returned per-launch MCP server instance at `options.mcpServers.agentmanager`, alongside the
agent's own integration servers. The instance is per launch because it closes over the assignment id
that scopes every tool call (§11); orchestrator decides which of the six tools that instance actually
exposes, and roster compiles the matching `mcp__agentmanager__*` allow rules for the same set. When
`require('orchestrator')` returns `undefined` the key is simply omitted, together with §11's existing
diagnostic and the dropping of every `mcp__agentmanager__*` rule — unchanged. This keeps SDK option
shaping in exactly one element: runner's option whitelist (runner §3.3) does not gain `mcpServers`.

The env merge is roster's, in one place, in this order (later wins): base process env (spread, never
replaced — see §10) → foundation's `agentEnv` (`CLAUDE_CODE_DISABLE_AUTO_MEMORY`,
`CLAUDE_CONFIG_DIR`) → the project's resolved entries → the assignment's. Projects orders its own
entries and resolves nothing; it hands roster a list, and roster resolves every `secretRef` through
`SecretResolver` at this moment (the authorized `.reveal()` site, foundation §3.2).

Runner owns everything after this: streaming, `resume`, `abortController`, the question bridge,
usage metering. Roster never calls `query()` except for the drafting call in §12.

---

## 14. Editions and architecture conformance

- **D1** — a plain TypeScript module registered with the core through foundation's module system;
  no PowerShell, no runtime scripts.
- **D2** — model aliases and per-agent `maxTurns` / `maxBudgetUsd` / `concurrencyWeight` are the
  knobs runner's cap and queue read. Auth is untouched by roster; roster only ensures the compiled
  `env` does not clobber it (and foundation's startup warning covers `ANTHROPIC_API_KEY`, which
  outranks `CLAUDE_CODE_OAUTH_TOKEN` in Claude Code's precedence order).
- **D3** — one HTTP + WS API surface consumed by the single web frontend in both delivery modes.
- **D4** — `capabilities.overseer` is the roster-side expression of app-orchestration; the SDK's own
  subagent tool stays off.
- **D5** — no roster-specific remote logic; the remote element binds and authenticates the same
  router.
- **D6** — edition is configuration. The work edition may restrict the selectable model set and
  forbid `permissionElevation` through a foundation config overlay; the same definitions load in
  both editions, and a definition never encodes an edition.

**Policy note worth stating once.** Anthropic's Agent SDK guidance is that subscription
(claude.ai) login and rate limits are not for third-party products without prior approval. As an
owner-operated tool on the owner's own subscription this is fine; if AgentManager is ever offered
to other people, auth moves to an API key or Bedrock/Vertex — which D6 already makes a
configuration change rather than a code change.

---

## 15. Decisions

Every open question from [README.md](README.md), answered.

**1. File-based (one folder per agent) vs. database?**
**File-based, one folder per agent; SQLite only for board order / pinning / last-used.** A
definition is mostly prose, so files make review, diff, duplicate, export, and `git pull` of a
shared roster all trivial; splitting it would create two sources of truth for one object. The bits
that would churn git on every UI drag are the only bits in the database.

**2. How do roster-level tool permissions compose with per-project settings?**
**Monotonically narrowing: deny and ask union, allow intersects, mode takes the minimum.** The
roster is the ceiling for an identity; a project can only tighten it. The single widening path is a
project's explicit `permissionElevation`, which requires a reason and is surfaced in the launch flow
and the session header — because invisible privilege escalation is the failure mode worth
engineering against. Assignment scope narrows further, which makes orchestrator's scoping enforced
rather than advisory.

**3. Persona: system-prompt append, full replacement, or output style?**
**Append onto the `claude_code` preset by default; full replacement as an explicit per-agent
opt-in; output styles rejected.** Omitting `systemPrompt` yields a minimal tool-calling prompt, not
the Claude Code one, so the preset must be requested deliberately — and appending keeps the coding
discipline that makes agents competent. Replacement exists for identities where that framing is
wrong (email, research). Output styles are filesystem-discovered, need `user`/`project` setting
sources, and the SDK docs steer code-only deployments to `append` instead.

**4. How are agent-specific skills packaged?**
**A `skills/` folder inside the agent folder, mounted as a local plugin
(`plugins: [{ type: "local", path: agentDir }]`).** `settingSources`-based discovery only sees
`~/.claude/skills` and the project tree, neither of which travels with an agent. The plugin route is
the SDK's supported path for skills outside cwd, keeps the agent folder self-contained for
duplicate/export, and namespaces skills as `<agent-id>:<skill>` so transcripts show whose skill
fired.

**5. Do agents get per-agent MCP server configs, and where do credentials live?**
**Yes — `integrations` on the definition; credentials are `secretRef` strings resolved by
foundation at launch.** A mailbox is part of who the email responder *is*, not part of where it is
pointed. Storing refs rather than values keeps secrets out of git, out of exports, and out of API
responses, while the export manifest still tells an importer exactly which secrets they must
provide. Unresolved refs fail the launch loudly instead of producing tools that silently 401.

**6. What distinguishes an overseer-capable agent?** (implied by the README's fourth
responsibility)
**`capabilities.overseer: true`, granting the orchestrator's in-process MCP toolset, read-only
roster visibility, higher turn/budget defaults, a model-floor warning, and eligibility to lead an
assignment — and explicitly *not* the SDK's subagent tool.** D4 chose app-orchestration; letting an
overseer spawn its own hidden hierarchy would route work outside the layer that owns budgets,
mailboxes, and question aggregation. An overseer coordinates; it is not an administrator, and it
cannot raise anyone's permissions including its own.

**7. Which model does drafting use, and how?**
**One inert `query()` on `sonnet` through the same SDK and subscription auth, with JSON-in-fence
extraction, schema validation, and a single repair retry.** A second SDK or a raw Messages API call
would mean a second auth path for no gain, and subscription OAuth is not a supported credential for
the raw API. Drafting is a small, latency-sensitive task, so Sonnet over Opus; graceful degradation
to a partial draft beats a wizard that dead-ends.

**8. Stateless drafting or server-side draft records?**
**Stateless.** The endpoint returns a complete proposed object, the wizard edits it client-side, and
saving is an ordinary create. Draft-tweak-save and duplicate-tweak-save become one UI path, and
there is no orphaned draft state to expire.

**9. Delete semantics.**
**Archive by default; hard purge only when no session references the agent.** Ids are stable and
never reused, so every transcript can always name who produced it.

---

## 16. Deliberately deferred past v1

| Deferred | Why / what unblocks it |
|---|---|
| Shared skill libraries across agents | Copy-on-duplicate keeps the folder self-contained, which export and git-versioning depend on. Revisit when duplicate skill bodies actually hurt. |
| Claude *writing* full skill bodies in the wizard | Drafting suggests names and descriptions only; authoring a good skill is a session's work, not a wizard field. |
| Agent versioning / rollback of a definition | The roster directory is a git repo; `git log` and `git checkout` are the v1 answer. A UI-level version history can come later. |
| Per-agent memory (`AgentDefinition.memory`, auto-memory) | Cross-session memory interacts with transcripts and privacy; belongs with runner/foundation once transcript storage lands. |
| Free-form / user-defined specialties | Closed enum keeps board colouring, filtering, and wizard output predictable. `tags` covers the long tail. |
| `bypassPermissions` anywhere in the schema | No v1 use case justifies a mode that scoped deny rules are the only defence against. |
| Roster-level teams/groups | Orchestrator's assignment shapes already express "who works together"; a second grouping concept would compete with it. |
| Remote/hosted agent definitions, multi-user rosters | Single-owner tool by construction (D5, D6). |
