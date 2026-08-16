# Runner — Design

Agent session execution: the element that turns *an agent, a project, and a prompt* into a live
Claude Agent SDK session, keeps it observable and steerable while it runs, meters what it spends,
and leaves an honest record when it stops.

Conforms to [architecture.md](../architecture.md) D1–D6. Consumes foundation's storage, config,
secrets, logging, module, and lifecycle decisions; consumes roster's compiled session options and
projects' launch context and workspace leases. It invents none of those and recomputes none of them.

Wave-1 contracts named in [README.md](README.md) — `sessions.assignment_id NOT NULL`, the status
vocabulary, `summary`, `transcript_path`, `transcript_bytes`, `usage_events`/`session_usage` — are
treated as settled inputs throughout and are not re-litigated.

---

## 0. SDK surface note

> **M0 completed against pinned SDK 0.3.233 — [SDK-NOTES.md](SDK-NOTES.md) is now the authority
> wherever it and this document disagree.** Three contradictions were found (SDK-NOTES
> "Design contradictions"): **C1** — `modelUsage`/`total_cost_usd` are cumulative per `query()`
> call and reset on resume, so §7.1's delta-vs-session-row reconciliation goes negative across
> §9.4 pause/resume; meter per *run* (run id on `usage_events`, non-negative delta assertion) and
> read per-turn figures from `result.usage`. **C2** — a bare `allowedTools` entry auto-approves
> the whole tool before `canUseTool` is consulted, `AskUserQuestion` included, contradicting §5.1;
> `AskUserQuestion` must live in the `ask` bucket (roster compiler change), and §5.6's launch
> diagnostic gains `questionBridge: 'degraded'`. **C3** — plan-window utilization, reset
> timestamps, and subscription tier *are* programmatically exposed (experimental `Query.usage_…()`
> API, `rate_limit_event`); §7.4/D7/D3's "not available" premises are false though D7's
> conclusions survive on stability grounds. Sixteen live-verification items (L1–L16) are encoded
> as token-gated tests in `src/modules/runner/__spike__/sdk.spike.test.ts` and must pass before
> their listed milestones are considered done.

Everything below is pinned to the TypeScript Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
and the `claude` CLI it bundles. The facts marked **[V]** were verified against current SDK
documentation while writing this design; the ones marked **[A]** are assumptions the
implementation must confirm in M0 before any code depends on them. The SDK moves fast and the
bundled CLI version is pinned by the SDK package version, so:

- `package.json` pins an **exact** SDK version, not a range.
- All SDK type usage is checked in CI against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`,
  not against documentation.
- All SDK option *shapes* are produced by roster's option compiler (roster §13). Runner touches only
  the small, explicitly listed set of fields in §3.3.

**Verified facts this design leans on [V]:**

| Fact | Where it matters |
|---|---|
| `query({prompt, options})` accepts a string **or** an `AsyncIterable<SDKUserMessage>`. Interruption, mid-session message queueing, `setPermissionMode`, and image attachments are **streaming-input mode only**. | §4 |
| `Query` exposes `interrupt()`, `close()`, `streamInput()`, `setModel()`, `mcpServerStatus()`, `supportedModels()`, `accountInfo()`, `getContextUsage()`, and is itself an `AsyncGenerator<SDKMessage>`. | §4, §6 |
| Permission evaluation order is hooks → deny rules → **ask rules (fall through to `canUseTool`)** → permission mode → allow rules → `canUseTool`. `canUseTool` may stay pending **indefinitely**; execution is paused until it returns. | §5 |
| In `permissionMode: 'dontAsk'`, `canUseTool` is **skipped and the call denied**. (This confirms the reading roster §6.2 flagged as load-bearing: `dontAsk` means *never prompt, auto-reject*. Roster's mode ladder is correct as written.) | §5.6 |
| `AskUserQuestion` is a real built-in tool. It **always** reaches `canUseTool`, even with a matching allow rule. The answer is delivered by returning `{behavior:'allow', updatedInput:{questions, answers:{"<question>":"<label>"}}}`. It is unavailable inside subagents. | §5 |
| `canUseTool` is `(toolName, input, {signal, suggestions}) => Promise<PermissionResult \| null>`; `PermissionResult` is `{behavior:'allow', updatedInput?, …}` or `{behavior:'deny', message, interrupt?, …}`. An `allow` result should always echo `updatedInput` (older CLI builds reject one that omits it). | §5 |
| A `PreToolUse` hook may return `permissionDecision: "defer"`, which **ends the query with the tool call still pending** so it can be resumed later. | §5.4 |
| **In streaming-input mode each *turn* emits its own `result` message.** `result` is not "the session ended". Trailing system events can arrive after a `result`, so the reader must iterate to generator completion. | §2.4, §4.2 |
| `result` subtypes: `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`, `error_max_structured_output_retries`. Every one carries `session_id`, `usage`, `modelUsage`, `total_cost_usd`, `num_turns`, `stop_reason`, `permission_denials`. | §2.2, §7 |
| Per-turn usage is on `assistant` messages at `message.message.usage`, **but** parallel tool calls emit several assistant messages sharing one `message.id` with identical usage (dedupe by id) and per-step `output_tokens` is a placeholder. `result.modelUsage` is the accurate per-model total and includes subagents; `result.usage` covers the main loop only. | §7.1 |
| `total_cost_usd` is a **client-side estimate from a price table bundled at build time**, explicitly not billing data. | §7.3 |
| SDK session state is JSONL at `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl`, written by the CLI subprocess. `resume: <sessionId>` replays it. Lookup is keyed by working directory. | §9 |
| Each `query()` spawns its own `claude` CLI subprocess. Practical budgeting is ~1 GiB RAM per concurrent agent; memory grows with session length. There is **no** top-level session timeout in the SDK. | §6 |
| `maxTurns`, `maxBudgetUsd`, `abortController`, `stderr`, `env` (which **replaces** the child environment), `cwd`, `additionalDirectories`, `settingSources`, `plugins`, `skills`, `mcpServers`, `hooks`, `includePartialMessages` are all real `Options` fields. | §3.3 |
| An undocumented `rate_limit_event` stream message exists carrying rate-limit status/utilization. It is absent from the docs and its shape is not stable. | §7.4 |

**Assumptions to confirm in M0 [A]:** whether a plain `resume` preserves the SDK session id or mints
a new one; the exact message sequence after `interrupt()`; whether `canUseTool` and `hooks` can be
combined on the same session without either shadowing the other; whether `accountInfo()` exposes any
plan-window information; the semantics of `resumeSessionAt` / `resumeDropsTurn`; and whether a
session killed mid-tool-call resumes cleanly (§9.4).

---

## 1. Scope and boundaries

| Runner owns | Runner does not own |
|---|---|
| The `sessions` table, its lifecycle, and its statuses | Agent definitions, personas, permission composition (roster) |
| `usage_events`, `session_usage`, and the transcript files | Assignments, mailboxes, patterns, budget *policy* (orchestrator) |
| The concurrency cap, the queue, and rate-limit cool-down | Project paths, per-project defaults, workspace *allocation* (projects) |
| Calling the SDK: `query()`, streaming input, `interrupt()`, `resume` | SQL against another element's tables, config/secret/log mechanisms (foundation) |
| The `canUseTool` adapter and the question/answer bridge plumbing | Question *card content*, recommendation aggregation, approval-gate policy (orchestrator) |
| Structured session events on the bus, and the session API | Transcript retention policy (projects §3.3) |
| Injecting the auth environment (§3.4) | Deciding *who* works on *what* (orchestrator) |

The one-line rule: **runner decides *when* and *whether* a compiled session runs, never *what it is
allowed to do*.**

---

## 2. Session lifecycle

### 2.1 What a session is

A session is **one unit of agent work**: an agent, under an assignment, in a leased workspace, given
one initial prompt, running until it produces its first turn `result`. It is *not* a chat window that
lives forever. That choice is forced by three verified facts — each `query()` holds a subprocess with
roughly a gigabyte of RSS, memory grows with session length, and there is no SDK-level session
timeout — and it is what makes the concurrency cap mean something.

Continuing a conversation after a session ends is therefore a **new session with
`resume: <sdk_session_id>`** and `sessions.resumed_from` set, not a revived old one. The assignment
groups them, so the UI still renders one thread. Steering *while the agent is working* — the case
that actually matters — is fully supported and needs no new session (§4.3).

### 2.2 States and transitions

The vocabulary is foundation §1.4's, verbatim and closed: `queued | running | paused | done | failed
| interrupted | orphaned`.

| From | To | Trigger | Who | Notes |
|---|---|---|---|---|
| — | `queued` | `startSession()` accepted; row + `session_inputs` written | UI / remote / orchestrator via runner API | Refused before this point (no row) if the queue is full, the assignment is closed, the project is `provisioning`/`archived`, or the agent is unknown |
| `queued` | `running` | Scheduler admits, launch chain succeeds, SDK `system/init` received | runner scheduler | `sdk_session_id`, `model`, `permission_mode`, `transcript_path` written here |
| `queued` | `queued` | Workspace refusal that projects marks retryable | runner | `blocked_reason` set; retried on `workspace.released`; capped by `runner.workspaceWaitMinutes` |
| `queued` | `failed` | Launch chain error: unresolved `secretRef`, compile diagnostic marked fatal, terminal workspace refusal, no `init` within `runner.startTimeoutMs`, subprocess spawn failure | runner | `exit_reason` names the stage |
| `queued` | `interrupted` | User cancels a queued session; or boot finds it older than `runner.queueStaleHours` | user / runner boot | `exit_reason: user_cancelled` \| `stale_queue` |
| `running` | `done` | Turn `result` with subtype `success`, input stream closed, generator completed | runner | `exit_reason: completed` |
| `running` | `failed` | `result` subtype `error_max_turns`, `error_max_budget_usd`, `error_during_execution`, `error_max_structured_output_retries`; or an uncaught stream error; or `runner.idleTimeoutMs` / `runner.wallClockMaxMinutes` exceeded | runner | `exit_reason` mirrors the subtype |
| `running` | `interrupted` | User presses Stop | user (local or remote) | `interrupt()` → drain → `close()`; `exit_reason: user_stopped` |
| `running` | `paused` | User presses Pause; question hold expires (§5.4); assignment token budget crossed (§7.2); graceful shutdown (foundation §4.2) | user / runner | Always resumable; the concurrency slot is released, the workspace lease is **kept** |
| `running` | `orphaned` | Discovered on boot: status was `running` with no live process | runner boot task | Never set by a live process. `exit_reason: core_restart` |
| `paused` | `queued` | Resume requested, or a parked question is answered (§5.4) | user / runner | Same row, same transcript, `resume: <sdk_session_id>` |
| `paused` | `interrupted` | User discards a paused session; question expired past `runner.question.expireHours` | user / runner | `exit_reason: user_stopped` \| `question_expired` |
| `paused` | `orphaned` | — | — | **Never.** A paused session is a deliberate state and survives restarts unchanged |
| `orphaned` | — | — | — | **Terminal.** "Resume" from here creates a *new* session (§9.3) |
| `done` / `failed` / `interrupted` | — | — | — | Terminal |

Three of these deserve their reasons stated plainly.

- **`paused` is stop-with-intent-to-continue.** The SDK has no suspend. The honest implementation of
  pause is `interrupt()` + `close()` + remember `sdk_session_id`, and the honest implementation of
  resume is a fresh `query()` with `resume`. Calling that "paused" rather than "interrupted" is not
  cosmetic: it is what tells the UI a Resume button belongs there, what tells projects' timeline the
  assignment is still `running`, and what tells the scheduler the slot is genuinely free.
- **`interrupted` is stop-without-intent.** Stop button, discarded pause, cancelled queue entry,
  expired question. Projects maps it to assignment outcome `stopped`, which is correct for all four.
- **`orphaned` is only ever assigned by the boot task**, and is terminal so that projects' derived
  `failed` outcome stays truthful. A session that really did die mid-flight should not be able to
  quietly become a success later.

### 2.3 `exit_reason` vocabulary

Closed set, written on every terminal or paused transition, and carried in `session.ended` /
`session.paused` events:

`completed` · `user_stopped` · `user_cancelled` · `max_turns` · `max_budget_usd` ·
`error_during_execution` · `error_structured_output` · `launch_failed` · `secret_unresolved` ·
`workspace_unavailable` · `start_timeout` · `idle_timeout` · `wall_clock_timeout` ·
`question_expired` · `awaiting_answer` · `budget_halt` · `service_shutdown` · `shutdown_forced` ·
`stale_queue` · `core_restart` · `transcript_cap`

### 2.4 One `result` per turn, not per session

Because streaming-input mode emits a `result` per turn [V], the reader loop must not treat the first
`result` as "the generator is finished". The loop is:

1. Consume messages until a `result` arrives. Record turn-level usage and `permission_denials`.
2. If the input queue holds an unsent steer message, keep going (the next turn starts).
3. Otherwise close the input queue.
4. **Keep iterating** until the generator completes — trailing system events arrive after `result` [V].
5. Then settle the terminal status.

---

## 3. The launch chain

### 3.1 Steps, in order

```
POST /api/sessions | RunnerService.startSession()
  │
  ├─ 0. admission checks ────────── assignment open? agent known & not archived?
  │                                 project active? queue below runner.queueLimit?
  ├─ 1. persist ────────────────── sessions row (queued) + session_inputs (prompt)
  │                                 emit session.queued
  ├─ 2. scheduler waits ────────── until weighted capacity is free and no rate-limit cool-down
  │
  ├─ 3. assignment context ─────── orchestrator.getAssignmentContext(assignmentId)
  │                                 → { role, write, scopeRules, tokenBudget, tokensUsed, status }
  ├─ 4. workspace lease ────────── projects.acquireWorkspace(projectId, assignmentId,
  │                                    { write, scopePaths })          ← once per assignment
  ├─ 5. launch context ─────────── projects.getEffectiveLaunchContext(projectId, assignmentId)
  │                                 → { cwd, env, permissionOverride, elevation,
  │                                     instructions, workspace }      ← raw inputs, uncomposed
  ├─ 6. compile ────────────────── roster.compileSession({ agent, project, assignment, secrets })
  │                                 → { options, effective, diagnostics }
  ├─ 7. runner's own fields ────── §3.3 whitelist only
  ├─ 8. transcript open ────────── create the file, write the session.start header line,
  │                                 set sessions.transcript_path
  ├─ 9. query() ────────────────── streaming input; await system/init
  └─ 10. running ───────────────── record sdk_session_id / model / permission_mode,
                                    emit session.started
```

Steps 3–6 are pure delegation. Runner supplies ids and consumes results; it does not read another
element's tables, does not re-derive `cwd`, does not compose permissions, does not resolve a
`secretRef`, and does not merge environment variables (all of which roster's compiler does once, in
one place, per roster §13).

**Lease refcounting.** The lease belongs to the *assignment*, not the session. Runner holds
`Map<assignmentId, { leaseId, sessionRefs }>`, acquires on the first session admitted for that
assignment, and releases on `assignment.closed` from orchestrator — with a safety net that releases
when the last session of an assignment reaches a terminal status **and** the assignment row is no
longer `open`. Paused sessions keep the lease held, which is the whole point of pausing rather than
stopping.

### 3.2 Failure handling in the chain

Every step has a typed failure that becomes an `exit_reason` and a human-readable message on the
session row, never a stack trace to the UI:

| Step | Failure | Result |
|---|---|---|
| 3 | assignment closed or missing | refused before the row exists |
| 4 | retryable refusal (another write assignment holds the tree) | stays `queued`, `blocked_reason` set, retried on `workspace.released`, `failed` after `runner.workspaceWaitMinutes` |
| 4 | terminal refusal (UNC path, mid-rebase, setup command failed) | `failed` / `workspace_unavailable`, carrying projects' reason string verbatim |
| 6 | unresolved `secretRef` | `failed` / `secret_unresolved`, message names the ref and the agent (roster §10) |
| 6 | fatal diagnostic (unknown skill name, plugin path missing) | `failed` / `launch_failed`; non-fatal diagnostics are attached to `session.started` and the transcript header |
| 9 | subprocess spawn failure, or no `init` within `runner.startTimeoutMs` | `failed` / `start_timeout`, with the captured `stderr` tail |

A `failed` launch releases the concurrency slot immediately and, if it was the only session on the
lease, releases the lease.

### 3.3 Ownership boundary: which SDK options runner may touch

Runner receives `options` from `compileSession` and treats them as **immutable except for this
whitelist**:

| Field | Why runner owns it |
|---|---|
| `env.CLAUDE_CODE_OAUTH_TOKEN` (or nothing, per `auth.mode`) | Auth is explicitly not roster's (roster §14, D2). See §3.4. |
| `canUseTool` | The question bridge lives here. See §5.1 for why this is not a permission decision. |
| `abortController` | Runner owns cancellation, timeouts, and shutdown. |
| `includePartialMessages` | Live-typing in the UI; a presentation choice, not a session semantic. |
| `resume` / `sessionId` | Pause/resume and crash recovery (§9). |
| `stderr` | Captured into `core.log` (redacted) for diagnosis; never into the transcript. |

Everything else — `systemPrompt`, `allowedTools`, `disallowedTools`, `permissionMode`, `settings`,
`mcpServers`, `plugins`, `skills`, `settingSources`, `model`, `fallbackModel`, `effort`, `maxTurns`,
`maxBudgetUsd`, `cwd`, `additionalDirectories`, and the rest of `env` — is passed through untouched.

This is enforced, not merely stated: in tests and in development builds, runner snapshots the
compiled options object before and after its own mutations and asserts that only whitelisted key
paths differ. A permission bug introduced by the runner would be invisible in review and obvious in
that assertion.

### 3.4 Auth

Foundation §3.3 names runner as the consumer of the `claude.oauthToken` secret; roster §14 states
that auth is untouched by roster. Runner therefore performs the injection, in exactly one function
(`attachAuthEnv(options)`), immediately after `compileSession` returns:

| `auth.mode` | Behaviour |
|---|---|
| `subscription` (home default) | Resolve `claude.oauthToken` via `SecretResolver`, set `options.env.CLAUDE_CODE_OAUTH_TOKEN`. If the secret is missing, the session fails with `secret_unresolved` and a message pointing at `Setup-Auth.ps1`. |
| `env` (work default) | Set nothing. The workplace's `ANTHROPIC_API_KEY` / Bedrock variables arrive through the base process environment that roster spreads. |
| `bedrock` | Set nothing; the relevant `CLAUDE_CODE_USE_BEDROCK` / AWS variables come from the process environment. |

Two guards, both cheap and both worth having:

- **`ANTHROPIC_API_KEY` strip.** When `auth.mode === 'subscription'` and the compiled `env` contains
  `ANTHROPIC_API_KEY` (it can only get there via the base-process-env spread, since projects rejects
  it as a project env name), runner deletes it from the child environment and logs a `WARN` naming
  the session. Foundation's boot warning tells the user; this makes sure the session still runs on
  the subscription. D2 calls the silent override out specifically; this is the enforcement.
- **An authorized reveal site.** Raised rather than assumed (§15.4 #19) and now settled: foundation
  §3.2's list is exactly two entries — roster's option compiler and this function. It is one key, one
  function, and no other runner code path holds a `Secret`.

### 3.5 Runner's schema additions

Shipped as `migrations/runner/0001_runner.sql` under foundation §1.3's element-migration mechanism.
`sessions`, `usage_events`, and `session_usage` are foundation-shipped tables that runner owns, so
columns are added here rather than in foundation's core set.

```sql
ALTER TABLE sessions ADD COLUMN role           TEXT;    -- assignment_members.role, for roster's addendum
ALTER TABLE sessions ADD COLUMN lease_id       TEXT;    -- workspace_leases.id held for this assignment
ALTER TABLE sessions ADD COLUMN resumed_from   TEXT;    -- prior session id, for the §9.3 chain
ALTER TABLE sessions ADD COLUMN queued_at      TEXT;
ALTER TABLE sessions ADD COLUMN priority       TEXT NOT NULL DEFAULT 'normal';  -- interactive | normal
ALTER TABLE sessions ADD COLUMN weight         INTEGER NOT NULL DEFAULT 1;      -- roster concurrencyWeight
ALTER TABLE sessions ADD COLUMN blocked_reason TEXT;
ALTER TABLE sessions ADD COLUMN turns          INTEGER NOT NULL DEFAULT 0;

CREATE INDEX sessions_scheduler ON sessions (status, priority, queued_at);

CREATE TABLE session_inputs (          -- the durable launch request; survives a restart while queued
  session_id       TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  prompt           TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL
);

ALTER TABLE usage_events ADD COLUMN source     TEXT NOT NULL DEFAULT 'turn';   -- turn | reconcile
ALTER TABLE usage_events ADD COLUMN message_id TEXT;                            -- SDK assistant message id
CREATE UNIQUE INDEX usage_events_dedupe
  ON usage_events (session_id, message_id) WHERE message_id IS NOT NULL;
```

`session_usage`'s columns were left to runner by foundation §1.4 ("rolled-up totals per session"):

```sql
-- specified by runner; shipped in foundation's 0001_init.sql
session_usage(session_id PK, input_tokens, output_tokens, cache_read_tokens,
              cache_creation_tokens, turns, cost_usd /* nullable, estimate only */, updated_at)
```

---

## 4. SDK execution mode

### 4.1 Decision: streaming input, always, for every session

Every session is launched as `query({ prompt: <AsyncIterable<SDKUserMessage>>, options })`. One-shot
string prompts are not used anywhere in the runner.

The reason is not preference; three of runner's four stated responsibilities are documented as
streaming-input-only capabilities [V]:

| Requirement (README) | Needs |
|---|---|
| "interrupt/steer" | `Query.interrupt()` — **streaming-input mode only** |
| "deliver the user's answer back into the live session" via a steered message | dynamic message queueing — **streaming-input mode only** |
| pause/resume at a controlled point | `interrupt()` again |
| a session that survives a bad turn instead of throwing | a single-shot `query()` yields the error result and then **throws**; a streaming session stays alive |

`canUseTool` itself works in both modes in TypeScript [V], so the *permission-gate* half of the
question bridge would survive a one-shot design. Everything else would not, and running two modes
means two reader loops, two error paths, and two places for a steer to be silently dropped. One mode.

The cost of the decision is one small class (§4.2) and nothing else.

### 4.2 The input queue

Each live session owns an `InputQueue`: an async-iterable backed by a buffer plus a waiter.

```ts
class InputQueue implements AsyncIterable<SDKUserMessage> {
  push(text: string, opts?: { attachments?: ImageAttachment[] }): void;
  close(): void;                       // ends the iterable → the SDK loop winds down
  get pending(): number;
}
```

- The initial prompt is pushed before `query()` is called, so the first turn starts immediately.
- **It never throws.** A throwing async generator ends the SDK stream with the misleading message
  "Claude Code process aborted by user", masking the real error [V]. Every internal error is caught,
  logged, and turned into `close()`.
- Attachments compile to the SDK's base64 image content blocks, which is the other capability
  streaming mode buys. v1's API accepts them; the UI may ship the control later.
- `Query.streamInput()` is the documented alternative for pushing turns into a running session [V].
  The queue is preferred because it keeps one object owning the whole input lifetime; `streamInput`
  is the fallback if M0 finds the iterable is consumed eagerly.

### 4.3 Steering

`POST /api/sessions/:id/steer { text, interrupt?: boolean }`:

- `interrupt: false` (default) — push onto the queue. The message is delivered at the next turn
  boundary. Use for "also check X while you're in there".
- `interrupt: true` — call `Query.interrupt()`, wait for the turn to wind down (bounded by
  `runner.gracefulInterruptMs`), then push. Use for "stop that, do this instead". This is the control
  the UI's session view labels *Steer*.

Both are recorded in the transcript as a `steer` line and emitted as `session.steered`. Steering a
session that is not `running` is a typed 409, not a silent no-op.

`Query.setPermissionMode()` exists and is streaming-only, and runner **does not call it**: the
permission mode is roster's composition and changing it at runtime would be exactly the recomputation
§1 forbids.

---

## 5. The question/answer bridge

This is the feature the README says the orchestrator's question cards and the UI's inbox are built
on, and the one where "the answer arrives after the agent gave up" is the failure to engineer
against.

### 5.1 Where a question comes from

Three sources, one path out:

| Source | How it reaches runner | `questions.kind` |
|---|---|---|
| The agent calls **`AskUserQuestion`** | `canUseTool` fires with `toolName === 'AskUserQuestion'`, always, even under a matching allow rule [V]. Input is `{questions:[{question, header, options:[{label, description}], multiSelect}]}` | `question` |
| A tool call the static rules did not decide — an `ask` rule from roster's compiled `settings.permissions`, a not-auto-approved tool, or an MCP tool flagged `requiresUserInteraction` | `canUseTool` fires with the real tool name and input | `question` |
| The assignment's token budget is crossed (§7.2) | Runner raises it directly; no tool call is pending | `budget_halt` |

`approval_gate` is orchestrator's kind and runner does not mint it; the bridge carries it if
orchestrator raises one against a live session.

**Why `canUseTool` is runner's and not roster's.** Roster §6.2 describes a compiled `canUseTool` that
default-denies anything outside the effective allow set, and roster §6.3 says `ask` rules land there
for the runner to route. Both are satisfied by runner owning the callback, because of the verified
evaluation order: **anything that reaches `canUseTool` has already survived the deny rules and has
already failed to be auto-approved by mode or allow rules.** The callback is therefore not a place
where permissions are computed — it is the place where an *undecided* call is escalated to the human,
with roster's default-deny as the terminal fallback when no human is reachable. Runner matches no
rule patterns and consults no rule set; roster remains the only composer. This is recorded as a
clarification to roster in §15.4, not a change to permission composition.

**"Always allow" is deliberately not offered.** The SDK's `updatedPermissions` on an allow result
would widen the session's permissions at runtime, which is precisely the composition roster owns. The
card offers *Allow once* and *Deny*, and a persistent widening is a roster or project edit.

### 5.2 Raising and persisting

Runner calls the orchestrator's bridge and awaits it:

```ts
// provided by orchestrator on the service registry; consumed by runner
interface QuestionBridge {
  ask(req: {
    sessionId: string; assignmentId: string; agentId: string;
    kind: 'question' | 'approval_gate' | 'budget_halt';
    prompt: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    multiSelect?: boolean;
    allowFreeText?: boolean;
    context?: { toolName?: string; toolInput?: unknown };
    holdUntil: string;                     // ISO deadline for the inline hold
    expiresAt: string;                     // ISO deadline for the question itself
  }): Promise<QuestionOutcome>;
  cancel(questionId: string, reason: string): Promise<void>;
}

type QuestionOutcome =
  | { status: 'answered'; questionId: string;
      answer: { optionIds?: string[]; labels?: string[]; text?: string };
      answeredVia: 'local' | 'remote'; answeredAt: string }
  | { status: 'expired'   ; questionId: string }
  | { status: 'cancelled' ; questionId: string; reason: string };
```

Orchestrator persists the row in `questions` (foundation §1.4), attaches
`question_recommendations`, aggregates multiple agents' asks into one card, and resolves the promise
when the row is answered — from the desktop or from the tailnet browser, with `answered_via`
recorded. That persistence is what makes an open question survive a core restart.

When the orchestrator module is absent, runner falls back to writing the `questions` row through
foundation's questions repository (the sanctioned cross-element path, foundation §1.3) and resolving
on the `question.answered` bus event. The card is then unaggregated and carries no recommendations —
a degradation, not a failure.

### 5.3 Delivering the answer into a *still-running* session

This is the part that matters, and it works because `canUseTool` may stay pending indefinitely while
the SDK holds execution paused [V].

| Question source | Delivery |
|---|---|
| `AskUserQuestion` | Resolve with `{behavior:'allow', updatedInput:{ questions: input.questions, answers: { "<question text>": "<chosen label>" } }}`. Free text goes in the same `answers` slot; multi-select passes an array of labels. **`questions` must be echoed back**, and `updatedInput` must always be present on an allow [V]. |
| Tool-use gate | Resolve with `{behavior:'allow', updatedInput: input}` (input echoed unchanged) or `{behavior:'deny', message: <the user's reason, or "Denied by the user.">}`. |
| Budget halt | No tool call is pending; the answer resumes or stops the session (§7.2). |

In every inline case the agent never left the tool call. There is no "the agent moved on" window at
all — the model's next token after the answer is the tool result. That property is the reason the
bridge is built on `canUseTool` rather than on injecting a user message.

### 5.4 Timeout, parking, and "the agent gave up"

Blocking forever is not free: the session holds a subprocess, roughly a gigabyte, and a concurrency
slot while a human is asleep. The bridge is therefore **two-stage**.

**Stage 1 — hold** (`runner.question.holdMs`, default **15 minutes**). `canUseTool` stays pending.
The session stays `running` and keeps its slot. An answer inside this window lands inline, per §5.3,
with zero loss. Fifteen minutes covers "the user is at the desk or has their phone".

**Stage 2 — park.** On hold expiry, runner resolves the pending call with

```ts
{ behavior: 'deny', interrupt: true,
  message: 'Paused: this needs a decision from the user (question <id>). ' +
           'Stop here and do not work around it; the session will be resumed with the answer.' }
```

then closes the query and sets the session `paused` with `exit_reason: awaiting_answer`. The
concurrency slot is released, the workspace lease is kept, and **the question stays open**.

The `deny` message is written the way it is on purpose. Left to itself, a denied agent invents a
workaround — that *is* the "gave up and moved on" failure. Telling it explicitly to stop, combined
with `interrupt: true`, ends the turn instead.

**Stage 3 — auto-resume.** When the answer eventually arrives (minutes or hours later), runner
re-queues the parked session at `interactive` priority and resumes it with `resume:
<sdk_session_id>`, injecting one user message as the first turn:

> You asked: *«question prompt»*. The user answered: *«answer»*. Continue from where you stopped.

The agent regains the full conversation, knows the answer, and re-issues the tool call itself. The
honest cost of stage 2 versus stage 1 is **one re-decided tool call and one extra turn**, not lost
work — and it is bounded, visible in the transcript, and reported in `session.resumed`.

**Expiry — two halves, one owner each.** The `questions.status → expired` transition is
**orchestrator's**: its sweep runs against `runner.question.expireHours` (default **24**, runner's
config, read not copied — orchestrator §12), flips the row, applies its own per-kind consequences
(orchestrator §6.5), and emits **`question.expired`**. Runner owns only the session half: it
**reacts** to that event by moving the parked session to `interrupted` with
`exit_reason: question_expired`, and never expires a row itself. `interrupted` rather than `failed`
because nothing errored — the system deliberately stopped waiting — and the expired card stays in the
inbox as the record. Boot picks up whatever was missed while the core was down (§9.2 item 3), from the
row rather than a replayed event.

**A deferred improvement, named because it is the right long-term answer.** A `PreToolUse` hook can
return `permissionDecision: "defer"`, which ends the query **with the tool call still pending** so it
resumes without re-deciding [V]. That is strictly better than deny-and-re-ask, but it must be decided
*before* the hold rather than after it, so v1 uses the hold-then-deny path and M0 records whether
`hooks` and `canUseTool` coexist cleanly on one session. Adopting `defer` later changes §5.4 only.

### 5.5 Questions the agent asks in prose

An agent that simply writes "should I use Postgres or SQLite?" and stops has produced a normal
`result`; the session is `done` before anyone can answer. Runner does not try to detect this with
heuristics. The UI's answer is the ordinary **Continue** action on a finished session (§2.1): a new
session with `resume`, whose first message is the user's reply. Stated plainly because the alternative
— sniffing assistant text for question marks — would be wrong often enough to be worse than nothing.

### 5.6 `dontAsk` sessions cannot ask

Verified: in `permissionMode: 'dontAsk'`, `canUseTool` is skipped and the call denied, and
`AskUserQuestion` is denied without reaching the callback [V]. So a session whose compiled mode is
`dontAsk` **has no question bridge at all**. Runner detects this at launch and:

- emits a non-fatal `session.diagnostic` and writes it to the transcript header,
- shows it on the session header via `session.started` (`questionBridge: 'disabled'`),
- and, for `budget_halt`, still works — that path is runner-raised and does not need the callback.

Runner does not silently change the mode to compensate. That would be recomputing permissions.

---

## 6. Concurrency cap and queue

### 6.1 The cap

`runner.maxConcurrent`, already pinned by foundation §2.3 at **2**, with a lower value in the work
edition (**1**). Two independent reasons, and it is worth recording both because they justify
different future changes:

- **Rate-limit windows are shared with the owner's own Claude usage** (D2). A background service that
  can saturate the 5-hour window is a service the owner turns off.
- **Each session is a `claude` CLI subprocess budgeted at roughly 1 GiB RSS** [V]. Two is ~2 GiB on a
  desktop that is also running Electron, a browser, and an IDE.

The cap is on the **sum of weights**, not the count. Weight comes from roster's
`defaults.concurrencyWeight` (roster §3, default 1) and is copied onto `sessions.weight` at enqueue,
so a heavy agent declared `concurrencyWeight: 2` occupies the whole cap at the default setting.

**Runtime override.** `PUT /api/runner/capacity { maxConcurrent }` writes to foundation's `settings`
table, not config (foundation §2.4: config is immutable per process; anything the UI toggles is
`settings`). The effective cap is `settings['runner.maxConcurrent'] ?? config.runner.maxConcurrent`,
clamped to 1..8. A remote client may lower it but not raise it (§15.3).

**Per-plan-tier auto-tuning is not implemented.** There is no documented programmatic source for the
subscription's plan tier or window sizes (§7.4), so a tier-derived cap would be a guess wearing a
number. It is one config key; the user sets it.

### 6.2 The queue

- **Capacity**: `runner.queueLimit` (foundation §2.3, default 50). A `startSession` past the limit is
  refused with a typed `queue_full` and **no session row** — a queued row that was never really
  accepted would pollute the timeline.
- **Order**: two priority bands, FIFO by `queued_at` within each.
  - `interactive` — a human is waiting: UI/remote-initiated launches, and auto-resumes of a session
    parked on a question (§5.4). The person who just answered should not sit behind a batch.
  - `normal` — everything else, including orchestrator-launched worker sessions.

  Two bands, no aging, no fair-share, no per-assignment quota. Three-plus bands invite tuning
  arguments that a cap of 2 cannot possibly reward.
- **Blocked entries.** A session waiting on a retryable workspace refusal stays `queued` with
  `blocked_reason` set and does **not** consume a slot; it is re-evaluated on `workspace.released`.
- **Admission** re-checks assignment status and project status, because both can change while queued.

### 6.3 Preemption: none

**No running session is ever stopped to make room for another.** Agent work is stateful and often
mid-tool-call; preempting risks a half-written file, a half-finished `git` operation, or a partially
applied edit — costs that are invisible until someone reads the diff. There are two deliberate
pressure valves instead, and both are explicit human or system acts rather than a scheduler decision:
a session blocked on a question **parks itself** and frees its slot (§5.4), and the user can **pause**
any session, which frees a slot deterministically and resumably.

### 6.4 Rate-limit cool-down

When a session dies in a way runner classifies as rate limiting (error text on an
`error_during_execution` result, or a `rate_limit_event` message reporting exhaustion — best-effort
either way, §7.4), the scheduler enters **cool-down**: no new admissions until the cool-down expires.
Running sessions are left alone; queued sessions stay queued.

Backoff is `runner.rateLimit.cooldownMs` (default 5 min), doubling on each consecutive hit up to
`runner.rateLimit.maxCooldownMs` (30 min), reset by any successful session start. If a reset time is
available from a `rate_limit_event`, it is used instead of the backoff. `runner.ratelimited` is
emitted with `{ until, source: 'error-text' | 'rate_limit_event', hint }` and shown in the UI's queue
panel — because a queue that has silently stopped moving is the worst possible failure mode for a
background service.

---

## 7. Usage metering and plan-window visibility

### 7.1 Per-session token metering

Exactly as foundation pins it: append-only deltas in `usage_events`, the rollup in `session_usage`,
both **in one transaction**, and no token totals duplicated onto the session row.

The verified SDK behaviour forces a two-source design, and getting this wrong is how token counts
drift:

**Live deltas (`source: 'turn'`).** One `usage_events` row per **distinct** `assistant` message id,
taken from `message.message.usage`. Parallel tool calls emit several assistant messages sharing one
id with identical usage [V], so the row is keyed by `(session_id, message_id)` with a unique index
(§3.5) and a duplicate is a no-op insert, not a doubled count. These rows drive the live counter in
the UI and the mid-session budget tripwire. They are explicitly **approximate**: per-step
`output_tokens` is a placeholder count taken at `message_start` [V].

**Authoritative reconciliation (`source: 'reconcile'`).** At every turn `result`, runner reads
`result.modelUsage` — the per-model totals, which include subagent spend, unlike `result.usage` [V] —
and writes one adjustment row per model carrying the difference between it and what has already been
recorded for this session. After each result the `session_usage` rollup is *exactly* `modelUsage`.
A non-trivial adjustment is logged at `debug`; a large one at `warn`, because that means the live
estimate is misleading the UI.

Runner uses `modelUsage` rather than `result.usage` even though roster denies our agents the subagent
tool — it is the strict superset, and depending on a permission decision for accounting correctness
is a coupling worth not having.

### 7.2 Assignment rollup and the budget halt

Foundation's decision table puts assignment totals on `assignments.tokens_used`. Runner increments
it **in the same transaction** as the `usage_events` insert and the `session_usage` upsert, through
foundation's assignments repository. Not via an event: a budget check that lags an event-bus hop is a
budget check that overruns.

**Definition pinned for orchestrator**: `assignments.tokens_used += input_tokens + output_tokens`.
Cache-read and cache-creation tokens are metered separately in `usage_events` for cost display and do
**not** count toward the budget.

When the increment crosses `assignments.token_budget` (non-null), runner immediately:

1. pauses the session — `paused`, `exit_reason: budget_halt` — releasing the slot and keeping the lease;
2. raises a `budget_halt` question through the bridge (§5.2) naming the assignment, the budget, the
   overshoot, and the sessions involved;
3. emits `assignment.budget.exceeded`.

Orchestrator owns what the card says and what the options are (raise the budget, close the
assignment, continue once). Runner owns only the immediate stop, because *detect-then-notify-then-act*
burns tokens during the notify. An answer that raises the budget resumes the parked session by the
ordinary §5.4 path.

The SDK's own `maxBudgetUsd` (roster's `defaults.maxBudgetUsd`) remains in force independently and
surfaces as `result` subtype `error_max_budget_usd` → `failed` / `max_budget_usd`. It is a per-session
dollar estimate; `token_budget` is a per-assignment token count. They are different guards and both
are wanted.

### 7.3 Cost is an estimate, and is labelled as one

`result.total_cost_usd` is a client-side computation from a price table bundled into the SDK at build
time and is explicitly not billing data [V]. Under subscription auth it corresponds to no dollar
charge at all. Runner stores it in `session_usage.cost_usd` (nullable) and pins one rule for the UI:
**it is rendered as "estimated model cost" and never as spend, and never in a currency total the user
could mistake for an invoice.** Tokens are the honest unit here; dollars are a scale hint.

### 7.4 Plan-window visibility: what can and cannot be known

The blunt answer: **AgentManager cannot know how much of the owner's 5-hour or weekly window is
left.** The windows are shared with the owner's interactive Claude Code and claude.ai usage (D2),
`/usage` is an interactive CLI command with no programmatic surface, and there is no documented
header, result subtype, or API for it [V].

So runner reports three things and labels each with its provenance:

| Signal | Source | Honesty label |
|---|---|---|
| **AgentManager's own consumption**, rolling 5-hour and 7-day sums over `usage_events` | our own database | `local-estimate` — "what this app used", explicitly *not* "what's left" |
| **Rate-limit status**, when the CLI volunteers it | the undocumented `rate_limit_event` stream message [V] | `cli-reported` — best-effort, may be absent, shape not guaranteed |
| **Rate-limit hits**, with the cool-down currently in effect | our own error classification | `observed` — the only *authoritative* signal, and it arrives only after the fact |

`rate_limit_event` is consumed defensively: the reader loop tolerates unknown message types by
construction, the event is parsed with a permissive schema, whatever is recognised is written to
`settings['runner.rateLimit.lastEvent']` (foundation §1.4 anticipates exactly this with "last-seen
plan-window reset"), and **no scheduling logic depends on its fields** — only on its presence plus
the observed-error path. If a future SDK removes it, runner loses a display, not a behaviour.

```jsonc
// GET /api/runner/usage
{
  "own":  { "window5h": { "since": "…", "inputTokens": 0, "outputTokens": 0, "sessions": 0 },
            "window7d": { … }, "source": "local-estimate" },
  "rateLimit": { "state": "ok" | "cooling", "lastHitAt": null, "resetsAt": null,
                 "cliReported": null, "source": "observed" },
  "disclaimer": "Counts AgentManager sessions only. Your interactive Claude usage shares the same plan windows and is not visible here."
}
```

Deliberately rejected: scraping `claude /usage`, parsing CLI stdout for limit banners, or calling an
undocumented endpoint. Each would be a silent breakage away from lying to the user about their
remaining quota, which is worse than the honest "we don't know".

---

## 8. Transcript writing

### 8.1 Layout and content

Foundation §1.5's layout, unchanged and unextended:
`state/transcripts/<YYYY>/<MM>/<session-id>.jsonl`, where `YYYY/MM` is the session's **start** month
in UTC. Nothing derives a path from a project slug or any other renameable thing.
`sessions.transcript_path` is written when the file is created, at admission — so
`transcript_path IS NOT NULL` genuinely means a file exists, which is the derivation projects relies
on.

One JSON object per line, `{ seq, ts, type, … }`, monotonic `seq` per session:

| `type` | Content |
|---|---|
| `session.start` | Header: agent, project, assignment, role, model, permission mode, effective permission set, elevation (with its reason), workspace kind/path/branch, compile diagnostics, `resumed_from`, SDK + CLI version |
| `system` | The SDK `init` message: session id, tools, MCP server statuses, plugins, skills |
| `user` | The initial prompt, steered messages, and injected answer messages |
| `assistant` | Assistant turns, full content blocks |
| `tool_use` / `tool_result` | Tool calls and their results |
| `question` / `answer` | Bridge activity: question id, kind, prompt, options, deadline; then the answer, `answered_via`, latency, and whether it was delivered inline or after a park |
| `steer` | A steer, with whether it interrupted |
| `usage` | Per-turn reconciled usage and `permission_denials` from the `result` |
| `error` | Stage, code, message, `stderr` tail |
| `session.end` | Status, exit reason, turns, duration, totals, summary |

**Partial messages are not written.** `stream_event` deltas exist for live typing in the UI and go to
the WebSocket only. Writing them would multiply transcript size for content that the `assistant`
line already contains in full, and projects' size cap would start pruning real history to make room
for keystrokes.

### 8.2 Mechanics

- One append stream per session. Buffered writes, `fsync` every `runner.transcript.flushLines`
  (default 50) lines or `runner.transcript.flushMs` (default 2000) ms, whichever comes first —
  foundation §1.5's policy with the line count made configurable.
- **`sessions.transcript_bytes` is updated once per flush**, not once per line, to the writer's exact
  byte count. Projects' per-project size cap is `SUM(transcript_bytes)`; an unmaintained column
  silently disables retention, so the writer treats a failed update as an error, not a warning.
- Every line passes through foundation's redaction scrubber before it is written (foundation §3.5) —
  agent output can echo an environment variable.
- A hard per-session cap, `runner.transcript.maxMb` (default 512). On reaching it, the writer appends
  one `error` line with `code: transcript_cap`, stops appending, and the session continues to run and
  meter. A single runaway session must not be able to fill the disk, and losing the tail of one
  transcript is a better outcome than losing the machine.
- On a graceful close, and again on boot for any file whose session did not close cleanly,
  `transcript_bytes` is reconciled from `fs.stat`, because the last flush may have lagged the crash.

### 8.3 `sessions.summary`

Runner maintains the one-line digest projects' timeline renders from, so no timeline read ever opens
a transcript. Composition is fixed so it stays predictable:

```
summary = `${truncate(firstUserPrompt, 100)} — ${outcome}` +
          (lastAssistantText ? `: ${truncate(lastAssistantText, 120)}` : '')
```

`outcome` is a plain word derived from the terminal status (`completed`, `stopped`, `failed`,
`paused`, `orphaned`). Written twice: at admission (prompt + `running`) so a live session already has
a readable row, and at the terminal transition. Truncation is on a grapheme boundary with an ellipsis;
maximum length is bounded at 240 characters.

---

## 9. Crash and restart recovery

### 9.1 Graceful shutdown

Foundation §4.2 says shutdown "asks the runner to interrupt in-flight sessions and persist resume
state". Runner's `stop()`:

1. Stop admitting. Queued sessions stay `queued` — a queue entry is pure intent and loses nothing.
2. For each running session, in parallel: `interrupt()`, wait up to `runner.gracefulInterruptMs`
   (default 10 s) for the turn to wind down, `close()`, flush and close the transcript with a
   `session.end` line, set `paused` / `service_shutdown`, emit `session.paused`.
3. Any session that does not wind down in time: abort its `AbortController`, set `interrupted` /
   `shutdown_forced`. Honest labelling — that one may have died mid-tool-call.
4. Workspace leases are **kept**. The assignments are not over; projects' own boot reconciliation is
   the safety net.

Total budget fits inside foundation's `service.shutdownGraceSeconds` (20 s) with the 10 s interrupt
window, which is why the interrupt window is 10 and not 30.

### 9.2 Boot reconciliation

Registered via `registerBootTask` (foundation §4.2), so it runs after storage is up and before any
listener binds. In order:

1. **`running` → `orphaned`**, `ended_at = now`, `exit_reason: core_restart`. Append a `session.end`
   line to each transcript, reconcile `transcript_bytes` from `fs.stat`, emit `session.orphaned` with
   `{ lastSeq, sdkSessionId, resumable }`.
2. **`queued` stays `queued`** and is re-admitted through the scheduler — unless `queued_at` is older
   than `runner.queueStaleHours` (default 24), in which case it becomes `interrupted` /
   `stale_queue`. A week-old queue stampeding on boot is its own incident.
3. **`paused` stays `paused`.** Nothing is auto-resumed on boot: the user may not be there, and a
   parked-on-question session already has a resume trigger (the answer). Parked sessions whose
   question has since expired are moved to `interrupted` / `question_expired`.

   **Every session paused with `exit_reason: awaiting_answer` re-subscribes to `question.answered`
   for its question id here**, on boot, before any listener binds. This is what makes stage 3
   (§5.4) survive a restart: the trigger is the **persisted `questions` row**, never an in-memory
   promise — the promise `QuestionBridge.ask()` returned died with the previous process, and nothing
   in the resume path may depend on it. The boot task reads each parked session's open question, and
   from then on the answer arriving hours later resumes the session exactly as it would have without
   the restart. A parked session whose question is already `answered` (the answer landed while the
   core was down) is re-queued immediately from the row, without waiting for an event that will never
   be emitted again.
4. **Leases** for assignments that are no longer `open` are released. Runner starts after projects
   (it `dependsOn` it), so projects' own sweep has already marked truly abandoned leases `orphaned`;
   since projects' uniqueness index only covers `state = 'active'`, a fresh session for the same
   assignment can re-acquire cleanly.

### 9.3 What is resumable — honestly

The SDK persists the **conversation** as JSONL under `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/`,
and foundation pins `CLAUDE_CONFIG_DIR` to `<dataRoot>/state/claude-config` (foundation §2.3), so it
sits inside our own data root and survives our restart [V]. `resume: <sdk_session_id>` replays it into
a fresh subprocess.

**Resumable:** the message history, therefore everything the agent knew and everything it said. This
is what makes pause/resume and post-crash continuation real rather than aspirational.

**Not resumable, and the design says so rather than pretending:**

- The **tool call in flight at the moment of the crash**. Its result was never produced, and the SDK
  transcript is written in batches, so the record may not even show the call [V]. Runner's own
  detection is structural: if the last recorded pair in our transcript is a `tool_use` with no
  matching `tool_result`, the resumed session is told so explicitly in its first message.
- **Filesystem state.** Sessions persist the conversation, not the working tree [V]. A half-applied
  edit stays half-applied. Runner surfaces the workspace's dirty state on the resume card so the user
  can decide.
- **MCP connections and subprocess state** — re-established from scratch on resume.
- **A session that crashed before `init`.** No `sdk_session_id` was ever captured, so there is nothing
  to resume; the session is `orphaned` and terminal, and the UI offers *Relaunch*, not *Resume*.
- **A session whose `cwd` is gone.** SDK session lookup is keyed by the working directory [V]. If the
  workspace was a worktree that has since been cleaned up, resume is impossible. Runner checks the
  lease before offering the action.

### 9.4 The two resume paths

| Path | From | Row | SDK call |
|---|---|---|---|
| **Resume a pause** | `paused` | **Same** session row, same transcript, `resumed_from` untouched | `query({ options: { …compiled, resume: sdk_session_id } })` |
| **Continue an orphaned or finished session** | `orphaned` / `done` / `failed` / `interrupted` | **New** session row, new transcript, `resumed_from = <old id>` | same, plus a first user message stating what happened |

Pause/resume reuses the row because it is one continuous piece of work whose interruption point we
chose. Continuing an orphaned session does not, because the old session genuinely died and projects'
assignment-outcome projection must keep saying so. `resumed_from` makes the chain queryable, and the
UI renders it as one thread.

Both paths re-run the launch chain from step 3 (assignment context, lease, launch context, compile),
because the agent definition, the project defaults, or the permissions may have changed since — and
resuming with stale compiled options would be a permission bug with a very long fuse. If the SDK
mints a new session id on resume [A], `sessions.sdk_session_id` is updated to the newest and both ids
appear in the `session.resumed` event.

---

## 10. Structured session events

All on foundation's typed bus (§6.5), envelope `{ type, ts, ids, payload, persist }` with
`ids = { sessionId, assignmentId, projectId, agentId }` always populated.

| Type | `persist` | Payload |
|---|---|---|
| `session.queued` | ✔ | `{ priority, weight, queuePosition, promptPreview }` |
| `session.started` | ✔ | `{ sdkSessionId, model, permissionMode, questionBridge: 'enabled'\|'disabled', workspace: {kind, path, branch}, effectivePermissions, elevation, diagnostics, transcriptPath, resumedFrom }` |
| `session.message` | ✖ | `{ seq, role, contentBlocks, text }` — one per complete assistant/user turn |
| `session.delta` | ✖ | `{ seq, text }` — partial assistant text, only when `includePartialMessages` |
| `session.tool.start` | ✖ | `{ seq, toolUseId, name, inputPreview }` |
| `session.tool.end` | ✖ | `{ seq, toolUseId, name, isError, durationMs, resultPreview }` |
| `session.usage` | ✖ | `{ seq, delta: {input, output, cacheRead, cacheCreation}, model, sessionTotals, assignmentTokensUsed }` |
| `session.steered` | ✔ | `{ text, interrupted }` |
| `session.question.raised` | ✔ | `{ questionId, kind, prompt, options, toolName, holdUntil, expiresAt }` |
| `session.question.answered` | ✔ | `{ questionId, answeredVia, latencyMs, delivery: 'inline'\|'after-park', decision }` |
| `session.paused` | ✔ | `{ reason, resumable, questionId? }` |
| `session.resumed` | ✔ | `{ mode: 'same-session'\|'new-session', resumedFrom, sdkSessionId, priorSdkSessionId }` |
| `session.ended` | ✔ | `{ status, exitReason, turns, durationMs, totals, costUsdEstimate, permissionDenials, summary, transcriptBytes }` |
| `session.orphaned` | ✔ | `{ lastSeq, sdkSessionId, resumable, reason }` |
| `session.diagnostic` | ✔ | `{ severity, code, message }` — compile diagnostics, MCP `needs-auth`, `dontAsk` bridge disabled |
| `runner.queue.changed` | ✖ | `{ running, queued, blocked, capacity, cooling }` |
| `runner.ratelimited` | ✔ | `{ until, source, hint }` |
| `runner.mcp.status` | ✖ | `{ sessionId, servers: [{ name, status }] }` — from `Query.mcpServerStatus()` |

**The persist split is a deliberate load decision.** `session.delta`, `session.message`,
`session.tool.*`, and `session.usage` are the high-volume events; persisting them would blow through
foundation's 200k-row `events` cap in a handful of sessions and turn the UI's replay query into a
scan. Their durable record is the transcript, which is a file built for exactly that. A reconnecting
UI therefore replays from `events` (the ✔ rows: lifecycle, questions, diagnostics) plus a byte-offset
tail of the transcript, and subscribes to the live stream for the rest — which is precisely the
mechanism foundation §1.5 and §6.5 provide.

`runner.mcp.status` carries roster's `pending | connected | failed | needs-auth | disabled` vocabulary
(roster §10) unchanged, and a `needs-auth` server is additionally raised as a `session.diagnostic` so
the UI can render it as an actionable card rather than a generic failure.

---

## 11. Interfaces

### 11.1 HTTP (on foundation's single route table, therefore remote-reachable per D5)

```
POST   /api/sessions                 { assignmentId, agentId, projectId, prompt, role?, priority? }
                                     → { sessionId, status, queuePosition } | 429 queue_full
GET    /api/sessions                 ?status=&projectId=&assignmentId=&agentId=&limit=&before=
GET    /api/sessions/:id             record + usage + queue position + resume affordances
POST   /api/sessions/:id/steer       { text, interrupt?: boolean }
POST   /api/sessions/:id/pause
POST   /api/sessions/:id/resume
POST   /api/sessions/:id/continue    → new session with resumed_from (§9.4)
POST   /api/sessions/:id/stop        { reason? }
POST   /api/sessions/:id/pin         { pinned: boolean }        -- projects' retention exemption
GET    /api/sessions/:id/transcript  ?from=<byteOffset>&limit=&tail=<bytes>  -- foundation §1.5 tailing
GET    /api/sessions/:id/stream      live event stream for one session
GET    /api/runner/queue
GET    /api/runner/usage
PUT    /api/runner/capacity          { maxConcurrent }          -- settings, not config
```

**The transcript route's offset/tail contract** (ui §19, R6), stated here because a client computing
an offset from `sessions.transcript_bytes` needs it to be safe:

- `from=<byteOffset>` reads forward. Every response returns **whole JSONL lines only** plus the
  `next` offset to resume from. A `from` that lands mid-line is not an error and is not silently
  truncated — it **advances to the following newline**, so an offset taken from `transcript_bytes`
  mid-flush, or from a `session.delta` watermark, can never split a record or yield unparsable bytes.
- `tail=<bytes>` reads **backward** from the end: the last N bytes, snapped forward to the next line
  boundary, capped by `runner.transcript.maxTailBytes` (default 1 MB, 64 KB when unspecified). It is
  mutually exclusive with `from` (400 if both are given), and it returns the same
  `{ lines, from, next, pruned }` shape.
- Both forms report `pruned: true` rather than failing when projects' retention has removed the
  earlier part of the file, and `next` always advances so a poll loop terminates.

This makes the HTTP route the exact peer of the in-process `getTranscriptTail` (§11.2), which already
served the "last N bytes, whole lines" shape. Without `tail`, opening a long finished session — up to
the 512 MB per-session cap (§10) — means paging forward from byte 0, which is work proportional to
the transcript's length to show its end; with it, opening a finished session costs one request
regardless of size, which is what the session view actually does on open before it subscribes to the
live stream.

`origin` (`local` | `remote`) is taken from foundation's request context and stored on
`sessions.origin`; runner adds no remote-specific behaviour of its own (§15.3).

All control verbs are **idempotent**: pausing a paused session, stopping a stopped one, or resuming a
running one returns the current state with 200, not an error. Remote clients on flaky links retry,
and a retry that 409s is a retry that produces a support ticket.

### 11.2 In-process service (`ctx.provide('runner', …)`)

```ts
interface RunnerService {
  startSession(req: StartSessionRequest): Promise<StartSessionResult>;
  steer(sessionId: string, text: string, opts?: { interrupt?: boolean }): Promise<void>;
  pause(sessionId: string, reason: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  continueFrom(sessionId: string, prompt: string): Promise<StartSessionResult>;
  stop(sessionId: string, reason: string): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  getTranscriptTail(sessionId: string, opts?: { maxBytes?: number }):
    Promise<{ lines: TranscriptLine[]; from: number; next: number; pruned: boolean }>;
  listActive(): SessionRecord[];
  queueState(): { running: number; queued: number; blocked: number; capacity: number; cooling: boolean };
  usageWindows(): UsageWindows;
}
```

`getTranscriptTail` is the **in-process equivalent of `GET /api/sessions/:id/transcript`** (§11.1),
serving the same whole-JSONL-lines-plus-next-offset contract from the last `maxBytes` (default 64 KB)
of the file. It exists because orchestrator needs a turn's output after a core restart has lost the
live `session.message` capture, and it must not make an HTTP call to its own process to get it
(orchestrator §17, R3). Same rules as the HTTP route: whole lines only, and a pruned transcript
returns `pruned: true` rather than throwing. Read-only — nothing here writes.

### 11.3 What runner requires from the registry

| Provider | Used for | If absent |
|---|---|---|
| `roster` | `compileSession`, agent lookup | fatal — runner does not start |
| `projects` | `getEffectiveLaunchContext`, `acquireWorkspace` / `releaseWorkspace` | fatal |
| `orchestrator` | `getAssignmentContext`, `QuestionBridge`, `assignment.closed` | degraded: questions fall back to direct `questions` rows (§5.2); **no launch path**, since runner never mints assignments (§14, D9) |

---

## 12. Configuration

`runner.maxConcurrent`, `runner.queueLimit`, and `runner.defaultModel` are already in foundation
§2.3. The rest is runner's module sub-schema, contributed through foundation §2.1's composition
mechanism:

```jsonc
"runner": {
  "maxConcurrent": 2,             // foundation §2.3; edition.work.json lowers to 1
  "queueLimit": 50,               // foundation §2.3
  "defaultModel": "sonnet",       // foundation §2.3; only a fallback — roster definitions carry a model
  "startTimeoutMs": 90000,        // no system/init by then → failed / start_timeout
  "idleTimeoutMs": 1200000,       // 20 min with no SDK message of any kind → failed / idle_timeout
  "wallClockMaxMinutes": 120,     // the SDK has no session timeout; this is ours
  "gracefulInterruptMs": 10000,   // fits inside service.shutdownGraceSeconds (20)
  "workspaceWaitMinutes": 60,
  "queueStaleHours": 24,
  "question":   { "holdMs": 900000, "expireHours": 24 },
  "transcript": { "flushLines": 50, "flushMs": 2000, "maxMb": 512, "maxTailBytes": 1048576 },
  "rateLimit":  { "cooldownMs": 300000, "maxCooldownMs": 1800000 }
}
```

`idleTimeoutMs` is 20 minutes rather than something tighter because a legitimate long `Bash` call
produces no SDK messages at all while it runs; a tight idle timeout would kill real work.

---

## 13. Architecture conformance

- **D1** — a TypeScript module registered through foundation's module system. No PowerShell at runtime.
- **D2** — subscription OAuth via `SecretResolver` (§3.4), the `ANTHROPIC_API_KEY` strip, the
  concurrency cap and queue (§6), and the honest plan-window reporting (§7.4). The work edition's
  swap to API key/Bedrock is a config value and touches no code path.
- **D3** — one HTTP/WS surface on foundation's route table, consumed identically by Electron and by
  the tailnet browser.
- **D4** — every session carries an assignment id; runner never mints one and never routes work.
  Roster's ban on the SDK subagent tool is preserved by runner never adding an `agents` option.
- **D5** — no remote-specific logic; `origin` is recorded, and the remote listener's middleware is
  the only thing that differs.
- **D6** — edition is configuration: `maxConcurrent` and `auth.mode` differ by edition file, and
  nothing in this element branches on edition.

---

## 14. Decisions

Every open question in [README.md](README.md), plus the ones this design had to settle to be
implementable.

**D1 — SDK streaming-input mode vs one-shot runs; what does "steering a running agent" require?**
**Streaming input, for every session, with no one-shot path.** `Query.interrupt()`, mid-session
message queueing, and `setPermissionMode` are documented as streaming-input-mode only, and a
single-shot `query()` throws after an error result instead of surviving it. Three of runner's four
stated responsibilities are therefore impossible in one-shot mode. The cost is one small async-iterable
class; running both modes would cost two reader loops and two places to lose a steer.

**D2 — Crash/restart recovery: can in-flight sessions be resumed?**
**The conversation, yes; the in-flight tool call, no; and the design says both out loud.** The SDK
persists session JSONL under `CLAUDE_CONFIG_DIR`, which foundation already points inside our data
root, so `resume: <sdk_session_id>` genuinely works after a core restart. What does not survive is the
tool call that was executing, the filesystem state it half-produced, and any session that died before
`init`. So: `running` → `orphaned` on boot (terminal), resume is offered as a **new** session with
`resumed_from`, and the first message tells the agent what was interrupted. Pretending a resume is
seamless would produce agents that believe a tool call succeeded when it did not.

**D3 — Sensible default concurrency cap; configurable per plan tier?**
**2 (1 in the work edition), capped on the sum of roster's `concurrencyWeight`, runtime-overridable
through `settings`, and *not* tier-derived.** Two reasons for the number: the 5-hour and weekly
windows are shared with the owner's own Claude usage (D2), and each session is a CLI subprocess
budgeted near 1 GiB. Not tier-derived because there is no documented programmatic source for the plan
tier or its window sizes — a tier-derived cap would be a guess with a number on it. It is one config
key.

**D4 — What does `paused` mean, given the SDK has no suspend?**
**Stop with intent to continue: `interrupt()` + `close()` + remembered `sdk_session_id`, resumed with
`resume`.** Pause releases the concurrency slot and keeps the workspace lease. Separating it from
`interrupted` is what lets the UI show a Resume button, lets projects' timeline keep the assignment
`running`, and gives the scheduler a truthful free slot.

**D5 — How long may a question block a live session, and what happens after?**
**Hold inline for 15 minutes, then park; auto-resume when the answer lands; expire at 24 hours.**
`canUseTool` may block indefinitely, but an indefinite block holds a subprocess and a slot while the
user sleeps. Inside the hold the answer arrives *inside the tool call* with nothing lost. Past it the
session is parked as `paused` with the question still open, and the denial message explicitly tells
the agent to stop rather than work around it — because an agent that improvises around a denial is
precisely the "gave up and moved on" failure the README names. The cost of a park is one re-decided
tool call, which is bounded and visible.

**D6 — Is there preemption?**
**No.** Nothing kills a running session to make room. Agent work is stateful and frequently
mid-tool-call; a preemption is a half-written file the user finds later. The pressure valves are
question-parking (automatic, frees a slot) and user pause (explicit, frees a slot) — both of which
stop at a chosen point rather than an arbitrary one.

**D7 — How are the shared plan windows surfaced?**
**Local estimate of our own usage, labelled as such; opportunistic `rate_limit_event` telemetry;
authoritative-but-after-the-fact rate-limit observation driving cool-down.** There is no supported
programmatic view of the 5-hour or weekly window, and the owner's interactive usage is in the same
bucket and invisible to us. The UI must say "AgentManager used X in the last 5 hours", never
"Y% remaining". Scraping `/usage` was considered and rejected: an unsupported source that breaks
silently would let the app lie to the user about their quota.

**D8 — Where does token metering come from, given the SDK's usage quirks?**
**Per-assistant-message deltas deduped by message id for the live view, reconciled against
`result.modelUsage` at every turn for the truth.** Parallel tool calls repeat one message id with
identical usage, and per-step `output_tokens` is a placeholder — so a naive per-message sum both
double-counts and undercounts. `modelUsage` also covers subagents, making the accounting independent
of a permission decision. Both writes land in the same transaction as the `session_usage` upsert and
the `assignments.tokens_used` increment, so a budget check never reads a lagging number.

**D9 — Who creates the assignment a session belongs to?**
**Not runner.** `assignmentId` is required on every start; orchestrator mints assignments, including
the trivial solo one behind a drag-and-drop launch. Runner writing to an orchestrator-owned table to
manufacture its own precondition would be exactly the boundary violation foundation §1.3 forbids. The
consequence is explicit: with `modules.orchestrator.enabled: false` there is no launch path in v1.
That is why the key defaults to true, and if it ever needs to be false the fix is trivial-assignment
minting in foundation's repository — not in runner.

**D10 — Who owns `canUseTool`, given roster compiles permissions?**
**Runner, and it is not a permission decision.** By the verified evaluation order, anything reaching
`canUseTool` has already passed the deny rules and already failed to be auto-approved — so the
callback is the escalation point for an *undecided* call, not a place where a rule is evaluated.
Runner matches no patterns and consults no rule set; roster's default-deny remains the outcome
whenever no human is reachable. Recorded as a clarification to roster in §15.4 rather than assumed.

**D11 — Are partial messages written to the transcript?**
**No.** Deltas go to the WebSocket for live typing; the complete `assistant` line already carries the
content. Persisting them would inflate transcripts several-fold and make projects' size cap prune
real history to store keystrokes.

**D12 — Does a session stay alive after its first `result`?**
**No: a session is one unit of work.** In streaming mode each turn emits its own `result`, so
"keep the session open for chat" is technically available — and it would hold a ~1 GiB subprocess and
a concurrency slot for an idle conversation, on a machine with a cap of 2. Continuing after a result
is a `resume` into a new session under the same assignment, which the UI renders as one thread.
Steering *while the agent works* — the case the README actually asks for — is unaffected.

**D13 — Two priority bands, FIFO within each.**
`interactive` (a human is waiting: UI/remote launches, and resumes of a question-parked session) ahead
of `normal` (orchestrator worker sessions). Anything richer is scheduler tuning that a cap of 2
cannot reward, and the one case that genuinely matters is not making someone who just answered a
question wait behind a batch.

---

## 15. Contracts pinned for wave 3

These are runner's binding outputs. Orchestrator, remote, and UI design against them.

### 15.1 For orchestrator

1. **`RunnerService`** (§11.2) is published on the service registry as `runner`. It is the only way to
   start, steer, pause, resume, or stop a session; nothing writes `sessions` directly.
2. **Runner never mints assignments.** `startSession` requires an existing, `open` `assignmentId`
   (§14, D9).
3. **`AssignmentContext`** — orchestrator must provide
   `getAssignmentContext(assignmentId): Promise<{ id, pattern, status, role?, write: boolean,
   scopeRules: { allow?: string[]; deny?: string[]; ask?: string[] }, tokenBudget: number | null,
   tokensUsed: number, roundCap, roundsUsed }>`.
   `write` is an **assignment** property (projects §4.1 leases on write-capability, and a plan/review
   assignment must not take the write hold). `scopeRules` are raw rule strings for roster to compose.

   `scopeRules` was a flat `string[]` (an allow-list only), which cannot express a genuinely read-only
   assignment — orchestrator raised this (orchestrator §17, R2). It is now the same three buckets
   roster's permission vocabulary already uses, so nothing new is introduced anywhere: **orchestrator
   supplies** the rule strings per bucket, **roster's `compilePermissions` composes** them as the
   assignment layer (roster §6.2, still the sole composer), and **runner passes them through
   untouched** — runner does not read, merge, or interpret rules. All three buckets are optional; an
   assignment with no scope restriction sends `{}`.

   Independently of what orchestrator declares, roster's compiler adds a mutating-tool **deny** when
   `write === false`, so a read-only assignment is safe by the one flag rather than by orchestrator
   remembering to enumerate every mutating tool. Declared `deny` and `ask` entries are additive on top
   of that floor. A per-seat model override, if it ever arrives, is a sibling field here and not part
   of v1.
4. **`QuestionBridge`** (§5.2) — orchestrator must provide `ask()` and `cancel()` with the given
   shapes. `ask()` may take hours to resolve; runner will not call it more than once per pending tool
   call, and cancels it if the session dies first.
5. **`assignment.closed`** — orchestrator must emit it. Runner releases the workspace lease on it.
6. **Budget arithmetic**: `assignments.tokens_used += input_tokens + output_tokens`, incremented by
   runner in the same transaction as the usage write. Cache tokens are excluded. On crossing
   `token_budget`, runner pauses the session (`exit_reason: budget_halt`), raises a `budget_halt`
   question, and emits `assignment.budget.exceeded`. Orchestrator owns the card and the resolution;
   an answer that raises the budget resumes the parked session automatically.
7. **Parked sessions auto-resume when their question is answered.** Orchestrator must not separately
   relaunch a session it parked, or the work runs twice. The boundary in full: orchestrator **may**
   call `RunnerService.stop()` on any session — closing an assignment, tripping a circuit breaker —
   but it **never resumes a session runner parked**; auto-resume applies only to sessions runner
   itself parked with `exit_reason: awaiting_answer`, and it is runner's alone (orchestrator §17, R6).
8. **Question kinds runner raises**: `question` (tool gate and `AskUserQuestion`) and `budget_halt`.
   `approval_gate` is orchestrator's to raise.
9. **A `dontAsk` session cannot ask anything** (§5.6). An orchestrator pattern that depends on
   mid-session human input must not compose down to that mode.
10. **The session event vocabulary and payloads of §10**, including which events persist.

### 15.2 For UI

11. **Transcript tailing**: `GET /api/sessions/:id/transcript?from=<byteOffset>` returns whole JSONL
    lines plus the next offset. `sessions.transcript_bytes` is the current length. A pruned transcript
    (path NULLed by projects' retention job) returns a defined "pruned" result, not a 500.
12. **Replay contract**: a reconnecting client replays persisted events from `/api/events?since=` and
    tails the transcript from its last byte offset. `session.delta`, `session.message`,
    `session.tool.*`, and `session.usage` are **not** persisted and are not replayable — the transcript
    is their record.
13. **Usage display**: `GET /api/runner/usage` (§7.4) and its `source` labels are load-bearing. The UI
    renders "AgentManager used X in the last 5 hours" and never "Y% of your plan remains".
    `session_usage.cost_usd` renders as *estimated model cost*, never as spend.
14. **Session controls**: Steer (with an interrupt toggle), Pause, Resume, Stop, Continue, Pin. All
    idempotent; all available identically over the tailnet.

### 15.3 For remote

15. **No route is runner-specific.** Everything in §11.1 rides foundation's shared route table;
    remote adds bearer auth and sets `origin: 'remote'`, which runner stores on `sessions.origin` and
    which orchestrator stores as `questions.answered_via`.
16. **Runner applies no remote-specific permission restriction.** Answering remote's open question
    from this side: if remotely started sessions should be more cautious, that belongs in a project's
    `PermissionOverride` or an agent's baseline, where roster composes it and the user can see it —
    not in a hidden runner behaviour that the permission preview would not show.
17. **A remote client may lower `maxConcurrent` but not raise it**, and cannot change any other
    runner configuration.

### 15.4 Reconciliations raised against wave 1

Per CLAUDE.md's ground rule, these are raised rather than silently diverged from:

18. **Roster §6.2/§6.3 — who installs `canUseTool`.** Runner installs it (§5.1, D10). Roster's
    compiler should not set the field, or should accept that runner replaces it. Roster's stated
    semantics are fully preserved: default-deny is the outcome whenever no human answers. This is not
    a change to permission composition, and roster remains the only composer.
19. **Foundation §3.2 — the authorized `.reveal()` sites.** Foundation §3.3 already assigns
    `claude.oauthToken` to runner, but §3.2's list of authorized reveal sites names only roster's
    compiler and remote's token check. Runner needs a third: `attachAuthEnv()`, one key, one function
    (§3.4). Either §3.2's list gains the entry, or foundation injects the auth environment on runner's
    behalf. Runner has no preference; it must not be ambiguous.
    **Resolved:** §3.2's list gained the entry, and remote's entry came off it in the same pass
    (remote does not call `.reveal()` — it hashes the presented token). The list is now exactly two:
    roster's compiler and runner's `attachAuthEnv()`.
20. **Roster §6.2's `dontAsk` flag is resolved.** Verified: in `dontAsk`, `canUseTool` is skipped and
    the call denied. Roster's reading — *never prompt, auto-reject* — is correct, and its mode ladder
    `plan < dontAsk < default < acceptEdits` stands as written. Roster's M0 no longer needs to
    re-derive this, though it should still confirm it against the pinned SDK version.
21. **Projects §4.3 — refusal retryability.** Runner needs to distinguish "wait, this will free up"
    from "this can never work here". Requested: a `retryable: boolean` on `WorkspaceRefusal`.
    **Resolved:** projects §4.4 carries `retryable: boolean` on `WorkspaceRefusal`, so runner reads
    the flag rather than pattern-matching the reason. §3.1 step 4 and §6.2's blocked entries are
    written against it.

---

## 16. Deliberately deferred past v1

| Deferred | Why / what unblocks it |
|---|---|
| `PreToolUse` `defer` instead of hold-then-deny for parked questions (§5.4) | Strictly better — it preserves the pending tool call — but needs the decision made before the hold, and needs `hooks` + `canUseTool` coexistence verified. Adopting it changes §5.4 only. |
| Long-lived interactive sessions (linger after a `result`) | Costs a ~1 GiB subprocess and a concurrency slot per idle conversation against a cap of 2. `resume` gives the same thread for free. |
| `SessionStore` (S3/Redis/Postgres) for SDK session state | Single-machine, single-user tool (foundation §7). Local JSONL under our data root is sufficient. |
| Subprocess pre-warming via the SDK's `startup()` | A latency optimisation; measure first. |
| Automatic model downgrade or retry-on-a-cheaper-model under rate-limit pressure | Roster §8 is explicit that nothing may silently downgrade a model the user chose. |
| Context-pressure surfacing via `Query.getContextUsage()`, and auto-compaction policy | Useful UI signal, no v1 decision depends on it. |
| Per-session resource limits (RSS/CPU caps, job objects) | The concurrency cap is the v1 bound. Revisit if a session ever ships the machine's memory. |
| Structured output (`outputFormat: {type:'json_schema'}`) for machine-readable session results | Orchestrator may want it for worker completion reports; that is orchestrator's decision to drive. |
| Scheduled / recurring sessions, and session templates | Nothing in v1 needs them, and they interact with budgets and the queue in ways worth designing once there is usage data. |
| Multi-turn transcript compaction and `compact_boundary` handling beyond recording it | Projects owns transcript retention; compaction is an SDK behaviour we log, not one we drive. |
| Reading rate-limit windows from any undocumented endpoint or CLI output parsing | Would break silently and lie about quota (§7.4, D7). |
