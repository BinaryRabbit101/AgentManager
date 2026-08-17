# Roster — hand-off notes

What the three elements that consume roster need to know, and nothing else.
Written at [M10](IMPLEMENTATION.md#m10--seed-roster-docs-and-hand-off); the
authority for every claim here is [DESIGN.md](DESIGN.md), which these notes point
into rather than restate.

Everything is reached through one barrel — `src/modules/roster/index.ts` — or,
across an element boundary, through `ctx.require('roster')`. **Feature modules
never import each other** (foundation §6.1), so runner and orchestrator code
against the service structurally and import only types.

---

## 1. Runner — the `compileSession` contract

`compileSession` (DESIGN §13) is the single function in the system that
constructs Claude Agent SDK option shapes. Runner calls it once per launch and
hands the result to `query()`.

```ts
const roster = ctx.require<RosterProvider>('roster');
const agent = roster.registry.get(agentId);          // in-memory; never a disk read
const { options, effective, policy, systemPrompt, requested, diagnostics } =
  await roster.compileSession({ agent, project, assignment, policy, secrets, baseEnv });
```

**Inputs are raw, never composed.** `ProjectContext.permissionOverride`,
`AssignmentContext.scopeRules` and `policy.globalDeny` are rule *inputs*; roster
is the only composer (§6.2). Projects and orchestrator must not compute an
effective set of their own — "two implementations of this table would disagree,
and the disagreement would be a permission bug".

**`assignment` is always present.** D4: every session belongs to an assignment,
solo included. `assignment.write === false` is enforced *here and nowhere else*
(§6.2): the compiler unions in a mutating-tool deny that no later layer can
remove. Orchestrator states the flag and enumerates nothing.

**Five things come back, and each has one consumer.**

| field | who reads it | note |
|---|---|---|
| `options` | `query()` | The whole object. Runner's option whitelist does **not** gain `mcpServers`: roster mounts the orchestration toolset itself (§13). |
| `effective` | the session header, the audit log | The `EffectivePermissions` the UI already renders from `POST /validate`. |
| `policy` | runner's `canUseTool` | §6.1's **default-deny policy**. Roster does not set `options.canUseTool`; runner installs the callback and layers its question bridge on top (runner §5.1). Anything not in the effective allow set is denied unless a human answers. |
| `systemPrompt` | transcripts, debugging | The composed persona, already in `options`; carried separately so runner need not re-derive it. |
| `requested` | `assertSessionStart` | What this launch asked for, in the shape §7.1's init-message assertion consumes. |

**Failure is a throw, not a diagnostic.** `SessionCompileError` means the session
must not start — the only case in v1 is an unresolvable `secretRef` (§10), which
names the agent and the ref. A `Diagnostic` in the returned array is the "this
will surprise you later" class and never blocks a launch.

**Two SDK facts the compiler already handles**, so runner must not re-do them:
`env` *replaces* rather than merges (the base environment is spread in, `PATH`
included — there is a regression guard), and a nonexistent plugin path is
silently skipped (paths are absolute, and `assertSessionStart` catches the rest).

---

## 2. Orchestrator — capability flags and role names

**The switch is `capabilities.overseer`** (§11), and the schema already enforces
that an overseer lists `overseer` in `capabilities.roles` — orchestrator never
has to ask the question twice.

**Roles are a closed v1 vocabulary**: `implementer | architect | skeptic |
reviewer | overseer`, exported as `ROLES` / `roleSchema`. A pattern seat matches
against `capabilities.roles`; the starter roster (§ below) fills the v1 pair.

**The tool grant is roster's, the toolset is orchestrator's.** Roster compiles
`mcp__agentmanager__*` allow rules — all six names for an overseer, and exactly
four (`send_to_agent`, `read_mailbox`, `report_status`, `request_user_decision`)
for a worker with an assignment. It never grants the SDK's `Agent`/subagent tool,
in either direction (D4). Roster then calls
`ctx.require('orchestrator')?.getSessionToolset({ assignmentId, agentId, role, isOverseer })`
and places the returned **per-launch** server instance at
`options.mcpServers.agentmanager`. Per launch because the instance closes over
the assignment id, and because a `createSdkMcpServer` instance is single-use.
When the module is absent the key is omitted and every `mcp__agentmanager__*`
rule is dropped with a diagnostic, rather than allow rules being compiled for a
server that will never be mounted.

**Assignment scoping is the tools' job, not the rules'.** Permission rules match
tool *names* and cannot express "only your own assignment"; the four worker tools
stay assignment-scoped by a check inside the tool implementation (§11).

**The roster projection for `list_roster`** is `service.overseerRoster()` — names,
specialties, tags, capabilities, and *never* permissions or integrations. Use it
rather than building a projection: "an overseer cannot delegate to people it
cannot see. It has no business knowing their credentials."

**The seeded pair** (M10): `ada-architect` carries `['architect','implementer']`
— both of `PAIR_SEATS[0].roles` — and `sam-skeptic` carries `['skeptic',
'reviewer']`. Two identities, which is what §3.3's "an adversarial pair where
both sides are the same identity is theatre" requires.

---

## 3. UI — the API surface and the diagnostic shapes

Everything is under `/api/roster` and every route is `remote: 'allow'` (D3, D5).
The full table is DESIGN §9.1; the shapes are `AgentView`, `RosterListView`,
`ValidateResult`, `ImportPreview` and `Diagnostic`.

| what the UI does | route |
|---|---|
| the board | `GET /agents` — carries `uiState`, `diagnostics`, `avatarUrl`, and `{ secretRef, resolved }` per credential |
| the card | `GET /agents/:id` — definition **plus resolved persona text** |
| create / edit / clone / delete | `POST /agents`, `PATCH /agents/:id`, `POST /agents/:id/duplicate`, `DELETE /agents/:id[?purge=true]` |
| drag, pin | `PUT /board-order { order: string[] }` (whole list, one transaction), `PATCH /agents/:id/ui-state { pinned }` |
| the face | `GET|PUT|DELETE /agents/:id/avatar` — `GET` never fails for a known agent; it generates a placeholder |
| the wizard | `POST /draft` — stateless; the object it returns is edited client-side and saved with an ordinary `POST /agents` |
| the launch preview | `POST /agents/:id/validate { projectId?, write?, role? }` → `{ effective, diagnostics, declaredElevation, allowPermissionElevation, assumedWriteAccess }` |
| share an agent | `GET /agents/:id/export` → `.agentpack`; `POST /import` → preview (200), `?commit=true` → written (201) |
| live | `roster.changed` over WS, on every registry mutation **including an external file edit** |

**Three shapes worth knowing exactly.**

`Diagnostic` — `{ level: 'error'|'warn'|'info', code, message, agentId?, path? }`.
The `code` is stable and dotted (`roster.integration.no-allow-rule`); group and
dismiss on it, and never parse `message`. `error` means the agent is out of the
registry or a launch is blocked; `warn` is "this will surprise you later". The
levels are compatible with foundation's `HealthCondition` by construction.

`EffectivePermissions` — `{ mode, allow, deny, ask, elevation }`, every field
total. An `elevation` is the one that was **applied**; a *declared* one that
policy dropped comes back on `ValidateResult.declaredElevation` alongside
`allowPermissionElevation: false`, and must be shown — §6.2's escape hatch is
"deliberately loud", and the work edition dropping it silently would be the
failure mode the design engineers against.

`ImportPreview` — `{ committed, sourceId, proposedId, collision, requiredSecrets,
missingSecrets, skills, files, warnings }`. Show it and let the owner confirm;
the same bytes are then posted again with `?commit=true`.

**Two rules that hold across the whole surface.** No response ever contains a
resolved secret value — only `{ secretRef, resolved }` (§10), which is what the
"needs credential" badge is built from. And no response contains a filesystem
path: the browser gets an id and `/api/roster/agents/:id/avatar` (§3.2).

**Refusals are typed.** A `RosterServiceError` carries `code` and `status`
(`agent_not_found` 404, `agent_archived` 409, `agent_id_taken` 409,
`immutable_field` 400, `purge_blocked` 409, `avatar_too_large` 413,
`agentpack_too_new` 409, …); a schema rejection is always a 400 whose body names
the offending field paths under `issues`. Never feature-detect by probing for a
404.

---

## 4. The library, for anyone who touches the filesystem

`<libraryRoot>/` is **roster's alone** (§2.1, foundation §4.4). The installer
creates and ACLs the directory and stops; roster runs `git init` (never a
commit), writes `roster.json`, `.gitignore`, `README.md`, creates `agents/`, and
seeds the four starter agents into an empty library on first run. Nothing else
may write there — including the installer, which "never writes an example agent".

Seeding is once-ever, recorded by `roster.json`'s `seededAt`, skipped entirely
for a library that already holds agents, and disabled outright by
`library.seed: false`.
