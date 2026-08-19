# WO3 — Connector library: define a connection once, reference it from many agents

**Element:** roster (schema, store, service, routes, compile, preflight, export/import).
**Amends:** roster `DESIGN.md` — new §10.3 (the library), §9.1 route table, §10.2 (one new
preflight state). ui consumption is WO4; this WO is server-only.

## Context

Owner: connections are "very manually entered and work has a lot of connectors" — a connection
should be created once on a Connectors page and then *assigned* to agents. Today `integrations`
is per-agent only (`agent.json`), so N agents needing the same server hold N hand-typed copies;
only the `secretRef` is shared. Roster DESIGN §10's decision that *the attachment belongs to the
identity* is preserved: agents still declare which connectors they carry — what changes is that
the **definition** of a connector can live once, in a library, and be referenced.

Precedent for a second library folder: templates (`src/modules/roster/templates.ts`,
`<libraryRoot>/templates/<id>/template.json`). Follow its idioms (dirnames, atomic writes, seed
non-interference, hashing) unless stated otherwise.

## The design

### 1. Storage and schema

`<libraryRoot>/connectors/<id>/connector.json`:

```jsonc
{
  "schemaVersion": 1,
  "id": "gmail",                 // MUST satisfy the existing integration-name rules
                                 // (schema.ts:407-416: ^[a-z0-9][a-z0-9_-]*$, no "__", ≤64)
                                 // because it becomes the default server name / tool prefix
  "label": "Gmail (work)",       // optional display line, 1-200
  "description": "…",            // optional, ≤500
  "config": { /* exactly integrationConfigSchema — transport stdio|sse|http, same
                 credential-shaped-key + oauth rules, no new fields */ },
  "meta": { "createdAt": "…", "updatedAt": "…" }
}
```

Zod `strictObject` throughout, exported from `schema.ts` or a sibling `connectors.ts` module.
The credential posture is inherited wholesale: values are literals or `{ secretRef }`, credential-
shaped keys must be refs, secrets never in the file beyond ref names.

### 2. Agent attachment: a reference variant

`integrationsSchema`'s record value gains a third shape: `{ "connector": "<connector-id>" }`
(strict object, nothing else on it). The record **key** stays the agent-local server name and
defaults to the connector id in the UI; a key that differs renames the tool prefix for that agent.
Inline configs remain fully legal — nothing migrates, nothing deprecates.

### 3. Resolution

- **Compile** (`compileSession.ts` → `compileIntegrations`): a ref resolves to the library
  config before secret resolution; a dangling ref throws `SessionCompileError` naming the agent
  and the missing connector id — same launch-refusal posture as an unresolved `secretRef`.
- **Preflight** (`integrations.ts integrationPreflight`): refs resolve first, then today's logic
  runs on the resolved config. A dangling ref is a new state `missing-connector`, outranking
  everything including `missing-secret` (it is a launch refusal with nothing else knowable).
  Add it to `INTEGRATION_STATES`, to the web mirror (`web/src/api/types.ts IntegrationState`),
  to `CHIP_LABELS`/`chipAction` in `web/src/startwork/model.ts` (action → `/connectors`), and
  note that `triggerScheduler.ts`'s strict `ready`-only check needs **no change** — any new
  state already blocks it.
- Preflight rows for a resolved ref carry `connector: "<id>"` so the UI can say "from the
  library" — additive field on `IntegrationPreflight`.

### 4. API

All under `/api/roster`, added to `routes.ts` and DESIGN §9.1:

| Method | Path | Notes |
|---|---|---|
| `GET` | `/connectors` | list: id, label, description, transport, toolPrefix, credential status (`{ secretRef, resolved }` — names only, never values), and `usedBy: string[]` of agent ids referencing it |
| `GET` | `/connectors/:id` | one, same shape |
| `POST` | `/connectors` | create; id from label if absent, collision-suffixed like agents |
| `PATCH` | `/connectors/:id` | partial update; `id` immutable |
| `DELETE` | `/connectors/:id` | **refused (409) while any agent references it**, body lists the agent ids; otherwise removes the folder |

Change events: reuse the roster module's existing change-notification path so clients that watch
`roster.changed` (or the module's equivalent) learn about connector edits; if the event carries a
kind, add `connector`. Match how template changes propagate today rather than inventing a new
channel.

### 5. Export / import

`.agentpack` export **inlines**: a `{ connector }` ref is replaced by the resolved config (still
refs-not-values for secrets, as today), so a pack never depends on the destination's library.
Import therefore never has to accept a ref; if one is encountered anyway, refuse with a message
saying exports are inlined. Duplicate-and-edit keeps refs as refs (same library, same machine).

### 6. What this WO does not do

No UI (WO4). No template `requiredIntegrations` changes — those names already match by server
name, and a referenced connector attached under its default key satisfies them unchanged. No
secret-value routes of any kind.

## Acceptance tests (`--project server`, scoped to `src/modules/roster`)

- Schema: valid connector accepted; bad id (uppercase, `__`), unknown keys, credential-shaped
  literal in `config`, `auth:'oauth'` on stdio all rejected with the existing messages.
- Store: CRUD round-trips; delete-while-referenced returns the referencing agent ids; id
  collision suffixing.
- Attachment: an agent with `{ "connector": "gmail" }` compiles to the same `mcpServers` entry
  as the equivalent inline config (byte-equal after env spreading); dangling ref fails compile
  with the agent and connector named.
- Preflight: resolved ref reports the underlying state (`ready` / `missing-secret` / …) plus the
  `connector` field; dangling ref reports `missing-connector` and outranks `missing-secret`.
- Editing the library config changes the next compile of every referencing agent (no per-agent
  cache staleness).
- Export of a ref-carrying agent contains the inlined config and no `connector` key; importing
  a pack containing a `connector` key is refused with the stated message.
