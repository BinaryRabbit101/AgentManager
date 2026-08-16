# Orchestrator — Design

App-level coordination between roster agents (architecture D4). It owns the **assignment** — the unit
of orchestrated work, agent(s) × project × scope — the **collaboration patterns** that drive several
agents through one goal, the **in-process MCP toolset** agents coordinate through, the **mailbox**,
the **question inbox** the user answers from, and the **budgets and guardrails** that stop all of it
from running away.

> **M0 completed against pinned SDK 0.3.233 — [SDK-NOTES.md](SDK-NOTES.md) is the authority
> wherever it and this document disagree.** [A1]–[A5] all held (A2/A4 observed live against a real
> in-process MCP server, no auth needed). Three contradictions: **C1** — file-permission checks
> consult only `Edit(path)` rules; scoped `Write(path)`/`NotebookEdit(path)`/`MultiEdit(path)` rules
> are inert and `Edit(*)` collapses to bare `Edit` (auto-approve) — §2.5's scope shape survives only
> because `Edit` is in its list, and roster/projects rule emission must respect this. **C2** — the
> AskUserQuestion preference in §4.4 must branch on runner's `questionBridge: 'degraded'`
> diagnostic. **C3** — MCP tools defer behind tool search by default; `report_status` needs
> `alwaysLoad: true` or the `no_report` breaker fires on a wiring bug. Fifteen live checks (L1–L15)
> are token-gated in `src/modules/orchestrator/__spike__/sdk.spike.test.ts`.

Conforms to [architecture.md](../architecture.md) D1–D6. Consumes foundation's storage, config,
secrets, logging, module and event decisions; roster's compiled sessions, `capabilities.overseer`,
role addenda and permission composition; projects' launch context, workspace leases, work items and
scope-overlap warnings; runner's session lifecycle, question bridge, metering and event vocabulary.
It invents none of those and recomputes none of them.

The wave-1/2 contracts named in [README.md](README.md) — the role vocabulary
`implementer | architect | skeptic | reviewer | overseer`, the six `mcp__agentmanager__*` tool names,
MCP-server-enforced worker scoping, and roster's rule-dropping when this module is disabled — are
treated as settled inputs and are not re-litigated.

---

## 0. SDK surface note

The MCP server is built with the Agent SDK's `createSdkMcpServer` / `tool` helpers. Facts marked
**[A]** are assumptions to confirm in M1 before code depends on them; none of them changes the
design's shape, only its wiring.

| | Assumption |
|---|---|
| **[A1]** | `createSdkMcpServer({ name, version, tools })` returns an in-process server object accepted as a value in `options.mcpServers`, and tools surface to the model as `mcp__<mcpServers key>__<toolName>`. We mount under the key **`agentmanager`** because roster compiles `mcp__agentmanager__*` allow rules; if the SDK derives the prefix from the server's `name` instead, both are set to `agentmanager`. |
| **[A2]** | `tool(name, description, zodShape, handler)`'s handler receives `(args, extra)` and `extra` carries **no** identity of the calling session. The whole scoping design (§4.2) therefore rests on a **per-launch server instance** that closes over the launching identity, which is correct whether or not [A1]/[A2] hold. |
| **[A3]** | An MCP tool handler may stay pending for minutes without the CLI cancelling the call. `request_user_decision` (§4.3) holds for `runner.question.holdMs` (15 min). If M1 finds a shorter hard timeout, the hold shortens to fit inside it and everything else — the park-and-continue path — is unchanged, because that path already exists for exactly this reason. |
| **[A4]** | A tool result flagged as an error is delivered to the model as readable text, so a structured refusal ("denied: agent not in your assignment") teaches the agent rather than crashing the turn. |
| **[A5]** | `options.mcpServers` accepts a record mixing in-process server instances with roster's stdio/http integration configs. |

Everything else this design leans on is already verified in runner §0 and is cited from there rather
than re-verified.

---

## 1. Scope and boundaries

| Orchestrator owns | Orchestrator does not own |
|---|---|
| `assignments`, `assignment_members`, `messages`, `questions`, `question_recommendations` | `sessions`, transcripts, metering mechanics, the queue (runner) |
| Patterns, turn order, convergence, round caps | Agent definitions, personas, permission composition (roster) |
| The `agentmanager` MCP server and its enforcement | Project paths, workspace allocation, work-item CRUD (projects) |
| Budget *policy*: caps, halt cards, raises, projections | Budget *arithmetic* and the halt trigger (runner §7.2) |
| Question card content, aggregation, recommendations | The `canUseTool` bridge plumbing (runner §5) |
| Circuit breakers, approval gates, notification triggers | Config/secret/log/bus mechanisms (foundation) |
| Status aggregation across agents and assignments | Rendering any of it (ui) |

The one-line rule: **orchestrator decides *who* works on *what*, *in what order*, and *when to
stop* — never *how a session runs* and never *what a session is allowed to do*.**

---

## 2. The assignment engine

### 2.1 What an assignment is

An assignment is a durable record of *a goal, on a project, in a scope, worked by named agents in
named roles, under a budget*. Every session belongs to one — foundation §1.4 makes
`sessions.assignment_id NOT NULL`, and runner never mints one (runner §15.1-2). A drag-and-drop solo
launch is the trivial assignment: one member, whole-project scope, pattern `solo`, no driver.

Foundation ships `assignments` and `assignment_members`. Orchestrator adds its own columns through
`migrations/orchestrator/0001_orchestrator.sql` (foundation §1.3 lets the owning element extend its
tables):

```sql
ALTER TABLE assignments ADD COLUMN created_by           TEXT NOT NULL DEFAULT 'user';
      -- 'user' | 'overseer:<agentId>' | 'system'
ALTER TABLE assignments ADD COLUMN parent_assignment_id TEXT;   -- set by create_assignment (§4.3)
ALTER TABLE assignments ADD COLUMN lead_agent_id        TEXT;   -- the seat that owns the outcome
ALTER TABLE assignments ADD COLUMN write                INTEGER NOT NULL DEFAULT 1;
ALTER TABLE assignments ADD COLUMN artifact_path        TEXT;   -- repo-relative; required by `pair`
ALTER TABLE assignments ADD COLUMN pattern_config_json  TEXT NOT NULL DEFAULT '{}';
ALTER TABLE assignments ADD COLUMN phase                TEXT NOT NULL DEFAULT 'planned';
ALTER TABLE assignments ADD COLUMN halt_reason          TEXT;
ALTER TABLE assignments ADD COLUMN updated_at           TEXT;
CREATE INDEX assignments_open ON assignments (project_id, status, updated_at);

ALTER TABLE assignment_members ADD COLUMN seat_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assignment_members ADD COLUMN joined_at  TEXT;

CREATE TABLE assignment_turns (
  id            TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  round         INTEGER NOT NULL,
  seat          TEXT NOT NULL,           -- the role filling this seat
  agent_id      TEXT NOT NULL,
  session_id    TEXT,                    -- runner session id, set at admission
  prev_session_id TEXT,                  -- the seat's previous session, for continueFrom (§3.2)
  status        TEXT NOT NULL,           -- planned|running|reported|unstructured|blocked|failed
  report_json   TEXT,                    -- last report_status payload for this turn
  output_text   TEXT,                    -- bounded capture of the last assistant message
  artifact_hash TEXT,
  started_at    TEXT, ended_at TEXT
);
CREATE INDEX assignment_turns_read ON assignment_turns (assignment_id, round, seat);
CREATE UNIQUE INDEX assignment_turns_active
  ON assignment_turns (assignment_id) WHERE status IN ('planned','running');

CREATE TABLE message_reads (                -- per-recipient read state for broadcasts (§5)
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL,
  read_at    TEXT NOT NULL,
  PRIMARY KEY (message_id, agent_id)
);
```

`assignment_turns_active` is the crash-safe guard against double-launching a turn: v1's patterns are
sequential, so at most one planned-or-running turn may exist per assignment, and the database says so
rather than an in-process flag that a restart forgets.

### 2.2 Status and phase

Two separate things, deliberately:

- **`assignments.status`** is the coarse admission gate runner reads: **`open` | `closed`**. Nothing
  else. Runner refuses to start a session on a non-`open` assignment (runner §3.2), and it re-checks
  on admission, so every stop path in this document reduces to "close it, or leave it open".
- **`assignments.phase`** is orchestrator's own state machine, read by the UI and by the pattern
  driver: `planned | running | awaiting_user | halted | converged | closed`. A `halted` or
  `awaiting_user` assignment is still `open` — its sessions may finish; the *driver* simply plans no
  new turns.

`close_reason` is a closed set: `converged` · `round_cap` · `budget_exhausted` · `user_closed` ·
`gate_denied` · `gate_expired` · `breaker` · `failed` · `project_archived`.

Closing an assignment writes `closed_at` + `close_reason`, sets `phase: closed`, cancels its open
questions (`QuestionBridge.cancel`), stops any of its sessions still `running`/`paused` through
`RunnerService.stop`, and emits **`assignment.closed`** — which runner requires (runner §15.1-5) to
release the workspace lease.

**One exception, and it is the only one:** a close whose `close_reason` is `converged` sets
`phase: converged`, not `phase: closed` (§3.3). Everything else about the close is identical —
`status: closed`, `closed_at`, the cancellations, the stop calls, the event. The exception exists
because `converged` is the outcome the UI renders differently (ui §10.2 shows a completion summary and
the artifact rather than a generic closed header), and a phase value no code path can set is a lie in
the state machine. `status` remains the only thing runner reads, and it is `closed` either way.

### 2.3 Creation paths

Three, all through one internal function so the invariants hold once.

```ts
interface AssignmentService {                       // ctx.provide('orchestrator', …)
  createAssignment(req: CreateAssignmentRequest): Promise<CreateAssignmentResult>;
  createSolo(req: { projectId; agentId; role?; write?; prompt; priority?;
                    workItemIds?: string[] }): Promise<{ assignmentId; sessionId }>;
  closeAssignment(id: string, reason: CloseReason): Promise<void>;
  getAssignmentContext(id: string): Promise<AssignmentContext>;   // runner §15.1-3
  questionBridge: QuestionBridge;                                  // runner §5.2
  getSessionToolset(launch: LaunchIdentity): McpServerInstance;    // §4.1
}
```

**1. Solo (user-initiated, the common case).** `POST /api/assignments/solo
{ projectId, agentId, prompt, role?, write?, workItemIds? }` creates the assignment and starts the
first session in one call, returning both ids — this is what the UI's drag-and-drop launch calls, and
it is why the launch stays a one-minute flow. Defaults: `pattern: 'solo'`, whole-project scope,
`write: true`, `token_budget: null`, `round_cap: null`, `phase: running`, driver `none`.
`role` defaults to `implementer` when the agent declares it, otherwise `capabilities.roles[0]`,
otherwise `implementer`; the role is always passed to runner so roster appends a `roles/<role>.md`
addendum *if one exists* and silently appends nothing if it does not.

Everything after the first session on a solo assignment is user-driven through runner's own
Continue/Resume actions. **The solo pattern has no driver** — no turn loop, no convergence check, no
round accounting. That is what makes solo genuinely trivial rather than a special case threaded
through the engine.

**2. Pattern (user-initiated).** `POST /api/assignments` with a pattern id, members, scope, goal,
budget and round cap. Returns the assignment with `warnings[]` (scope overlap, projected cost,
missing role addendum, an agent already at its concurrent-assignment cap). `autoStart: true` plans
the first turn immediately; otherwise the assignment sits at `phase: planned` until
`POST /api/assignments/:id/advance`.

**3. Overseer-initiated** via `mcp__agentmanager__create_assignment` (§4.3) — the same function
behind the same validation, plus the extra rules of §9 that only apply to a machine caller
(nesting depth, budget debited from the parent, mandatory non-null budget, approval gate when
`write: true`).

**Work-item linking, on all three paths.** `workItemIds?: string[]` is accepted by
`createSolo`, by `CreateAssignmentRequest`, and by `create_assignment` (§4.3). The engine is the
**sole writer** of `work_item_assignments` (projects §1.5, §17 R4): on create it calls
`projects.linkWorkItems(assignmentId, workItemIds)` inside the same creation path as the assignment
row, and on close `projects.unlinkWorkItems(assignmentId)`. Projects derives the item's status from
those rows — `open` → `in_progress` when a linking assignment starts, back to `open` when every
linked assignment ends unmarked — so orchestrator never writes a work-item status itself. Both calls
are idempotent and validate that each item belongs to the assignment's project; an unknown or
cross-project id is a named refusal at create, not a silent drop. Passing no ids writes no rows.

### 2.4 Membership, roles, seats

`assignment_members(assignment_id, agent_id, role, seat_order)`. Rules, all deterministic and all
enforced at creation:

- `role` ∈ the pinned five. A member's role **must** appear in the agent's `capabilities.roles`
  (roster §3) — otherwise the agent has no addendum and never declared itself able to fill the seat.
  Refusal names the agent and the role.
- One agent may hold at most one seat in an assignment. Two seats may not be the same agent — an
  adversarial pair where both sides are the same identity is theatre, not review.
- The `lead_agent_id` seat owns the outcome. For pattern `overseer` the lead must be
  `capabilities.overseer` (roster §11); for `pair` the lead is the drafting seat.
- A member is refused if the agent is archived, or already holds seats in
  `orchestrator.assignment.maxConcurrentPerAgent` (default 2) other open assignments.
- Seat order is fixed by the pattern definition, not by insertion order.

**Per-role model.** Roster §8 is binding: nothing may silently downgrade a user-chosen model. So in
v1 the model for a seat is **the model on the definition of the agent placed in that seat** — the
cheaper-secondary-role guidance is realised by *who you put in the skeptic seat*, decided by a human
at creation time, not by a runtime substitution. A pattern definition may declare
`seats[].preferredTier` (`fast | balanced | max`), which is used only to **rank candidate agents in
the create dialog** and to raise a warning when the skeptic seat is filled by a `max`-tier agent
while the drafting seat is `fast`. A declared per-seat model *override* is deferred (§18) because it
would need a new `AssignmentContext` field honoured by roster's compiler (§17, R2).

### 2.5 Scope

`assignments.scope_json`:

```jsonc
{ "paths": ["docs/", "docs/orchestrator/"],   // repo-relative, no globs, directory or file
  "description": "the orchestrator design docs",
  "artifactPath": "docs/orchestrator/DESIGN.md" }   // pattern-required for `pair`
```

**Decision: scope is enforced for writes and advisory for reads.** The scope description always goes
in the prompt; in addition, orchestrator emits `AssignmentContext.scopeRules` as path-scoped
*mutating*-tool rules — `Edit(./docs/**)`, `Write(./docs/**)`, `NotebookEdit(./docs/**)` — which
roster §6.2 intersects into `allow` and whose complement it adds to `deny`. Reads are never scoped:
an agent that cannot read the rest of the repository writes worse plans, and read-scoping is not a
security boundary anyway (the same argument roster §7.2 makes about skills). Projects rewrites the
paths onto the leased workspace root (projects §1.3) before roster composes them; orchestrator states
them repo-relative and never computes an absolute path.

A `write: false` assignment supplies **no** scope rules and needs none: **roster's compiler enforces
the flag**, unioning a mutating-tool deny into the assignment layer whenever
`AssignmentContext.write === false` (roster §6.2, runner §15.1-3). So a read-only assignment is
read-only in the tools as well as in the workspace hold projects took, by the one flag rather than by
orchestrator remembering to enumerate every mutating tool (§17, R2). Orchestrator states `write` and
the scope paths; it never composes a rule set.

### 2.6 Conflict awareness between concurrent assignments

Two sources, one behaviour:

1. **At creation**, orchestrator computes path-prefix overlap between the proposed scope and the
   scopes of every other `open` assignment on the project. Deterministic prefix comparison on
   normalised repo-relative paths — no heuristics.
2. **At lease time**, projects emits `project.scope.overlap` (projects §4.3) when two assignments
   land in one workspace. Orchestrator subscribes.

| Situation | Behaviour |
|---|---|
| Overlap, neither assignment write-capable | Recorded, no warning. Two readers cannot collide. |
| Overlap, exactly one write-capable | `warnings[]` on create + an `assignment.conflict` event. Does not block. |
| Overlap, both write-capable | `warnings[]` **and an `approval_gate` question card** before the second assignment's first turn is planned. Denied gate → the assignment closes with `gate_denied`. |

This matches projects §7.13 (warn, do not block) everywhere except the one case where two agents can
actually corrupt each other's diff, where a human sees it first.

### 2.7 The runner contract

`getAssignmentContext(id)` returns exactly runner §15.1-3's shape:

```ts
{ id, pattern, status, role?, write, scopeRules: { allow?: string[], deny?: string[], ask?: string[] },
  tokenBudget: number | null, tokensUsed: number, roundCap: number | null, roundsUsed: number }
```

`role` is the role of the *member the session is for*; runner passes `role` on `startSession`, so the
context call returns the seat's role for that session. `write` is an assignment property, not a
session one — projects leases on write-capability, and a plan/review assignment must not take the
write hold.

---

## 3. Collaboration patterns

### 3.1 The abstraction

A pattern is a **pure state machine over persisted assignment state**. It never holds process memory,
never calls runner, never touches the database. The engine does all of that. This is what makes the
loop survive a core restart: after a crash the engine reloads the assignment and its turns and calls
`plan()` again, and gets the same answer it would have got had nothing happened.

```ts
interface PatternDef {
  id: 'solo' | 'pair' | 'review' | 'overseer';
  driver: 'none' | 'sequential';          // v1 ships 'none' (solo) and 'sequential' (pair)
  seats: SeatDef[];                        // { key, roles: Role[], required, preferredTier?, write }
  requires?: { artifactPath?: boolean; roundCap?: boolean; tokenBudget?: boolean };
  validate(cfg: PatternConfig, members: Member[]): Diagnostic[];
  plan(state: AssignmentState): TurnPlan | Termination;
}

interface AssignmentState {               // everything plan() may see, all of it from the DB
  assignment: AssignmentRow; members: Member[]; turns: TurnRow[];
  roundsUsed: number; tokensUsed: number; budget: number | null; roundCap: number | null;
  openQuestion?: { id: string; seat: string; answer?: Answer };
  breakers: BreakerCounters;
}

type TurnPlan   = { seat: string; agentId: string; round: number;
                    prompt: PromptSpec; continueFromSessionId?: string; priority: 'normal' };
type Termination = { done: true; closeReason: CloseReason; summary: string }
                 | { halt: true; haltReason: HaltReason; gate?: GateSpec };
```

`plan()` is a pure function of `AssignmentState`, which makes it table-testable: a fixture of turn
rows in, an expected plan out. Convergence logic that lives inside an LLM prompt cannot be tested;
this can.

The engine's loop is small and entirely event-driven:

```
assignment.created / advance / session.ended / question.answered / assignment.budget.exceeded
        │
        ├─ acquire the per-assignment in-process mutex
        ├─ reload AssignmentState from the DB          (never from memory)
        ├─ evaluate breakers (§8) → halt if tripped
        ├─ pattern.plan(state)
        │     ├─ TurnPlan     → insert assignment_turns row (the partial unique index is the guard)
        │     │                 → compose the prompt (§3.2) → runner.startSession | runner.continueFrom
        │     └─ Termination  → close or halt, raise the card, emit events
        └─ release the mutex
```

### 3.2 How turns are driven on top of runner's session model

Runner's session model is the constraint that shapes everything here: **a session is one unit of
work and ends at its first turn `result`** (runner §2.1, D12). There is no long-lived chat process to
push messages into. So:

| Engine action | Runner call | Result |
|---|---|---|
| A seat's **first** turn | `RunnerService.startSession({ assignmentId, agentId, projectId, prompt, role, priority: 'normal' })` | New session, new SDK conversation |
| A seat's **subsequent** turn | `RunnerService.continueFrom(prevSessionId, prompt)` | **New** session row with `resumed_from`, resuming the seat's SDK conversation (runner §9.4) |
| Turn completion | subscribe to `session.ended` on the bus | `{ status, exitReason, permissionDenials, totals, summary }` |
| Live output capture | subscribe to `session.message` (non-persisted, in-process) | last assistant text → `assignment_turns.output_text`, bounded at 32 KB |

Using `continueFrom` for round ≥ 2 is not an optimisation detail — it is what makes the skeptic
remember its own prior critique and the architect remember why it made a choice, without the engine
re-feeding the whole history in the prompt. It also keeps the SDK's prompt cache warm across rounds,
which under D2's shared rate-limit windows is real money.

**Reading a turn's output — three channels, in preference order.**

1. **`report_status` payload** (§4.3) captured during the session. This is the structured channel and
   the one the prompt demands. It carries the seat's verdict, headline, and artifact list.
2. **Last assistant message**, captured live from `session.message` and persisted at
   `session.ended`. Used when the agent finished without reporting: the turn is marked
   `unstructured`, which is a breaker input (§8).
3. **Transcript tail**, if the core restarted mid-turn and (2) was lost. The engine calls runner's
   in-process `getTranscriptTail(sessionId, { maxBytes })` (runner §11.2) — whole JSONL lines from the
   end of the file, no HTTP call to our own process — and recovers the last assistant message from it.
   A pruned transcript returns `pruned: true`, and only *then* is the turn marked `unstructured` and
   re-run once (§17, R3).

The engine never parses prose for a verdict. A turn either reported structurally or it did not.

**Prompt composition** (`PromptSpec` → text, capped at `orchestrator.prompt.maxBytes`, default 16 KB):

```
1. Goal and scope           assignment.goal, scope description, artifact path, write/read posture
2. Your seat               "You are the skeptic in an adversarial pair. Round 2 of 3."
3. The handoff             the counterpart's last report headline + output excerpt (bounded)
4. Unread mail             up to mailbox.inlineMax messages, oldest first, then "N older — call read_mailbox"
5. Open decisions          any open question card for this assignment + how to state a stance (§6.4)
6. Termination rules       rounds remaining, budget remaining, what convergence means here
7. Required close          "Before you finish, call mcp__agentmanager__report_status with your verdict."
```

Sections 3–5 are the only dynamic parts; templates live in code and are not user-editable in v1.

### 3.3 v1's pattern: the adversarial pair

**Shape.** Two seats. `drafter` (role `architect` **or** `implementer`) produces the artifact;
`critic` (role `skeptic`) attacks it. A round is one drafter turn followed by one critic turn. The
artifact is a real file at `scope.artifactPath` — required, because a critique of a chat message is
a conversation, while a critique of a file is a review with a diff.

```jsonc
// pattern_config_json for `pair`
{ "roundCap": 3,                       // config default; user-adjustable 1..orchestrator.patterns.pair.maxRoundCap
  "seats": { "drafter": "ada-architect", "critic": "sam-skeptic" },
  "convergence": "critic-accepts",     // the only v1 value
  "requireArtifact": true }
```

**Turn order and `plan()`, exactly.**

| State | Plan |
|---|---|
| No turns | Round 1, `drafter`, `startSession`. Prompt: goal + scope + "write the first draft to `<artifactPath>`". |
| Last turn = `drafter`, reported | Same round, `critic`. `startSession` (round 1) or `continueFrom` (round ≥ 2). Prompt carries the drafter's headline, the artifact path, and "list blocking issues; call `report_status` with `verdict`". |
| Last turn = `critic`, `verdict.decision === 'accept'` **and** `verdict.blocking` empty | **Terminate** `converged`. |
| Last turn = `critic`, otherwise | If `roundsUsed + 1 > roundCap` → **terminate** `round_cap`. Else round + 1, `drafter`, `continueFrom`, prompt carrying the blocking issues verbatim. |
| Last turn = `drafter`, and the artifact hash is unchanged from the previous round **and** the report claims a revision | **Halt** `no_progress` (§8). |
| Last turn `unstructured` and it is the first such for that seat | Re-plan the **same** seat and round with an explicit "you must call `report_status`" instruction. `retryOf` recorded on the new turn row. |
| Last turn `unstructured` twice for the same seat, or `failed`/`orphaned` twice consecutively | **Halt** `turn_failures`. |
| Last turn `blocked` (the seat's `request_user_decision` expired its hold and it stopped) | Wait. On `question.answered`, re-plan the **same** seat and round with the answer prepended. |

**Convergence: LLM proposes, deterministic rule decides.** The critic proposes `accept` or `revise`;
the engine converges only on `accept` **with an empty blocking list**. An "accept, but these three
things are blocking" report is treated as `revise` — the words lose to the structure. This is the
answer to "two LLMs critiquing each other could loop politely forever": politeness cannot terminate
the loop early, and the round cap terminates it late. Neither agent can extend the cap.

**Termination in all cases produces a card.** On `converged` the engine closes the assignment with
`close_reason: converged` and sets **`phase: converged`** — §2.2's one exception to "closing sets
`phase: closed`", and the only path that reaches that phase value. The user gets an informational
completion card (not a question) with the artifact path, rounds used, tokens used, and the critic's
final verdict. On `round_cap` the user gets a **question** card: *Accept as-is* / *Run N more rounds*
(bounded by `maxRoundCap`) / *Close unfinished*, with each seat's last stance attached (§6). The user
is the tie-breaker exactly once, at the end, rather than being asked every round.

**Cost shape, stated honestly.** A 3-round pair is 6 sessions. With `continueFrom` the conversation
is cached but not free. The default `pair` budget is 400 k tokens (§7) and the projection check at
creation refuses a configuration whose `roundCap × seats × turnEstimateTokens` exceeds the budget —
this is roster §8's sanctioned lever ("may refuse to start an assignment whose projected cost exceeds
its budget"), not a downgrade.

### 3.4 v2 sketches — not built in v1

**Overseer + workers.** An `overseer`-led assignment whose lead decomposes a goal into work items
(projects §1.5) and calls `create_assignment` to mint one child assignment per item, each with a
budget debited from the parent's remainder. The overseer's own turns are driven by `sequential` on a
"review the children" cadence; children are independent assignments with their own drivers. Needs
three things v1 does not have: parallel drivers (the engine's mutex is per assignment, which is
already right, but the breaker and budget rollup become a tree), a completion-verification story
(the overseer must read the child's artifact, not trust its report), and the write-capable approval
gate (§8) actually exercised. Sketch only.

**Review loop.** `implementer` → `reviewer` → implementer, terminating on the reviewer's `accept`
— structurally the pair with a different seat vocabulary and a different prompt set, plus one real
addition: the reviewer runs against a **diff**, not a file, which needs a git-diff capture that
projects would own. It is deliberately *not* shipped in v1 despite being nearly free, because it is
the first pattern that edits code concurrently and therefore the first that needs worktrees, scope
enforcement and the write gate all working together.

---

## 4. The in-process MCP server

### 4.1 Mounting: one server instance per launch

The six tools are exposed through a `createSdkMcpServer` instance built **per session launch**, by
`getSessionToolset({ assignmentId, agentId, sessionId?, role, isOverseer })`. The instance closes over
that `LaunchIdentity`. This is the whole basis of scoping (§4.2): the tool implementation does not
ask *who is calling* — it already knows, because the server was made for exactly one launch.

Getting it into the SDK options is the one wiring question. Runner's whitelist (runner §3.3) does not
include `mcpServers`, and roster's compiler is "the single place in the codebase that touches SDK
option shapes" (roster §0) and already compiles the matching allow rules. So **roster mounts it**:
`compileSession` calls `ctx.require('orchestrator')?.getSessionToolset(...)` and places the result at
`options.mcpServers.agentmanager`. When the orchestrator module is disabled the require returns
undefined, nothing is mounted, and roster's existing rule-dropping diagnostic (roster §11) is already
the correct behaviour. This needs one row in roster §13's mapping table — raised as R1 (§17).

**Which agents get which tools.** Roster compiles the allow rules; the server exposes the tools it is
told to. The split:

| Tool | Overseer (`capabilities.overseer`) | Worker |
|---|---|---|
| `list_roster` | ✔ | ✖ |
| `create_assignment` | ✔ | ✖ |
| `send_to_agent` | ✔ | ✔ (own assignment) |
| `read_mailbox` | ✔ | ✔ (own assignment) |
| `report_status` | ✔ | ✔ |
| `request_user_decision` | ✔ | ✔ |

Roster §11 currently grants a worker "at most `send_to_agent` and `read_mailbox`". A worker also needs
`report_status` (it is the structured completion channel the pattern's convergence rule reads) and
`request_user_decision` (it is how a member's recommendation reaches the question card at all).
Neither can create work, see the roster, or reach outside the assignment. Raised as R1b (§17) rather
than assumed.

### 4.2 Enforcement lives in the tool, not in the rules

Permission rules match tool *names*; they cannot express "only your own assignment". So every scoped
tool starts with the same check against the closed-over `LaunchIdentity`:

```ts
function scopeOf(id: LaunchIdentity): Set<AssignmentId> {
  // worker: exactly its own assignment.
  // overseer: its own assignment + assignments whose parent_assignment_id is its own.
  return id.isOverseer ? new Set([id.assignmentId, ...childIds(id.assignmentId)])
                       : new Set([id.assignmentId]);
}
```

and every refusal returns a structured, readable error ([A4]) naming the rule that refused —
`assignment_out_of_scope`, `agent_not_in_assignment`, `assignment_closed`, `rate_limited`,
`budget_exceeded`, `nesting_depth`, `project_not_active`. An agent that learns *why* it was refused
stops retrying; a generic failure produces three more attempts and a breaker trip.

Two further invariants, both enforced in the server:

- **The assignment must still be `open`.** A tool call from a session whose assignment closed while
  it was running is refused, not queued.
- **Per-session call caps.** `orchestrator.breakers.messagesPerTurn` (default 20) sends,
  `maxAssignmentsPerSession` (default 5) creates, `maxDecisionsPerSession` (default 3). Exceeding one
  refuses the call *and* trips the breaker (§8), because a tool loop is exactly the runaway shape
  circuit breakers exist for.

### 4.3 The six tools

All argument schemas are zod; all responses are JSON content blocks. `assignmentId` is **never** an
argument — it is implicit in the launch identity, which removes an entire class of "the agent named
someone else's assignment" bugs.

**`list_roster`** — overseer only.
```jsonc
// args
{ "role": "skeptic",          // optional filter, the pinned five
  "specialty": "documentation",// optional, roster's enum
  "tag": "backend",            // optional
  "availableOnly": true }      // default true: excludes agents at maxConcurrentPerAgent
// result
{ "agents": [ { "id": "sam-skeptic", "name": "Sam", "specialty": "code-review",
                "tagline": "…", "tags": ["…"], "roles": ["skeptic","reviewer"],
                "overseer": false, "modelTier": "balanced",
                "openAssignments": 1, "available": true } ] }
```
Never returns permissions, integrations, secret refs, or file paths (roster §11: "It has no business
knowing their credentials").

**`create_assignment`** — overseer only.
```jsonc
// args
{ "pattern": "pair",                                  // solo | pair  (v1; review/overseer refused)
  "goal": "Draft the migration plan for the billing subsystem",
  "members": [ { "agentId": "ada-architect", "role": "architect" },
               { "agentId": "sam-skeptic",  "role": "skeptic" } ],
  "scope": { "paths": ["docs/billing/"], "description": "…", "artifactPath": "docs/billing/plan.md" },
  "write": true,                                       // the drafter must write the artifact; the
                                                       // scope paths confine every mutating tool to
                                                       // `docs/billing/` (§2.5)
  "tokenBudget": 150000,                               // required for a machine-created assignment
  "roundCap": 2,
  "workItemIds": ["01J…"],
  "autoStart": true }
// result
{ "assignmentId": "01J…", "status": "open", "phase": "planned",
  "warnings": ["scope overlaps assignment 01J… (read-only)"],
  "gate": { "questionId": "01J…", "reason": "write-capable assignment created by an overseer" } }
```
Deterministic refusals (§9): project not `active`; project ≠ the caller's project; nesting depth > 1;
`tokenBudget` null, or greater than the parent's remaining budget; projected cost exceeds the budget;
a member's role absent from its `capabilities.roles`; a member archived or at its concurrency cap;
pattern `overseer` (no overseers minting overseers in v1). A `write: true` request always creates the
assignment at `phase: planned` behind an approval gate and never starts a session before the human
approves.

**`send_to_agent`**
```jsonc
{ "to": "sam-skeptic",        // or omit with "broadcast": true
  "broadcast": false,
  "kind": "note",             // note | handoff | question | answer | status
  "body": "…markdown, ≤ 8 KB…",
  "payload": { }              // optional structured extra, ≤ 4 KB
}
→ { "messageId": "01J…", "delivery": "mailbox", "recipientWillSeeIt": "at its next turn in this assignment" }
```
The `recipientWillSeeIt` string is deliberate: the tool tells the agent the truth about delivery
(§5) rather than letting it assume a live channel.

**`read_mailbox`**
```jsonc
{ "unreadOnly": true, "limit": 20, "since": "2026-08-16T…", "markRead": true }
→ { "messages": [ { "id", "from", "kind", "body", "payload", "createdAt" } ], "unreadRemaining": 0 }
```
Scoped to `scopeOf(identity)` and to messages addressed to the calling agent or broadcast.

**`report_status`** — the structured completion channel.
```jsonc
{ "state": "done",                    // working | blocked | needs_review | done
  "headline": "Draft complete: 4 sections, open question on retention",
  "detail": "…optional markdown…",
  "artifacts": [ { "path": "docs/billing/plan.md", "kind": "doc" } ],
  "verdict": { "decision": "revise",  // accept | revise   (critic/reviewer seats)
               "blocking": [ { "severity": "high", "summary": "No rollback path for step 3" } ],
               "nonBlocking": ["naming nit in §2"] } }
→ { "recorded": true, "round": 2, "roundsRemaining": 1, "tokensRemaining": 210000 }
```
Written to the calling session's `assignment_turns` row, emitted as `assignment.turn.reported`, and
echoed back with the remaining budget and rounds — which is cheap, and is the only honest way an
agent learns how much room it has left.

**`request_user_decision`** — the aggregation-aware ask.
```jsonc
{ "question": "Store transcripts in the DB or on disk?",
  "options": [ { "id": "disk", "label": "On disk", "description": "…" },
               { "id": "db",   "label": "In SQLite" } ],
  "recommendation": { "optionId": "disk", "strength": "strong", "rationale": "…one or two sentences…" },
  "urgency": "blocking",              // blocking | advisory
  "multiSelect": false, "allowFreeText": true }
→ { "status": "answered", "answer": { "optionIds": ["disk"], "text": null }, "answeredVia": "remote" }
   | { "status": "pending", "questionId": "01J…",
       "instruction": "No answer yet. Stop here, call report_status with state 'blocked', and end your turn.
                       You will be continued with the answer." }
```
`strength` is the stance ladder of §6.2 and is **required** when a recommendation is given —
an agent may decline to recommend, but it may not recommend without saying how hard it is
recommending.

### 4.4 The hold, and why `request_user_decision` never parks a session

The handler holds for `runner.question.holdMs` (15 min, the same number as runner's bridge, read from
runner's config rather than duplicated). Inside the hold the answer returns as the tool result and the
agent carries on with nothing lost.

Past the hold it returns `status: 'pending'` with the instruction above, the agent finishes its turn,
and the session ends **`done`** — not paused. The turn row is marked `blocked`. When the answer
arrives, the engine re-plans that seat with `continueFrom` and the answer prepended (§3.3).

This is deliberately *different* from runner's `canUseTool` park (runner §5.4), and the difference is
the point: runner parks because it holds a pending tool call it cannot abandon, and it owns the
auto-resume. Orchestrator holds nothing — so it lets the turn end cleanly and re-drives it from the
pattern engine, which is machinery that already exists. Two systems resuming the same session is the
bug runner §15.1-7 warns about, and this design never creates that situation. (An agent that wants
the strictly better inline behaviour should use the built-in `AskUserQuestion`, which goes through
runner's bridge and keeps the tool call pending; the prompt templates say so. `request_user_decision`
exists for decisions that need a *recommendation with a stance*, which `AskUserQuestion` cannot
carry.)

---

## 5. Messaging

**Transport: rows in foundation's `messages` table** — settled by foundation §8 ("atomic-file hives
lose ordering and delivery state under concurrent assignments"). This design adds only the vocabulary
and the delivery semantics.

```
messages(id, assignment_id, from_agent_id, to_agent_id NULL=broadcast, kind, body,
         payload_json, created_at, delivered_at, read_at)
kind ∈ note | handoff | question | answer | status
```
Broadcast read-state is per recipient and lives in `message_reads` (§2.1); `messages.read_at` stays
as the direct-message convenience, set when the sole recipient reads it.

### 5.1 Delivery semantics, stated honestly

**Agents are not processes. They are turns.** An agent observes mail only when a session of its is
running, and only at two moments:

1. **At launch**, because the engine inlines unread mail into the prompt (§3.2 section 4) — up to
   `mailbox.inlineMax` (10) messages and `mailbox.inlineMaxBytes` (8 KB), oldest first, with a count
   of the remainder and an instruction to call `read_mailbox`.
2. **Mid-turn**, if the agent calls `read_mailbox` itself.

Therefore:

| Recipient state when a message is sent | When it is seen |
|---|---|
| Has a turn planned or running later in the pattern | At that turn's launch (inlined), or sooner if it calls `read_mailbox` |
| Currently running, message arrives mid-turn | Only if it calls `read_mailbox` again before finishing. **Not pushed.** |
| Has no further turn in the assignment (parked, or the assignment is winding down) | **Never, by an agent.** At assignment close, undelivered messages are marked `undeliverable` and rendered in the conversation view with that label |

`delivered_at` is set when a message is either returned by `read_mailbox` or inlined into a launch
prompt; `read_at` (or a `message_reads` row) when an agent actually received it in either way. The UI
renders undelivered mail distinctly, because "I sent it and they ignored me" and "I sent it and they
never saw it" are different failures and only one of them is the agent's fault.

**Not pushing into a live session is a decision, not an omission.** Runner's
`steer(sessionId, text)` could deliver mail into a running session at the next turn boundary. It is
declined for v1 because a steered message starts another turn inside a session that the engine has
already accounted for as one turn, which makes round accounting, budget attribution and the turn
table all lie. Deferred (§18) with that as the thing to solve first.

---

## 6. Questions, recommendations, and the one card

### 6.1 One inbox, three kinds

Everything a human must answer is a row in `questions` with a `kind` from foundation's set:

| `kind` | Raised by | Example |
|---|---|---|
| `question` | runner, via `QuestionBridge.ask` — an `AskUserQuestion` call or an undecided tool gate (runner §5.1); or orchestrator, via `request_user_decision` | "Postgres or SQLite?" |
| `budget_halt` | runner, when `tokens_used` crosses `token_budget` (runner §7.2) | "This pair has used its 400 k budget" |
| `approval_gate` | **orchestrator only** (runner §15.1-8) | "Approve a write-capable assignment", "Circuit breaker tripped" |

Orchestrator implements `QuestionBridge` (runner §5.2) verbatim, persists the row, attaches
recommendations, resolves the promise on answer, and records `answered_via` from foundation's request
origin. `POST /api/questions/:id/answer` is the single answer path for local and remote alike.

### 6.2 The stance ladder — the honest weight

The brief's requirement is a per-agent recommendation with a weight that is not a fake percentage.
Self-reported numeric confidence from an LLM is poorly calibrated and *looks* precise, which is worse
than being vague. So the weight is a **forced choice from a four-value ordinal ladder**, stored in
`question_recommendations.strength`, rendered as words and never as a number:

| `strength` | Means | Rendered |
|---|---|---|
| `blocking` | "I do not agree to the alternative; proceeding the other way is a mistake I would refuse to implement" | Red, sorted first, marks the card `contested` when members disagree |
| `strong` | "I recommend this and would argue for it" | Bold |
| `lean` | "Mild preference; I do not have enough information to be firm" | Normal |
| `defer` | "No preference — this is the other seat's call, or the user's" | Muted, no option required |

Foundation's `question_recommendations(question_id, agent_id, stance, rationale, strength)` maps
exactly: `stance` holds the recommended option id (or free text, or `null` for `defer`), `strength`
holds the ladder word, `rationale` holds one to two sentences. Foundation left the shape of `strength`
to orchestrator; this is that decision.

Ordering on the card is deterministic: **strength rank first, then the pattern's declared seat order**
(for the pair, critic before drafter on a risk question, because the seat that exists to find problems
is the seat whose objection you want at the top). No scores, no averaging, no synthesis of a "team
recommendation" — the card shows *who said what, how hard, and why*, and the human decides.

### 6.3 Consolidation into one card

```
disagreement = distinct non-null `stance` values among the recommendations > 1
contested    = disagreement AND any strength === 'blocking'
```

A card is created per ask, then **joined**: an incoming ask joins an existing `open` question of the
same assignment when *all* of the following hold — normalised prompt text is equal (case-folded,
whitespace-collapsed, punctuation-stripped, first 200 chars), the option id sets are equal, and the
existing question is younger than `orchestrator.questions.joinWindowMs` (default 120 s). Exact
normalised equality, not fuzzy similarity: a scoring threshold here would silently merge two
different questions, and a merged question answered once is a wrong answer delivered twice.

A joined ask adds a `question_recommendations` row and resolves against the *same* answer when it
lands. Both askers get the same answer, both sessions carry on, and the user saw one card.

### 6.4 Consolidation in a sequential pattern

v1's pair runs one seat at a time, so two members almost never ask simultaneously and the join window
rarely fires. The mechanism that actually produces two-sided cards in v1 is **stance solicitation**,
and it costs nothing extra:

> When an open question exists for an assignment and another seat's turn is being planned anyway, the
> prompt's *Open decisions* section names the question, its options, and asks the seat to state its
> stance by calling `request_user_decision` with the **same** question text and options plus its own
> recommendation. The join rule (§6.3) then folds it into the existing card — except that the join
> window is waived for a solicited stance, because the card is explicitly waiting for it.

No extra turn, no extra session, no polling. If the seat declines to state a stance, the card stands
with one recommendation and says so. Configurable off with
`orchestrator.patterns.pair.stanceSolicitation: false`.

### 6.5 Expiry

**Orchestrator owns the transition; runner owns the session.** The `questions.status → expired` flip
is this element's, performed by its sweep (and the boot sweep of IMPLEMENTATION M2) against
`runner.question.expireHours` (24, read from runner's config, §12) — orchestrator is the only writer
of the `questions` table, so it is the only thing that may expire a row. It emits `question.expired`;
runner **reacts** by moving the parked session to `interrupted` / `question_expired` (runner §5.4) and
expires nothing itself. Orchestrator's own rules on top of the flip:

- An expired `approval_gate` is a **denial**, not a pass: the assignment closes with
  `gate_expired`. Fail closed is the only defensible default for something whose whole purpose is a
  human check.
- An expired `budget_halt` closes the assignment with `budget_exhausted`.
- An expired plain `question` leaves the assignment `halted` with `haltReason: question_expired`, so
  the user can still revive it from the assignment page. The card stays in the inbox as the record.

---

## 7. Budgets

### 7.1 What each element owns

Runner owns the arithmetic and the trigger, in the same transaction as the usage write
(runner §15.1-6): `assignments.tokens_used += input_tokens + output_tokens`, cache tokens excluded;
on crossing `token_budget` it pauses the session with `exit_reason: budget_halt`, raises a
`budget_halt` question, and emits `assignment.budget.exceeded`. Orchestrator never re-derives a token
total and never polls one.

Orchestrator owns the *policy*: what the budget is, what the card offers, and what happens next.

### 7.2 Defaults

| Assignment | Default `token_budget` | Default `round_cap` |
|---|---|---|
| `solo`, user-created | `null` (uncapped) | `null` |
| `pair`, user-created | `orchestrator.budgets.defaultPairTokens` (400 000) | 3 (max 6) |
| **Any** assignment created by an overseer | **Required, non-null**, ≤ the parent's remaining budget | Required |

The asymmetry is the point: work a human launched and is watching needs no machine cap, and work a
machine created always has one. An overseer cannot mint an uncapped assignment, cannot exceed its
parent's remaining budget in aggregate across its children, and cannot raise its own budget
(roster §11: "nor the ability to approve its own budget overrun").

**Projection check at creation** (roster §8's sanctioned refusal): if
`roundCap × seats × orchestrator.budgets.turnEstimateTokens` (default 25 000) exceeds `tokenBudget`,
a user-created assignment gets a warning and a machine-created one is refused. `turnEstimateTokens` is
labelled in the UI and the config comment as **a crude planning constant, not a prediction** — it is
one number in a config file, and calling it an estimate would be dressing a guess up as arithmetic.

### 7.3 The halt card

When runner raises `budget_halt`, orchestrator sets `phase: awaiting_user`, stops planning new turns,
and renders the card:

| Option | Effect |
|---|---|
| **Raise budget** (+50 %, or an entered amount, bounded by `budgets.raiseMaxFactor` × the original — default 2×) | Update `token_budget` **first**, then resolve the question. Runner's auto-resume (runner §5.4) then finds headroom and the parked session continues. A raise beyond the factor requires an `approval_gate` of its own. |
| **Continue once** | Grant a one-shot overdraft of `budgets.overdraftTokens` (25 000) by raising `token_budget` by that amount and recording it as an overdraft, so the next crossing asks again. |
| **Close assignment** | Set `status: closed`, `close_reason: budget_exhausted`, emit `assignment.closed`, then resolve the question. Runner's auto-resume re-checks assignment status at admission and refuses — which is why the state change happens *before* the answer resolves, in that order, every time. |

The ordering rule is worth stating once: **mutate the state the answer implies, then resolve the
question.** Resolving first races runner's auto-resume.

### 7.4 Cheaper models for secondary roles

Bounded by roster §8 and settled in §2.4: model comes from the agent definition placed in the seat,
chosen by a human at creation time, surfaced in the create dialog (each candidate's tier is shown),
and warned about when the seat tiers are inverted. Nothing downgrades a model at runtime. The
declared per-seat override is deferred (§18, R2).

---

## 8. Guardrails

### 8.1 Circuit breakers (v1)

All are **deterministic counters over persisted state**, evaluated by the engine before every
`plan()`. No heuristics, no model in the loop.

| Breaker | Trigger | Action |
|---|---|---|
| `budget` | Runner's `assignment.budget.exceeded` | `phase: awaiting_user`, budget-halt card (§7.3). No new turns. |
| `round_cap` | `roundsUsed` would exceed `round_cap` | Terminate `round_cap` with the choice card (§3.3). |
| `turn_failures` | 2 consecutive turn sessions ending `failed` or `orphaned` in one assignment | Halt `turn_failures`, `approval_gate` card carrying both `exit_reason`s and the last error. |
| `unstructured` | The same seat produces 2 turns with no `report_status` | Halt `no_report`, card offering *Retry with stricter instruction* / *Accept the prose output* / *Close*. |
| `no_progress` | 2 consecutive drafter turns with an unchanged `artifact_hash` while claiming a revision | Halt `no_progress`. This is the "politely looping forever" guard the round cap alone does not catch. |
| `tool_denials` | `permission_denials` ≥ `breakers.denialsPerSession` (5) in one session, or any denials in 3 consecutive turns | Halt `permission_fight`, card naming the denied tools and offering the roster/project edit that would fix it. An agent repeatedly hitting a wall is a configuration bug, not an agent bug. |
| `tool_flood` | Per-session MCP call caps exceeded (§4.2) | Refuse the call, halt `tool_flood`, and `RunnerService.stop` that session. |
| `stale` | An `open` assignment with no turn transition for `assignment.maxAgeHours` (24) | Halt `stale`, card offering *Continue* / *Close*. Catches wedges nothing else notices. |

A halt sets `phase: halted` and `halt_reason`, plans no further turns, emits `assignment.halted`, and
raises exactly one card. **Running sessions are not killed by a halt** except `tool_flood` — the work
in flight is usually worth finishing, and killing it mid-tool-call is the harm runner §6.3 refuses to
do for preemption.

Counters are re-derived from `assignment_turns` on every evaluation rather than being maintained
incrementally, so a restart cannot lose or double-count one.

### 8.2 Approval gates

An `approval_gate` is a `questions` row rendered in the same inbox with **Approve / Deny / Modify
(free text)**, attributed to the requesting agent or to "AgentManager" for engine-raised gates, and
carrying whatever recommendations exist. It never auto-approves; expiry is denial (§6.5).

What requires one in v1 — a deliberately short list, because a gate that fires constantly gets
clicked through:

1. An overseer calling `create_assignment` with `write: true`. (v1's headline slice is a *user*-created
   pair — it is `write: true`, but scoped to a docs path — and v1 ships no overseer pattern, so this
   gate does not fire in the v1 slice at all. It is the thing that makes v2's code-editing patterns
   safe to switch on.)
2. Any circuit-breaker halt that offers a "continue" option (§8.1).
3. A budget raise beyond `budgets.raiseMaxFactor` × the original.
4. Starting a **write-capable** assignment whose scope overlaps another **write-capable** open
   assignment (§2.6).
5. Closing an assignment whose workspace lease holds a worktree with unmerged commits — the gate
   text names the branch and the commit count, and the default is *keep* (projects §4.4 never
   discards agent output).

Explicitly **not** gated in v1: individual tool calls (that is roster's `ask` rules plus runner's
bridge, and duplicating it here would be two systems asking the same question), and every ordinary
turn transition.

---

## 9. Routing: LLM proposes, deterministic rules enforce

**Decision: both, with a hard split.** An overseer agent may *propose* any decomposition it likes —
who works on what, in what pattern, with what scope. Every proposal passes through the same
`createAssignment` validator as a human's, and the validator is pure, deterministic, and refuses with
a named rule. Nothing the model says can widen what the rules allow.

The complete v1 rule set, applied in order:

1. The module is enabled and the project is `active` (not `provisioning`, not `archived`).
2. The target project equals the caller's project. An overseer cannot reach across projects.
3. `parent.parent_assignment_id IS NULL` — nesting depth ≤ 1. No overseer minting overseers.
4. The pattern is one this build ships with a driver (`solo`, `pair`).
5. Every member's role ∈ the pinned five **and** ∈ that agent's `capabilities.roles`.
6. The lead seat is `capabilities.overseer` for pattern `overseer`; the drafting seat leads a pair.
7. No member is archived; no member exceeds `assignment.maxConcurrentPerAgent`; no agent fills two
   seats.
8. `tokenBudget` is non-null and ≤ the parent's `token_budget − tokens_used − Σ(open children's
   budgets)`.
9. The projection check of §7.2 passes.
10. `write: true` ⇒ the assignment is created `phase: planned` behind an approval gate.
11. Scope paths are repo-relative, contain no `..`, and resolve inside the project.

Why not rules-only: decomposing a fuzzy goal into scoped work is exactly the judgement an LLM is for,
and a rules-only router would need the user to do that decomposition, which is the work the
orchestrator exists to remove. Why not LLM-only: a model that can create budgeted, permissioned,
write-capable work by emitting text is a model whose worst turn is an incident. Proposal and
enforcement are different jobs and are implemented by different things.

---

## 10. Notification when the user is away

**Decision: the question inbox is served over the tailnet (D5) and the v1 push channel is
[ntfy](https://ntfy.sh) — one outbound HTTPS POST to a user-configured topic URL.**

- **Why ntfy**: no inbound port, no OAuth dance, no SMTP credentials, no app-store presence, no
  account. It is one URL in the secret store and one `fetch`. It delivers to a phone that is not on
  the tailnet, which is the actual failure case ("an approval gate is worthless if nobody sees it for
  six hours").
- **The link in the notification is the tailnet URL** of the question card. So the notification wakes
  the user and the tailnet serves the answer — the phone must be on the tailnet to *answer*, which is
  correct: D5 says the API is Tailscale-only, and a notification is not an authorization.
- **Where it lives**: here. The trigger, the payload and the urgency are orchestrator's, and v1 has
  exactly one consumer. A tiny `Notifier` with one `send(payload)` method behind
  `orchestrator.notify.*` config. If a second consumer ever appears (remote wanting to announce a new
  device), it moves to foundation unchanged (§17, R5).
- **When**: a question that is still `open` after `notify.afterMs` (default 60 s) and whose level
  meets `notify.minLevel` (default: `approval_gate` and `budget_halt` always; plain `question` only
  when `urgency: 'blocking'`). The 60-second delay is what stops a user sitting at the desk from
  being pushed for something they answered in ten seconds.
- **Rate limit**: at most one notification per question, and at most `notify.maxPerHour` (default 6)
  overall; suppressed ones are counted into a single digest notification.
- **Edition**: the work edition defaults `orchestrator.notify.enabled: false`. Outbound push from a
  work machine is a policy question, not a preference (§17, R5).

Deferred, explicitly: SMTP/email (credentials, deliverability, and a spam folder between the user and
an approval gate), generic webhooks (no v1 consumer), Web Push with VAPID (the right long-term answer
once `tailscale serve` gives the UI real TLS — it needs no third party at all), and desktop toasts
(local-only, and it is the Electron shell's job in ui, not ours).

---

## 11. Status aggregation, API and events

### 11.1 HTTP (on foundation's single route table, therefore remote-reachable)

```
POST   /api/assignments                    create from a pattern → { id, warnings, gate? }
POST   /api/assignments/solo               { projectId, agentId, prompt, role?, write?, workItemIds? } → { assignmentId, sessionId }
GET    /api/assignments                    ?projectId=&status=&phase=&agentId=&limit=&before=
GET    /api/assignments/:id                record + members + turns + budget + open questions
PATCH  /api/assignments/:id                tokenBudget, roundCap, goal   (never members or pattern)
POST   /api/assignments/:id/advance        plan the next turn now (manual kick after a halt)
POST   /api/assignments/:id/close          { reason }
GET    /api/assignments/:id/conversation   §11.2 — the readable pair transcript
GET    /api/questions                      ?status=open&assignmentId=   the inbox
GET    /api/questions/:id
POST   /api/questions/:id/answer           { optionIds?, text? }        local or remote, `answered_via` recorded
GET    /api/orchestrator/status            §11.3 — the fleet view
GET    /api/patterns                       pattern definitions, seats, defaults (drives the create dialog)
```

**The `GET /api/questions` list projection is pinned** (ui §19, R5), because the inbox is the one
screen a phone loads cold and it must cost exactly one request. Each item carries:

```jsonc
{ "id": "01J…", "kind": "question", "status": "open",
  "prompt": "…", "options": [ { "id": "disk", "label": "…" } ],
  "createdAt": "…", "expiresAt": "…",
  "assignmentId": "01J…", "projectId": "…", "sessionId": "01J…",
  "recommendations": [ { "agentId": "sam-skeptic", "role": "skeptic",
                         "stance": "disk", "strength": "strong", "rationale": "…" } ],
  "disagreement": true, "contested": false, "answeredVia": null }
```

That is the same card §16.1 defines — a `questions` row plus its recommendations — with the
assignment, project and session ids denormalised onto it. Embedding the recommendations and the ids
is the point: rendering the inbox otherwise means one list request plus N joins back against
assignments and roster, over a tailnet link, before the first card can draw. Filters are
`?status=&assignmentId=`; ordering is newest first; `GET /api/questions/:id` returns this same shape
plus the full answer record.

### 11.2 The conversation view

The single read the UI's "collaborations render as a readable conversation" requirement needs: an
ordered merge of turns and messages for one assignment.

```jsonc
{ "assignmentId": "01J…", "pattern": "pair", "phase": "running",
  "rounds": [ { "round": 1, "entries": [
      { "type": "turn", "seat": "drafter", "agentId": "ada-architect", "role": "architect",
        "sessionId": "01J…", "status": "reported",
        "report": { "state": "done", "headline": "…", "artifacts": [ { "path": "…" } ] },
        "excerpt": "…first 2 KB of the last assistant message…",
        "tokens": { "input": 0, "output": 0 }, "startedAt": "…", "endedAt": "…" },
      { "type": "message", "from": "ada-architect", "to": "sam-skeptic", "kind": "handoff",
        "body": "…", "delivery": "inlined", "createdAt": "…" },
      { "type": "turn", "seat": "critic", "…": "…",
        "report": { "verdict": { "decision": "revise", "blocking": [ … ] } } },
      { "type": "question", "questionId": "01J…", "kind": "question", "prompt": "…",
        "recommendations": [ { "agentId": "…", "stance": "disk", "strength": "strong", "rationale": "…" } ],
        "disagreement": true, "contested": false, "answer": { "optionIds": ["disk"] } } ] } ] }
```

Full output is always one click away — every turn carries its `sessionId`, and the transcript is
runner's `GET /api/sessions/:id/transcript`. Orchestrator stores excerpts, never a second copy of the
transcript.

### 11.3 Fleet status

`GET /api/orchestrator/status` answers "what is every agent doing", derived from `assignments` +
`assignment_turns` joined to runner's sessions through foundation's repositories:

```jsonc
{ "agents": [ { "agentId": "ada-architect",
                "state": "working",        // idle | queued | working | awaiting_user | paused | halted
                "assignmentId": "01J…", "sessionId": "01J…", "role": "architect",
                "headline": "Draft complete: 4 sections", "since": "…" } ],
  "assignments": { "open": 2, "halted": 0, "awaitingUser": 1 },
  "questions":   { "open": 1, "oldestOpenedAt": "…" } }
```

### 11.4 Events on foundation's bus

| Type | `persist` | Payload |
|---|---|---|
| `assignment.created` | ✔ | `{ pattern, members, scope, write, budget, roundCap, createdBy, warnings }` |
| `assignment.started` | ✔ | `{ firstTurnId, seat, agentId }` |
| `assignment.turn.started` | ✔ | `{ turnId, round, seat, agentId, sessionId, continueFrom }` |
| `assignment.turn.reported` | ✔ | `{ turnId, state, headline, verdict }` |
| `assignment.turn.ended` | ✔ | `{ turnId, status, sessionStatus, exitReason, tokens }` |
| `assignment.round.completed` | ✔ | `{ round, converged, blockingCount }` |
| `assignment.message` | ✖ | `{ messageId, from, to, kind }` — body lives in the table |
| `assignment.question.raised` | ✔ | `{ questionId, kind, prompt, recommendationCount, disagreement, contested }` |
| `assignment.question.answered` | ✔ | `{ questionId, answeredVia, latencyMs, decision }` |
| `assignment.budget.raised` | ✔ | `{ from, to, reason: 'raise' \| 'overdraft' }` |
| `assignment.halted` | ✔ | `{ haltReason, questionId }` |
| `assignment.conflict` | ✔ | `{ otherAssignmentId, paths, bothWrite }` |
| `assignment.closed` | ✔ | `{ closeReason, rounds, tokens, artifactPath }` — **runner releases the lease on this** |
| `orchestrator.notify.sent` | ✔ | `{ questionId, channel, ok }` |

`assignment.budget.exceeded` is runner's and is consumed, not re-emitted.

---

## 12. Configuration

Orchestrator's module sub-schema (foundation §2.1). `modules.orchestrator.enabled` stays where
foundation §2.3 already put it and is not duplicated here. Runner's `question.holdMs` and
`question.expireHours` are **read from runner's config**, never copied.

```jsonc
"orchestrator": {
  "patterns": {
    "pair": { "roundCap": 3, "maxRoundCap": 6, "stanceSolicitation": true, "requireArtifact": true }
  },
  "budgets": { "defaultPairTokens": 400000, "turnEstimateTokens": 25000,
               "overdraftTokens": 25000, "raiseMaxFactor": 2 },
  "assignment": { "maxAgeHours": 24, "maxConcurrentPerAgent": 2, "maxNestingDepth": 1 },
  "questions": { "joinWindowMs": 120000 },
  "mailbox":   { "inlineMax": 10, "inlineMaxBytes": 8192 },
  "prompt":    { "maxBytes": 16384, "excerptBytes": 2048, "outputCaptureBytes": 32768 },
  "breakers":  { "denialsPerSession": 5, "consecutiveFailures": 2, "identicalTurns": 2,
                 "messagesPerTurn": 20, "maxAssignmentsPerSession": 5, "maxDecisionsPerSession": 3 },
  "notify":    { "enabled": true, "channel": "ntfy", "afterMs": 60000, "maxPerHour": 6,
                 "minLevel": "blocking", "topicSecretRef": "notify.ntfy.topicUrl" }
}
```

---

## 13. The staged v1 slice

**The brief's candidate is confirmed — the adversarial pair on a docs/planning task — with one
correction to what ships first.**

The correction matters: runner has **no launch path at all** without this module
(runner §14 D9: `assignmentId` is required and runner never mints one). So the first thing
orchestrator ships is not the pair — it is the **solo assignment**, which is what unblocks every
other element's end-to-end path, followed by the **question bridge**, which is what unblocks runner's
`canUseTool` escalation and the UI's inbox. Both are small. The pair then lands on top of working
plumbing rather than alongside it.

The v1 slice, in order (milestones in [IMPLEMENTATION.md](IMPLEMENTATION.md)):

1. Module + schema + **solo assignment** + `AssignmentContext` + `assignment.closed`.
2. **QuestionBridge** + the `questions` inbox + recommendations + the stance ladder.
3. **Budgets**: halt card, raises, round-cap plumbing.
4. **Messages + the MCP server** with all six tools and assignment scoping.
5. **The pattern engine + the adversarial pair** — the headline slice.
6. Guardrails, notifications, aggregation and the status/conversation APIs.

Why the pair on docs/planning is still the right headline: it exercises messaging, turn-taking,
convergence, question aggregation and budgets end to end, while a **doc-only write scope** means the
worst outcome of a bad round is a bad paragraph — not two agents interleaving edits in one source
tree. The slice is `write: true`, because the drafter's whole job is writing the artifact file; what
makes it safe is the *scope*, not the absence of write. `scope.paths` is the artifact's directory, so
§2.5's `scopeRules` confine `Edit`/`Write`/`NotebookEdit` to it and roster denies the complement. It
also runs in the shared primary tree (projects §4.1), so it needs no worktree machinery to work at
all.

---

## 14. Architecture conformance

- **D1** — a TypeScript module under foundation's module contract; no PowerShell at runtime.
- **D2** — every pattern multiplies token spend, so budgets, round caps, projections and the halt
  card are load-bearing rather than decorative; turns run at `normal` priority behind runner's cap and
  queue; nothing downgrades a user-chosen model.
- **D3** — one HTTP/WS surface, consumed identically by Electron and the tailnet browser; the
  question inbox is answerable from both and records which.
- **D4** — this element *is* D4: the app routes work between agents, and roster's ban on the SDK
  subagent tool means the only delegation path is `create_assignment`, which passes through §9's
  rules.
- **D5** — no remote-specific behaviour; the notification channel carries a tailnet link and is not
  an authorization path.
- **D6** — edition is configuration: `notify.enabled` differs by edition file and nothing branches on
  edition.

---

## 15. Decisions

Every open question in [README.md](README.md), plus the ones this design had to settle.

**1. Is routing decided by an LLM overseer, deterministic rules, or both?**
**Both, split hard: the overseer proposes, `createAssignment`'s pure validator enforces (§9).**
Decomposing a fuzzy goal is exactly what a model is for; minting budgeted, permissioned, write-capable
work from generated text is exactly what it must not be trusted with. Every refusal names a rule, so
the agent learns instead of retrying.

**2. Message transport — atomic files or a persisted queue?**
**Rows in foundation's `messages` table**, already settled by foundation §8; this design adds the
`kind` vocabulary, `message_reads` for broadcast read-state, and honest delivery semantics (§5).
File-based hives lose ordering and delivery state the moment two assignments run at once.

**3. How does a worker report completion, and how does the overseer verify it?**
**`report_status` with a structured `verdict`, verified against an artifact, never against prose
(§4.3, §3.3).** The engine converges only on `decision: 'accept'` with an empty blocking list; a turn
with no report is `unstructured` and is a breaker input. Verification is reading the file the report
points at — which is why the pair pattern requires an `artifactPath`.

**4. What exactly triggers a circuit breaker or an approval gate in v1?**
**Eight breakers and five gates, all deterministic (§8).** Breakers: budget, round cap, two
consecutive session failures, two unreported turns from a seat, two identical artifact hashes,
repeated tool denials, MCP call floods, and a 24-hour staleness sweep. Gates: an overseer creating
write-capable work, any breaker offering a continue, a budget raise past 2×, overlapping write scopes,
and closing over an unmerged worktree.

**5. How is the user notified when away?**
**The inbox is served over the tailnet; the v1 push is ntfy — one outbound POST to a configured topic,
sent 60 seconds after a qualifying question stays open, carrying the tailnet link (§10).** No inbound
port, no OAuth, no SMTP, phone delivery off-tailnet. Email, generic webhooks and Web Push are deferred
and named; the trigger lives here because the payload and the urgency are this element's.

**6. Minimum viable v1 slice.**
**Solo assignment → question bridge → budgets → MCP/messaging → the adversarial pair on a
docs/planning task (§13).** The pair is confirmed as the headline; the correction is that solo ships
first, because runner cannot launch anything at all until it exists.

**7. Convergence control — who decides "done"?**
**The critic proposes, a deterministic rule decides, the round cap bounds it, and the user
tie-breaks exactly once at the cap (§3.3).** Convergence requires `accept` *and* an empty blocking
list, so an agreeable model cannot end the loop early and a stubborn one cannot extend it. Neither
agent can change the cap; the user sees one card at the end, not one per round.

**8. How are recommendation weights produced?**
**A forced choice from a four-word ordinal ladder — `blocking | strong | lean | defer` — rendered as
words, never as a percentage (§6.2).** Self-reported numeric confidence from an LLM is poorly
calibrated and looks precise, which is the worst combination. Cards sort by strength then by the
pattern's seat order, mark `disagreement` when stances differ and `contested` when a `blocking`
stance is in the disagreement, and never synthesise a team recommendation.

**9. Is an assignment's scope advisory or enforced?**
**Enforced for writes, advisory for reads (§2.5).** Path-scoped `Edit`/`Write`/`NotebookEdit` rules go
to roster, which intersects them into `allow` and denies the complement — so a write scope is a real
boundary. Reads are never scoped: it would degrade the work and secure nothing.

**10. How do pattern turns map onto runner's sessions?**
**One turn = one session; a seat's first turn is `startSession`, every later turn is
`continueFrom` (a new session with `resumed_from`); completion is observed on `session.ended`
(§3.2).** Runner's session ends at its first turn result and there is nothing to hold open, so the
loop lives entirely above it — in a pure `plan()` over persisted turn rows, so a restart re-derives
the same next step.

**11. Who mounts the MCP server into a session?**
**Roster's `compileSession`, calling `orchestrator.getSessionToolset()` through the service registry
(§4.1).** Runner's option whitelist excludes `mcpServers` and roster is the only place SDK option
shapes are touched. Raised as R1 rather than assumed.

**12. Does `request_user_decision` pause the session?**
**No — it holds for 15 minutes, then tells the agent to stop, and the engine re-drives that seat with
the answer (§4.4).** Runner already owns parking and auto-resume for questions *it* raised; a second
resumer for the same session is how work runs twice.

**13. Can an agent see mail while it is running?**
**Only if it calls `read_mailbox`. Nothing is pushed into a live session (§5.1).** Runner's `steer`
could do it and is deliberately declined: a steered message starts an extra turn inside a session the
engine has already counted as one, which breaks round accounting and budget attribution.

**14. What is an assignment's status vocabulary?**
**`open | closed` for the gate runner reads, plus a separate orchestrator-owned `phase`
(`planned | running | awaiting_user | halted | converged | closed`) for the UI and the driver
(§2.2).** One field cannot be both a coarse admission gate and a state machine without one of the two
consumers being lied to.

---

## 16. Contracts pinned for ui

1. **The question card** is a `questions` row plus its `question_recommendations`. Strength is one of
   `blocking | strong | lean | defer` — render the **word**, never a number or a bar. Sort by strength
   rank, then pattern seat order. `disagreement` and `contested` are computed server-side and returned
   on the card; the UI does not derive them.
2. **Attribution is always present**: every recommendation carries `agentId` and the role it held in
   the assignment. An engine-raised gate is attributed to "AgentManager", never to an agent.
3. **One inbox, three kinds** — `question`, `approval_gate`, `budget_halt` — with one answer endpoint
   (`POST /api/questions/:id/answer`) that works identically locally and over the tailnet.
   `answered_via` is recorded and displayed.
4. **Approval gates never auto-approve.** Expiry is denial; the UI must not offer a "default action on
   timeout" affordance.
5. **The conversation view** is `GET /api/assignments/:id/conversation` (§11.2): rounds → ordered
   entries of `turn | message | question`. Turn excerpts are bounded; the full record is the
   transcript at `GET /api/sessions/:id/transcript`. Message entries carry `delivery`
   (`inlined | read | undelivered`) and the UI must distinguish undelivered mail.
6. **Fleet status** is `GET /api/orchestrator/status` (§11.3) with the agent state vocabulary
   `idle | queued | working | awaiting_user | paused | halted`.
7. **Solo is not a special case.** A drag-and-drop launch calls `POST /api/assignments/solo` and gets
   `{ assignmentId, sessionId }`; the assignment page renders it with one member and no rounds. The UI
   never needs two code paths for "one agent" and "a collaboration".
8. **Budgets display in tokens.** `tokens_used / token_budget` with rounds beside it. Dollar figures
   are runner's `cost_usd` estimate and carry runner's §15.2-13 labelling rules; a budget is never
   shown as money.
9. **The create dialog** is driven by `GET /api/patterns`: seats, allowed roles per seat, defaults,
   and `preferredTier`. It shows each candidate agent's model tier and surfaces the `warnings[]` from
   the create call (scope overlap, projected cost, inverted tiers) before the user confirms.
10. **Live updates** come from the `assignment.*` events of §11.4; the persisted ones replay through
    `/api/events?since=`. `assignment.message` is not persisted — the conversation endpoint is its
    record.

---

## 17. Reconciliations raised

Per CLAUDE.md's ground rule, these are raised rather than silently diverged from. **All eight are now
resolved** — each target doc was amended, and the resolution names it under the item.

**R1 — roster §13: mount the orchestrator toolset.** `compileSession` must place the per-launch MCP
server instance at `options.mcpServers.agentmanager`, obtained via
`ctx.require('orchestrator')?.getSessionToolset({ assignmentId, agentId, role, isOverseer })`, and
omit it (with the existing rule-dropping diagnostic) when the module is absent. Roster §13's mapping
table gains one row. The alternative — adding `mcpServers` to runner's option whitelist (runner §3.3)
— is worse: it would put SDK option shaping in two elements. Roster is asked to take it.
**Resolved — see roster §13**, whose mapping table now carries the row and states that
`compileSession` mounts the per-launch instance, omitting the key when `require('orchestrator')`
returns undefined. Runner's whitelist (runner §3.3) is unchanged.

**R1b — roster §11: the worker tool grant.** Roster currently grants a worker "at most
`send_to_agent` and `read_mailbox`". Workers also need **`report_status`** (the structured completion
channel the convergence rule reads; without it there is no non-prose way for a worker to report) and
**`request_user_decision`** (without it a worker's recommendation cannot reach a question card, which
disables the aggregation feature the README requires). Neither creates work, reveals the roster, nor
reaches outside the assignment — all four remain assignment-scoped in the server (§4.2). Requested
grant: overseer = all six; worker = those four.
**Resolved — see roster §11**, which now states the four-tool worker grant in its own table and
names the assignment-scoping as the server's job; roster IMPLEMENTATION M7 compiles and tests it.

**R2 — runner §15.1-3 / roster §6.2: `AssignmentContext.scopeRules` cannot express `deny` or `ask`.**
A flat allow-list works for a write scope (roster derives the complement) but cannot express a
genuinely read-only assignment. Requested: either type the field as
`{ allow?: string[]; deny?: string[]; ask?: string[] }`, or have roster's compiler add a mutating-tool
deny when `AssignmentContext.write === false`. Preference: the latter — one flag, enforced in the sole
composer. Orchestrator has a workaround (§2.5) and is not blocked. The same field is where a declared
per-seat model override would eventually live (§18); that is not requested for v1.
**Resolved — see roster §6.2** (and roster §13's `AssignmentContext` shape): **both** halves landed.
`scopeRules` is now the three-bucket `{ allow?, deny?, ask? }` shape in runner §15.1-3, *and* roster's
compiler unions a mutating-tool deny into the assignment layer on `write === false`, which no later
layer can remove. §2.5 no longer carries a workaround; roster IMPLEMENTATION M4's acceptance covers
the flag against permissive baselines.

**R3 — runner §11.2: an in-process transcript read.** Requested:
`RunnerService.getTranscriptTail(sessionId, { maxBytes })` (or a foundation transcripts repository
method). Needed to recover a turn's output when the core restarts mid-turn and the live
`session.message` capture is lost. Runner already serves this over HTTP; the ask is the in-process
equivalent, so orchestrator does not make an HTTP call to its own process. Without it, such a turn is
marked `unstructured` and re-run — correct but wasteful.
**Resolved — see runner §11.2**: `getTranscriptTail(sessionId, { maxBytes })` is on `RunnerService`,
serving whole JSONL lines plus the next offset and reporting `pruned: true` rather than throwing.
§3.2's third output channel now reads it directly.

**R4 — projects §1.5: nobody writes `work_item_assignments`.** Projects owns the table and derives
work-item status from it ("an item flips to `in_progress` when an assignment linking to it starts"),
but no element declares the writer. Requested: `projects.linkWorkItems(assignmentId, workItemIds[])`
and `unlinkWorkItems(assignmentId)` on the projects service, called by orchestrator at assignment
create and close.
**Resolved — see projects §1.5**, which names orchestrator's assignment-creation path (both the
pattern engine and the solo endpoint) as the sole writer and exposes both calls, idempotent and
project-validating, on its §5 service surface. Orchestrator's side is wired in §2.3.

**R5 — foundation §3.3 and the edition files: the notification channel.** Requested: (a) the secret
key namespace gains `notify.<channel>.<field>` (v1 uses `notify.ntfy.topicUrl`, which is a
capability URL and therefore a secret); (b) `edition.work.json` sets
`orchestrator.notify.enabled: false`, since outbound push from a work machine is a policy decision
rather than a preference. If foundation would rather own a general `Notifier`, orchestrator will
consume it instead — the trigger logic stays here either way.
**Resolved — see foundation §3.3** (the key namespace gains `notify.<channel>.<field>`, with
`notify.ntfy.topicUrl` named as a capability URL) **and foundation §2.3** (`edition.work.json` sets
`orchestrator.notify.enabled: false`). Foundation declined to own a `Notifier`; the trigger and the
channel stay here as §10 describes.

**R6 — runner §15.1-7: who resumes what.** Runner's contract says orchestrator must not separately
relaunch a session runner parked. Confirmed and honoured: orchestrator never pauses or resumes a
session for a question of its own (§4.4). The clarification requested is the converse — that
orchestrator **may** call `RunnerService.stop()` on sessions of an assignment it is closing or a
session that tripped `tool_flood`, and that runner's auto-resume applies **only** to sessions runner
itself parked with `exit_reason: awaiting_answer`. Stated so the boundary is written down rather than
inferred.
**Resolved — see runner §15.1-7**, which now states the boundary in full in exactly those terms:
orchestrator **may** call `RunnerService.stop()` on any session, and auto-resume is runner's alone and
applies only to sessions runner parked with `exit_reason: awaiting_answer`.

**R7 — foundation §1.4: `assignments.status` vocabulary.** Foundation ships the column without a
vocabulary. Orchestrator pins it to `open | closed` (§2.2), with the richer state machine in an
orchestrator-owned `phase` column. Recorded here so foundation's table description can name it.
**Resolved — see foundation §1.4**, whose `assignments` row now states that the `status` vocabulary is
exactly `open | closed` and that the richer lifecycle lives in orchestrator's own `phase` column.

---

## 18. Deliberately deferred past v1

| Deferred | Why / what unblocks it |
|---|---|
| **Overseer + workers** and **review loop** patterns (§3.4) | Both need parallel drivers, budget rollup across a tree, and the write gate actually exercised. The pair proves the machinery first. |
| Parallel turns within one pattern | The engine's per-assignment mutex and the `assignment_turns_active` index assume sequential seats. Parallelism also collides with runner's cap of 2. |
| Declared per-seat model overrides | Needs R2 plus roster honouring an assignment-level model. v1 achieves the same outcome by *who fills the seat*, which is a human decision and cannot be a silent downgrade. |
| Pushing mail into a live session via `steer` | Breaks round accounting and budget attribution (§5.1). Solve the accounting first. |
| Agent-authored work items | Projects §6 already defers agent-created items; the overseer decomposes into child assignments instead. |
| Semantic question de-duplication | v1 joins on exact normalised text (§6.3). A similarity threshold that merges two different questions produces one wrong answer delivered twice. |
| Cross-project assignments | Rule 2 of §9. A single assignment spanning repos has no coherent workspace lease. |
| Pattern definitions as user-editable config/templates | Prompt templates and seat definitions live in code in v1; a template language is a product in itself. |
| Email / webhook / Web Push notification channels (§10) | One channel that works beats three that half-work. Web Push is the right successor once `tailscale serve` provides TLS. |
| Automatic merge/PR of a converged artifact | Projects §6 defers merge-back; AgentManager never merges in v1. |
| Structured SDK output (`outputFormat: json_schema`) for turn results | Runner §16 offers it as orchestrator's call. `report_status` already gives structured results through a channel we control and can enforce; revisit if unreported turns turn out to be common. |
| A "team recommendation" synthesis across agents | The card shows who said what and how hard. Averaging stances would invent a consensus that nobody stated. |
