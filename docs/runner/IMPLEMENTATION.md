# Runner — Implementation

Ordered v1 milestones implementing [DESIGN.md](DESIGN.md). Each is independently verifiable and
leaves the tree in a working state. Section references (§) are to DESIGN.md.

**Prerequisites from foundation** (blocking M1): config loader and module sub-schema composition
(§2.1), SQLite connection + element-migration runner (§1.3), `sessions` / `usage_events` /
`session_usage` / `questions` / `assignments` repositories, the transcript path helper and byte
accounting (§1.5), `SecretResolver`, logger with redaction, event bus, `registerBootTask`,
`registerRoutes`, `settings`. Equivalent to foundation M1–M7.

**Prerequisites from wave 1 elements**: roster's `compileSession` (roster §13) blocks M3; projects'
`getEffectiveLaunchContext` and `acquireWorkspace`/`releaseWorkspace` (projects §4.3, §5) block M3.

**Already pinned, not open coordination points**: `sessions.assignment_id NOT NULL`; the status
vocabulary `queued | running | paused | done | failed | interrupted | orphaned`; `sessions.summary`,
`transcript_path`, `transcript_bytes`; the transcript layout `state/transcripts/<YYYY>/<MM>/<id>.jsonl`;
`usage_events` + `session_usage` as the sole home of the token split.

**Open with orchestrator, needed by the milestone shown**: `getAssignmentContext` and
`assignment.closed` (M3), `QuestionBridge` (M7). Until orchestrator lands, both are stubbed behind the
interfaces in §15.1 — never worked around by writing orchestrator's tables.

---

## M0 — SDK verification spike

Pin an **exact** `@anthropic-ai/claude-agent-sdk` version in `package.json` and write a throwaway
script (not shipped) that proves every SDK behaviour DESIGN.md depends on, against
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` rather than documentation. Record each result
as a short amendment to DESIGN.md §0 — flipping `[A]` entries to `[V]` or correcting the design
before any code depends on them.

Must be answered before M2 starts:

- Streaming input: `query()` with an `AsyncIterable<SDKUserMessage>`; the exact `SDKUserMessage`
  shape; whether the iterable is consumed lazily (if not, use `Query.streamInput()` instead — §4.2).
- `Query.interrupt()`: what message sequence follows, and what `result` subtype the interrupted turn
  produces.
- `canUseTool`: the three-argument form compiles against `sdk.d.ts`; a call blocked for 60 s resolves
  correctly; an `allow` result that echoes `updatedInput` is accepted.
- `AskUserQuestion`: it fires `canUseTool`; the `{questions, answers}` `updatedInput` round-trips and
  the model receives the answer.
- `permissionMode: 'dontAsk'` skips `canUseTool` and denies (confirms §5.6 and roster §6.2's ladder).
- `hooks` and `canUseTool` coexist on one session without either shadowing the other; whether a
  `PreToolUse` `defer` ends the query with the call still pending (informs §16's deferred item).
- One `result` per turn in streaming mode, and messages arriving after `result`.
- `resume`: whether the SDK session id is preserved or replaced; that the JSONL lands under
  `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/`; whether a session killed mid-tool-call resumes and
  what the transcript shows.
- `result` fields actually present: `usage`, `modelUsage`, `total_cost_usd`, `num_turns`,
  `permission_denials`, `stop_reason`, `duration_ms`.
- Whether `rate_limit_event` is ever observed, and whether `Query.accountInfo()` carries anything
  plan-related.

**Acceptance**
- A committed CI check fails if any SDK option, method, or union value used by runner is absent from
  the pinned `sdk.d.ts`.
- Every `[A]` in DESIGN.md §0 is resolved to a verified statement or an explicit design change, and
  the reconciliation in §15.4 item 20 is confirmed or reopened with roster.
- The spike script is deleted or moved under `scripts/spikes/`; nothing in `src/` depends on it.

## M1 — Module skeleton, schema, config, and the session repository

Register the `runner` module (`dependsOn: ['storage','secrets','roster','projects']`), contribute the
§12 config sub-schema and its defaults, ship `migrations/runner/0001_runner.sql` (§3.5), and implement
a `SessionRepository` over foundation's `sessions` repository covering the added columns,
`session_inputs`, and the status transition table of §2.2. No SDK involvement.

**Acceptance**
- The element migration applies after foundation's core set, is idempotent, and registers under
  module `runner` in `schema_migrations`.
- `runner.*` keys resolve through all five config layers; `AGENTMANAGER_RUNNER_MAXCONCURRENT=4` wins
  over the machine-local file; an out-of-range value is a fatal validation error naming the key.
- A transition-table test drives every arrow in §2.2 and asserts that every arrow **not** in the table
  is rejected — in particular `paused → orphaned`, `orphaned → *`, and any exit from a terminal status.
- Every terminal or paused transition writes an `exit_reason` from the closed §2.3 set; a write
  without one throws.
- The module starts and stops cleanly with no sessions present, and reports healthy.

## M2 — Transcript writer, summary, and byte accounting

The append-only JSONL writer (§8): one stream per session, the line-type vocabulary, `seq`
monotonicity, flush policy, `transcript_bytes` maintenance per flush, foundation's redaction on every
line, the `maxMb` cap, `fs.stat` reconciliation, and `sessions.summary` composition. Plus
`GET /api/sessions/:id/transcript?from=<byte>`.

Built before the SDK is wired so the first real session is observable from the first minute.

**Acceptance**
- Appending advances `transcript_bytes` to the file's exact size, verified after a flush, after a
  clean close, and after a simulated crash followed by `fs.stat` reconciliation.
- A line containing an OAuth-shaped token and a `Bearer` header is written with `[redacted]`; the raw
  value appears nowhere in the file.
- `seq` is strictly increasing with no gaps across a pause/resume that reuses the same file.
- Exceeding `transcript.maxMb` appends exactly one `error` line with `code: transcript_cap`, stops
  appending, and does not fail the session.
- `summary` after a completed session matches the §8.3 formula, is ≤ 240 characters, and is present
  (prompt + `running`) while the session is still live.
- Tailing from a byte offset returns whole JSONL lines and the next offset; a NULLed
  `transcript_path` returns the defined "pruned" result, not a 500.

## M3 — The launch chain and the first real session

Implement `startSession` admission checks, the queued row + `session_inputs`, then the full chain of
§3.1: assignment context, `acquireWorkspace` with lease refcounting, `getEffectiveLaunchContext`,
`compileSession`, the §3.3 whitelist, `attachAuthEnv` (§3.4), transcript open, `query()` in streaming
mode, and the reader loop of §2.4 through to `done` / `failed`. Concurrency is temporarily fixed at 1;
the scheduler is M5.

**Acceptance**
- A real agent runs a real prompt against a real project end to end and lands `done` /`completed`,
  with a transcript containing `session.start`, `system`, `assistant`, and `session.end` lines.
- **Options-immutability assertion**: the compiled options are snapshotted before and after runner's
  mutations, and only §3.3's whitelisted key paths differ. The test fails if runner touches
  `allowedTools`, `disallowedTools`, `permissionMode`, `settings`, `mcpServers`, `systemPrompt`,
  `model`, `maxTurns`, `maxBudgetUsd`, `cwd`, `plugins`, `skills`, or `settingSources`.
- Runner issues no SQL against `agents`, `projects`, `assignments`, or `questions` outside
  foundation's repositories, asserted by the same static check foundation M11 uses for cross-module
  imports.
- Auth: with `auth.mode: 'subscription'` and no stored token, the session fails
  `secret_unresolved` naming `Setup-Auth.ps1`; with a token present it runs; with
  `ANTHROPIC_API_KEY` planted in the process environment it still runs on the subscription and logs
  the strip at `WARN`.
- Each §3.2 failure row produces its stated status and `exit_reason` with a human-readable message —
  no stack trace reaches the API.
- The lease is acquired once for an assignment's first session, refcounted across a second session
  on the same assignment, and released on `assignment.closed`.
- Every `result` subtype maps to the status in §2.2; `error_max_turns` and `error_max_budget_usd` are
  covered by forcing tiny `maxTurns` / `maxBudgetUsd` values.
- The reader loop continues past the first `result` to generator completion and does not drop
  trailing system messages.

## M4 — Usage metering

Live per-assistant-message deltas deduped by message id, `result.modelUsage` reconciliation, the
`session_usage` rollup and the `assignments.tokens_used` increment in one transaction, and
`session_usage.cost_usd` from `total_cost_usd` (§7.1–7.3).

**Acceptance**
- After any session, `SUM(usage_events)` for that session equals `session_usage`, and both equal the
  totals in the final `result.modelUsage`.
- A session with parallel tool calls (several assistant messages sharing one id) is counted **once**;
  the unique index makes the duplicate insert a no-op rather than an error.
- The reconciliation row appears with `source: 'reconcile'` whenever the live estimate differs, and a
  large adjustment logs at `warn`.
- `assignments.tokens_used` advances by exactly `input + output` per turn, excludes cache tokens, and
  is written in the same transaction as the usage rows — proven by a test that aborts the transaction
  and finds neither side applied.
- `cost_usd` is nullable and is surfaced through the API under a field name containing `estimate`.
- Killing the process mid-session and restarting does not double-count on any subsequent read.

## M5 — Scheduler: cap, weights, queue, and rate-limit cool-down

The weighted concurrency cap, two priority bands with FIFO ordering, `queueLimit` refusal, blocked
entries awaiting a retryable workspace refusal, the `settings`-backed runtime capacity override, the
cool-down state machine, and `GET /api/runner/queue` + `runner.queue.changed`.

**Acceptance**
- With `maxConcurrent: 2`, three launches run two and queue one; the queued one starts when either
  finishes.
- An agent with `concurrencyWeight: 2` occupies the whole cap at `maxConcurrent: 2`; a weight-1
  session queued behind it starts only when it ends.
- An `interactive` session enqueued after a `normal` one is admitted first; two of the same band are
  admitted in `queued_at` order.
- The 51st queued session is refused with `queue_full` and **no session row exists** afterwards.
- A retryable workspace refusal leaves the session `queued` with `blocked_reason` set, consuming no
  slot, and it starts on `workspace.released`; it fails `workspace_unavailable` after
  `workspaceWaitMinutes`.
- Simulated rate limiting enters cool-down, blocks admissions while running sessions continue, emits
  `runner.ratelimited` with a `source`, doubles on a second hit, and clears on the next successful
  start.
- `PUT /api/runner/capacity` changes the effective cap without a restart, persists in `settings`,
  survives a restart, and clamps outside 1..8.

## M6 — Session control: steer, pause, resume, stop

The `InputQueue` (§4.2), `steer` with and without interrupt, pause via `interrupt()` + `close()`,
resume on the same row with `resume`, stop, pin, the idle and wall-clock guards, and the idempotency
rule of §11.1.

**Acceptance**
- Steering without interrupt delivers the message at the next turn boundary; with `interrupt: true`
  the current turn stops within `gracefulInterruptMs` and the steered message is the next thing the
  agent sees. Both appear in the transcript as `steer` lines.
- Pause on a running session yields `paused`, releases the slot (a queued session starts), keeps the
  lease, and records `sdk_session_id`; resume continues on the **same** row and the **same**
  transcript with `seq` unbroken, and the agent demonstrably retains prior context.
- Stop yields `interrupted` / `user_stopped` and never leaves a live subprocess — asserted by process
  count before and after.
- Pause/stop/resume are idempotent: repeating each returns 200 with the current state.
- Steering a non-`running` session returns a typed 409.
- `idleTimeoutMs` and `wallClockMaxMinutes` each terminate a session with their own `exit_reason`; a
  long-running `Bash` call inside the idle window does **not** trigger the idle guard.
- The `InputQueue` never throws: an injected internal error closes it cleanly and the session ends
  with a real error message, not "Claude Code process aborted by user".

## M7 — The question/answer bridge

Runner's `canUseTool` adapter (§5.1), the `QuestionBridge` client with a stub provider until
orchestrator lands, `AskUserQuestion` answer round-tripping, the tool-gate allow/deny path, the
hold → park → auto-resume sequence (§5.4), expiry, and the `dontAsk` diagnostic (§5.6).

**Acceptance**
- An agent calling `AskUserQuestion` produces one `session.question.raised` event and one `questions`
  row; answering within the hold window resolves `canUseTool` with `{behavior:'allow', updatedInput:
  {questions, answers}}` and the agent continues **in the same turn** — proven by the transcript
  showing no intervening `result`.
- A tool call matching an `ask` rule raises a question; Allow-once continues with the input echoed
  unchanged, Deny returns the user's reason and the transcript records the denial.
- The card offers only Allow-once and Deny; no code path sets `updatedPermissions`.
- Letting the hold expire parks the session: `paused` / `awaiting_answer`, slot released, lease kept,
  question still `open`, and the denial message instructs the agent to stop. The agent does not
  attempt a workaround in the remaining turn.
- Answering a parked question auto-re-queues the session at `interactive` priority, resumes with
  `resume`, injects the answer message, and emits `session.question.answered` with
  `delivery: 'after-park'`. The work is not run twice.
- An unanswered question past `question.expireHours` marks the question `expired` and the session
  `interrupted` / `question_expired`.
- A session whose compiled mode is `dontAsk` emits a `session.diagnostic`, reports
  `questionBridge: 'disabled'` on `session.started`, and runner does **not** alter the mode.
- With the orchestrator provider absent, the fallback writes the `questions` row through foundation's
  repository and resolves on `question.answered`; a core restart between raise and answer still
  delivers (the session is parked by then, and resumes).
- No `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` process warning is emitted during the suite.

## M8 — Budget halt

Detect the `assignments.token_budget` crossing inside the metering transaction, pause the session
with `budget_halt`, raise the question, emit `assignment.budget.exceeded`, and resume on an answer
that raises the budget (§7.2).

**Acceptance**
- A session under an assignment with a small `token_budget` pauses within one turn of crossing it —
  not several turns later.
- The pause, the `budget_halt` question, and the event all reference the same assignment and session,
  and the question names the budget and the overshoot.
- Raising the budget through orchestrator resumes the parked session; closing the assignment instead
  leaves it `interrupted` and releases the lease.
- A `null` `token_budget` never halts anything.
- The SDK's own `maxBudgetUsd` trip is independent and lands `failed` / `max_budget_usd`.

## M9 — Crash recovery, orphan detection, and graceful shutdown

The boot task of §9.2, the shutdown sequence of §9.1, and the two resume paths of §9.4 including
`POST /api/sessions/:id/continue` and the resumability preconditions of §9.3.

**Acceptance**
- Hard-killing the core mid-session and restarting moves that session to `orphaned` / `core_restart`,
  appends `session.end` to its transcript, reconciles `transcript_bytes` from `fs.stat`, and emits
  `session.orphaned` with `resumable` correctly set.
- `orphaned` is terminal: no API call moves it to another status.
- `Continue` on an orphaned session creates a **new** row with `resumed_from`, a new transcript, and a
  first message stating what was interrupted; the resumed agent demonstrably retains the prior
  conversation.
- `resumable: false` — and no Continue action — when `sdk_session_id` is null, when the lease path no
  longer exists, or when the SDK session file is missing.
- A last transcript pair of `tool_use` with no `tool_result` is detected and stated in the resume
  message.
- Queued sessions survive a restart and are re-admitted; one older than `queueStaleHours` becomes
  `interrupted` / `stale_queue`.
- Paused sessions survive a restart unchanged and are not auto-resumed.
- Graceful shutdown pauses every running session within `service.shutdownGraceSeconds`, leaves no
  orphaned subprocess, and a session that ignores the interrupt lands `interrupted` /
  `shutdown_forced` rather than hanging the process.
- Leases for assignments no longer `open` are released on boot; re-acquiring for a still-open
  assignment does not double-lease.

## M10 — Events, session API, and MCP/diagnostic surfacing

The full §10 event table with its persist flags, the §11.1 routes, the §11.2 registry service,
`GET /api/sessions/:id/stream`, and MCP server status via `Query.mcpServerStatus()` with `needs-auth`
raised as an actionable diagnostic (roster §10).

**Acceptance**
- Every event in §10 is emitted at the right moment with the documented payload, and `ids` is fully
  populated on all of them.
- Only the ✔ events reach the `events` table: a session producing hundreds of deltas and tool calls
  adds a single-digit number of `events` rows.
- A client reconnecting after a dropped connection replays persisted events from `/api/events?since=`
  and tails the transcript from its byte offset with no gap and no duplicate.
- A session using an MCP server that reports `needs-auth` emits `session.diagnostic` and
  `runner.mcp.status` carrying roster's vocabulary unchanged, and the session is not failed for it.
- Non-fatal compile diagnostics appear on `session.started` and in the transcript header; the plugin
  and skills assertion of roster §7.1 (requested plugins and skills actually present in the `init`
  message) raises a diagnostic when it fails.
- The message handler tolerates an unknown SDK message type without failing the session — verified by
  injecting a synthetic message type.

## M11 — Usage windows and plan-window honesty

Rolling 5-hour and 7-day sums over `usage_events`, opportunistic `rate_limit_event` capture into
`settings`, the observed rate-limit state, and `GET /api/runner/usage` with its `source` labels
(§7.4).

**Acceptance**
- The 5-hour and 7-day windows are computed by indexed queries over `usage_events` and stay correct
  across a restart.
- The response carries `source: 'local-estimate'` and the disclaimer string; no field in the payload
  can be read as "plan remaining".
- A `rate_limit_event`, if the CLI emits one, is parsed permissively into
  `settings['runner.rateLimit.lastEvent']`; a synthetic event with unexpected fields is stored
  without throwing, and **no scheduling decision changes** as a result of its contents.
- Removing `rate_limit_event` handling entirely leaves scheduling behaviour identical — asserted by
  running M5's cool-down suite with the handler disabled.

## M12 — End-to-end acceptance

Wire runner into the UI's launch flow and orchestrator's assignment path, and validate the scenarios
this element exists for.

**Acceptance**
- **Solo launch**: drag-and-drop → assignment → session → live streamed output → completion, with the
  project timeline showing the assignment, the session, its summary, and its token split.
- **Concurrent pair**: an architect/skeptic assignment runs two sessions against one project at
  `maxConcurrent: 2`; a third launch queues and starts when one finishes; the queue panel shows all
  three states correctly throughout.
- **Steer**: a running agent is redirected mid-turn from the session view and visibly changes course
  in the next assistant message.
- **Inline question**: an agent asks via `AskUserQuestion`, the card appears in the inbox, the user
  answers **from the tailnet browser**, and the agent continues in the same turn with
  `answered_via: 'remote'` recorded.
- **Parked question**: the same flow with the answer delayed past `question.holdMs` — the session
  parks, frees its slot for a queued session, then auto-resumes on the answer and completes. The work
  is done once.
- **Restart mid-session**: killing the core during a running session and restarting yields exactly
  one `orphaned` session with an intact partial transcript, a Continue action that resumes the
  conversation into a new session, and no double-counted tokens.
- **Budget halt**: an assignment exceeding its token budget halts within a turn, raises the card, and
  resumes on a raised budget.
- **Work edition**: the same suite passes with `edition: work`, `maxConcurrent: 1`, `auth.mode: env`,
  and no non-loopback listener.
