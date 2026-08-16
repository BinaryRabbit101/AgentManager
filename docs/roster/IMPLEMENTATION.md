# Roster — Implementation

Ordered milestones for the v1 roster element, per [DESIGN.md](DESIGN.md). Each milestone is
independently reviewable and leaves the build green. Milestones 1–4 are the critical path — runner
cannot start a session without M4, and everything else hangs off M1's types.

**Prerequisites from other elements.** M1–M3 need only foundation's config (where the data
directory lives) and logging. M6 needs foundation's secrets decision. M7 needs orchestrator's MCP
tool names but not its implementation. Nothing here blocks on ui.

**Package**: `packages/roster` (or `src/roster`, per foundation's module layout), exporting
`RosterService`, the Zod schemas, and `compileSession`.

---

## M0 — Verify the SDK surface

Before any code, produce a short `SDK-NOTES.md` (in this folder, not in `src`) recording, against
the exact `@anthropic-ai/claude-agent-sdk` version being pinned:

- the `PermissionMode` union as declared in `sdk.d.ts`;
- the `systemPrompt` preset object's fields, including whether `excludeDynamicSections` exists;
- the `McpServerConfig` and plugin-config type declarations;
- the `skills`, `plugins`, `settingSources`, `fallbackModel`, `maxBudgetUsd` option names;
- whether `effort` is available at top level or subagent-only.

**Acceptance**: `package.json` pins an exact SDK version; `SDK-NOTES.md` lists each option with
"confirmed / absent / differs" and a one-line note. Any DESIGN.md assumption contradicted here is
raised as a design change, not silently coded around.

---

## M1 — Schema and types

Zod schemas + inferred TypeScript types for `AgentDefinition` (schema v1), `Avatar`, `Specialty`,
`PermissionSet`, `IntegrationConfig`, `SecretRef`, `Capabilities`, `EffectivePermissions`,
`Diagnostic`. Strict mode: unknown top-level keys rejected. `id` slug rules, immutability, reserved
ids. `settingSources` rejects `"user"` and `"local"`. Schema-version constant and a
`migrate(raw) → AgentDefinition` seam (identity function in v1).

**Acceptance**
- Round-trip test: parse → serialise → parse is byte-stable for a canonical fixture.
- Rejection tests: unknown key, bad slug, `settingSources: ["user"]`, `permissionMode:
  "bypassPermissions"`, secret value inline where a `secretRef` is expected — each fails with a
  message naming the offending path.
- At least 4 golden fixtures committed: a coder, an email responder (persona `replace`, one
  integration), an overseer, a minimal agent with every optional field omitted.
- No dependency on the SDK in this milestone.

---

## M2 — File store and in-memory registry

Folder layout per DESIGN §2.1. Atomic writes (temp file + rename) for `agent.json` and
`persona.md`. Generation of `.claude-plugin/plugin.json`. Loader that walks `roster/agents/*`,
validates, and populates `Map<AgentId, ResolvedAgent>`; a debounced filesystem watcher that reloads
changed folders. Invalid definitions produce a `Diagnostic` and stay out of the registry without
throwing. Roster directory bootstrap: create on first run, `git init` (no auto-commit), write
`roster.json`.

**Acceptance**
- Registry loads all fixtures from a temp directory; counts and ids match.
- Corrupting one `agent.json` on disk removes exactly that agent from the registry, adds one
  diagnostic, and leaves the others loadable.
- Editing `persona.md` externally is reflected in the registry within ~1s without a restart.
- A killed process mid-write leaves either the old or the new `agent.json`, never a truncated one
  (simulated by asserting writes go through temp+rename).
- Windows path handling verified: spaces in the data directory, long paths, no POSIX-only
  assumptions.

---

## M3 — CRUD + duplicate API

`RosterService` methods and the HTTP routes in DESIGN §9.1 except `/draft`, `/export`, `/import`,
`/validate`. Includes `agent_ui_state` reads/writes against foundation's SQLite, the
`roster.changed` WebSocket broadcast, archive-on-delete, and purge-guard (asks foundation/session
store whether any session references the id; if that store does not exist yet, purge is refused).

**Acceptance**
- Create → read → patch → duplicate → delete exercised end-to-end against a temp data dir.
- `POST /agents` with a name and no id mints a slug; a colliding name yields `-2`, not an error.
- `PATCH` attempting to change `id` is a 400.
- Duplicate produces a folder containing persona, roles, skills, and avatar; `meta.duplicatedFrom`
  is set; `secretRef`s are carried; the source is untouched.
- `DELETE` moves the folder under `.archive/` and the id disappears from `GET /agents`; the
  archived definition is still readable by id for display.
- `roster.changed` fires for API mutations **and** for an external file edit.
- API responses never contain a resolved secret value (asserted by a test that plants one).

---

## M4 — Permission composition and the option compiler

The heart of the element. `compilePermissions(baseline, projectOverride, assignmentScope)` per
DESIGN §6.2, and `compileSession(...)` per §13 producing the SDK options object. Includes:
persona composition (preset append vs replace, role addendum, runtime block), the default-deny
`canUseTool` wiring point, `ask` rules via the inline settings object, the `env` spread, `cwd` and
`additionalDirectories`, model and fallback, turn and budget defaults. Secrets are stubbed behind a
`SecretResolver` interface here; M6 supplies the real one.

**Acceptance**
- Table-driven composition suite: for each of ≥15 (baseline, project, assignment) triples, the
  expected `EffectivePermissions` is asserted. Cases must include: project tries to widen `allow`
  (ignored), project adds `deny` (applied), assignment path scope narrows `Edit`, mode ladder
  minimum in both directions, `permissionElevation` present (widens, and is flagged in the result).
- Restriction is expressed as `deny`, never by omission: a test asserts that for every agent, a
  tool absent from `allow` and absent from `deny` still cannot execute — via the compiled
  `canUseTool` default-deny — and that a bare-name deny removes the tool definition.
- `bypassPermissions` is unreachable: a test asserts no input combination produces it.
- Persona composition snapshot tests for `append` and `replace`, with and without a role addendum.
- `compileSession` output validates against the pinned SDK's option types (type-level, plus a
  runtime smoke test that `query()` accepts the object with a trivial prompt).
- `env` contains the inherited `PATH` (regression guard for the SDK's replace-not-merge behaviour).

---

## M5 — Skills packaging

Per-agent `skills/` folder, plugin manifest generation, `skills.mode` → SDK `skills` option, exact
name validation at write time and at launch, `"Skill"` added to the effective allow set, and
absolute-path plugin config. Startup assertion helper the runner calls: compare the session init
message's `plugins` and `skills` arrays against what was requested and emit a diagnostic on
mismatch.

**Acceptance**
- An agent with two skills launches with both present in the init message's `skills` array
  (integration test against a real short session).
- `skills.mode: "declared"` with a name that has no folder is rejected at write time with a message
  naming the missing folder — not at launch.
- `skills.mode: "none"` yields an empty enable set and no `Skill` tool prompt.
- Deleting a skill folder externally produces a diagnostic on reload rather than a broken launch.
- Duplicating an agent copies its skills and the clone's plugin manifest names the new id.

---

## M6 — Integrations and secret resolution

`integrations` → `mcpServers` compilation for all three transports, `secretRef` resolution through
foundation's secret provider, launch-time failure with a named ref when resolution fails, the
`{ secretRef, resolved }` shape in API responses, the validator warning when an integration has no
matching `mcp__<server>__*` allow rule, and mapping MCP server statuses (`pending`, `needs-auth`,
`failed`) into diagnostics the UI can act on.

**Acceptance**
- A stdio integration with a `secretRef` compiles with the resolved value present in `env` and the
  ref absent from every API response and every log line (asserted against captured logs).
- An unresolvable ref fails `compileSession` with an error naming the agent and the ref; no session
  is started.
- `GET /agents/:id` on an agent with a missing credential returns `resolved: false` and the UI-facing
  badge field.
- An agent declaring `integrations.gmail` with no `mcp__gmail__*` allow rule produces a validator
  warning at write time.
- `needs-auth` from the init message surfaces as a distinct diagnostic kind, not a generic failure.

---

## M7 — Capabilities, roles, and the overseer surface

`capabilities.overseer` and `capabilities.roles`. Compiler grants the `mcp__agentmanager__*` allow
rules to overseers and the scoped subset (`send_to_agent`, `read_mailbox`) to workers when an
assignment is present. Enforce: the SDK subagent tool is never granted; overseer requires `overseer`
in `roles`; model-floor warning; higher default turn/budget when unset. Role addendum lookup from
`roles/<role>.md`. Read-only roster projection for overseers (names, specialties, tags,
capabilities — no permissions, no integrations).

**Acceptance**
- An overseer's compiled options include the orchestrator tool allow rules and exclude the
  `Agent`/subagent tool (asserted on both the current and legacy tool names).
- A non-overseer with an assignment gets only the scoped messaging rules.
- Setting `overseer: true` without `roles` containing `overseer` is a validation error.
- The roster projection handed to an overseer contains no `permissions` or `integrations` key for
  any agent (asserted by deep key scan).
- A role addendum is appended only when the assignment supplies that role, and snapshot-matches.

---

## M8 — Draft-from-description

`POST /api/roster/draft` per DESIGN §12: inert `query()` configuration, the replacement system
prompt including the fixed tool-rule catalogue and the specialty enum, fenced-JSON extraction, Zod
validation of the draft shape, one repair round-trip with the validation errors fed back, partial
`degraded: true` response on second failure, per-field-group rationale, `suggestedSkills` and
`suggestedIntegrations` with placeholder refs only.

**Acceptance**
- Golden-path test against a recorded/mocked model response produces a draft that passes the M1
  agent schema after the wizard's minimal completion (id + meta).
- A malformed first response triggers exactly one repair call; a second malformed response returns
  `degraded: true` with the fields that did validate and HTTP 200, not an error.
- The draft's `permissions` contain only rules from the supplied catalogue (asserted against an
  invented tool name in a mocked response).
- No draft state persists server-side: two identical requests share nothing; there is no draft
  table, file, or cache.
- The drafting call uses no tools, no MCP servers, no setting sources, and no skills (asserted on
  the compiled options).
- P50 latency measured and recorded; if it exceeds ~8s the model or prompt size is revisited before
  the milestone closes.

---

## M9 — Import / export

`.agentpack` zip writer and reader, `manifest.json` with `requiredSecrets`, secret-value exclusion,
two-phase import (preview then `?commit=true`), id-collision handling, schema-version refusal with
both versions named, and the `POST /agents/:id/validate` dry-run endpoint returning effective
permissions for an agent × project pair.

**Acceptance**
- Export → import into a fresh data directory reproduces the agent byte-for-byte except `id` (on
  collision) and `meta`.
- A pack containing a secret value anywhere fails export (guard test) — packs carry refs only.
- Importing a pack whose `schemaVersion` exceeds the build's is refused with both numbers in the
  message.
- Preview lists collisions, missing secrets, and skills to be added, and writes nothing.
- `POST /agents/:id/validate` returns the same `EffectivePermissions` the runner would get, and
  flags elevation when the project declares it.

---

## M10 — Seed roster, docs, and hand-off

Three or four seeded agents installed on first run (a bug-patcher, a feature implementer, an
architect/skeptic pair suitable for orchestrator's v1 adversarial-pair slice, and an overseer),
each with a real persona and a sane permission set. A short `README` inside the roster data
directory explaining that it is a git repo and safe to hand-edit. Element hand-off notes for runner
(the `compileSession` contract), orchestrator (capability flags and role names), and ui (the API
surface and diagnostics shapes).

**Acceptance**
- A clean install produces a working board with the seeded agents visible and launchable.
- Every seeded agent passes validation and compiles to valid SDK options against a scratch project.
- The architect and skeptic seeds have `roles` entries matching the names orchestrator's v1 pattern
  expects.
- Hand-off notes are linked from this file and reviewed by whoever designs runner.

---

## Testing strategy

| Layer | What |
|---|---|
| Unit | Schema validation, slug/id rules, permission composition table, persona composition snapshots, pack manifest generation |
| Integration (no model) | Store + registry against a temp directory, CRUD API via the router, import/export round trip, watcher behaviour |
| Integration (model) | One short real session per persona mode confirming init-message contents (skills, plugins, MCP status, tools); the drafting call. Kept few — they consume the shared rate-limit window (D2). |
| Guard tests | No secret in API output or logs; no `bypassPermissions`; no subagent tool for overseers; `PATH` present in compiled `env` |

Model-touching tests live behind a flag and are excluded from the default watch loop.

## Risks

| Risk | Mitigation |
|---|---|
| SDK option names/semantics shift | M0 pins and records; all SDK contact confined to the option compiler; a version bump is a one-file review |
| Permission composition subtly wrong | Highest-value test surface in the element (M4 table); `POST /validate` makes the result visible to the user before launch |
| Plugin-path skill loading fails silently (SDK skips nonexistent paths) | Absolute paths, write-time folder validation, and the M5 init-message assertion |
| Drafting returns unusable JSON | One repair retry, then graceful `degraded` partial — the wizard never dead-ends |
| Roster directory hand-edited into an invalid state | Per-agent isolation of validation failures + surfaced diagnostics; never a startup crash |
