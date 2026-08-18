# Orchestrator — Implementation

Ordered milestones for [DESIGN.md](DESIGN.md). Staged so the v1 slice ships early and each milestone
leaves the system in a working state.

**Sequencing constraint that shapes everything.** Runner has no launch path without this module
(runner §14 D9: `assignmentId` is required and runner never mints one). So M1 and M2 are not
"orchestrator features" — they are the unblock for every other element's end-to-end path, and they
ship before anything collaborative. M6 is the headline v1 slice.

Dependencies assumed complete: foundation M1–M4 (storage, config, secrets, module system, bus),
roster (registry, `compileSession`, `capabilities.overseer`), projects (registry, leases,
launch context), runner (`RunnerService`, session lifecycle, metering).

Each milestone lists **acceptance criteria** that are testable without the UI, because the UI is
wave 4 and none of this may wait for it.

---

## M0 — SDK verification and module skeleton

Small, first, and gating: the assumptions in DESIGN §0 must be facts before M5 depends on them.

1. Register the `orchestrator` module (`dependsOn: ['storage', 'roster', 'projects']`) under
   foundation's module contract; it is **non-critical** (foundation §6.2 — a broken orchestrator must
   not stop the service booting).
2. Contribute the `orchestrator.*` config sub-schema (DESIGN §12) and its defaults.
3. Ship `migrations/orchestrator/0001_orchestrator.sql` (DESIGN §2.1): the `assignments` /
   `assignment_members` column additions, `assignment_turns` with both indexes, `message_reads`.
4. Write a throwaway SDK probe (not shipped) that answers **[A1]–[A5]**: mount a
   `createSdkMcpServer` instance under key `agentmanager` with one echo tool; confirm the model sees
   `mcp__agentmanager__echo`; confirm the handler's `extra` carries no session identity; time how long
   a handler may block before the CLI cancels; confirm an error result reaches the model as text;
   confirm an in-process instance and an stdio integration coexist in one `mcpServers` record.

**Acceptance**: the module starts, stops and reports health; migrations apply and re-apply cleanly on
a fresh and an existing DB; a written record of the five assumptions with the observed answer, and —
if [A3]'s timeout is shorter than `runner.question.holdMs` — the shortened hold value chosen and
recorded before M5 begins.

---

## M1 — Assignments and the solo path (unblocks runner)

1. `AssignmentRepository` on top of foundation's store: create, read, list, close, budget mutation.
   No other element writes these tables.
2. `createAssignment()` with the full §9 validator as a **pure function** over its inputs, returning
   named refusals and `warnings[]`. Table-driven tests, one case per rule.
3. `createSolo()` (DESIGN §2.3 path 1): create the assignment, then `RunnerService.startSession`,
   returning `{ assignmentId, sessionId }`.
4. `getAssignmentContext()` in runner §15.1-3's exact shape, including `scopeRules` emission
   (DESIGN §2.5) and `write`.
5. `closeAssignment()`: cancel open questions, stop live sessions, emit **`assignment.closed`**.
5b. Work-item linking (DESIGN §2.3): `workItemIds?` on `createSolo` and `CreateAssignmentRequest`,
   calling `projects.linkWorkItems(assignmentId, ids)` on create and `projects.unlinkWorkItems(id)`
   on close. Orchestrator is the only writer of `work_item_assignments` (projects §1.5) and never
   writes a work-item status itself.
6. Boot task: close assignments whose project is archived; reconcile `phase` for assignments whose
   sessions all reached a terminal status while the core was down.
7. Routes: `POST /api/assignments`, `POST /api/assignments/solo`, `GET /api/assignments`,
   `GET /api/assignments/:id`, `PATCH`, `POST /:id/close`.
8. Events: `assignment.created`, `assignment.started`, `assignment.closed`.

**Acceptance**
- A drag-and-drop-equivalent API call (`POST /api/assignments/solo`) starts a real session end to end
  and the session reaches `done`; `sessions.assignment_id` resolves to the created row.
- Runner's launch chain step 3 (`getAssignmentContext`) succeeds; a session on a closed assignment is
  refused before a row is created.
- Runner releases the workspace lease on `assignment.closed` (observed via
  `workspace.released`).
- A solo launch carrying `workItemIds` produces an assignment whose `work_item_assignments` rows
  resolve, and the linked item flips to `in_progress`; closing the assignment unlinks it and the item
  returns to `open`. An id from another project is refused by name and creates nothing.
- Every §9 rule has a test that refuses with its own named code; no rule is enforced in two places.
- Restarting the core mid-session leaves the assignment consistent (no orphan `phase: running` with
  no live session).

---

## M2 — QuestionBridge, the inbox, and recommendations (unblocks runner's escalation and ui)

1. Implement `QuestionBridge.ask()` / `cancel()` exactly as runner §5.2 types them; publish on the
   service registry as part of the `orchestrator` API.
2. Persist to `questions` + `question_recommendations`; resolve the promise from the answer path;
   record `answered_via` from foundation's request origin.
3. The stance ladder (DESIGN §6.2) as a closed enum with a validator; `disagreement` / `contested`
   computed server-side on read.
4. Join-on-match consolidation (DESIGN §6.3) with `joinWindowMs`, exact normalised prompt equality
   and equal option sets.
5. Expiry rules (DESIGN §6.5), including approval-gate-expiry-is-denial. A boot sweep expires
   questions that aged out while the core was down.
6. Routes: `GET /api/questions`, `GET /api/questions/:id`, `POST /api/questions/:id/answer`.
7. Events: `assignment.question.raised`, `assignment.question.answered`.

**Acceptance**
- An agent calling the built-in `AskUserQuestion` produces a card; answering it within runner's hold
  delivers the answer **inline** and the session continues (verified in the transcript: the tool
  result follows the answer with no intervening turn).
- Answering after the hold resumes the parked session automatically, driven entirely by runner — with
  orchestrator issuing no relaunch of its own (runner §15.1-7).
- A restart with an open question leaves it answerable. The `ask()` promise itself does **not** survive
  the restart — the process that held it is gone — so the acceptance is stated in terms of the row: the
  `questions` row is the trigger, answering it emits `question.answered`, and the session parked
  `awaiting_answer` resumes from that event via runner's boot re-subscription (runner §9.2). A session
  that died in the meantime gets `cancel()` and the row is closed, not left dangling.
- Two asks with identical normalised prompts inside the window produce **one** card with two
  recommendation rows and one answer that resolves both.
- With `modules.orchestrator.enabled: false`, runner's degraded fallback still writes a question row
  and resolves on the bus event (runner §5.2) — verified, not assumed.

---

## M3 — Budgets, round caps, and the halt card

1. Consume runner's `assignment.budget.exceeded`; set `phase: awaiting_user`; render the halt card
   with the three options (DESIGN §7.3).
2. Implement the **mutate-then-resolve** ordering rule and test it explicitly against the race:
   raising the budget must be visible to runner's auto-resume; closing must make the resumed session
   fail admission.
3. Budget defaults per creation path (DESIGN §7.2), the mandatory-budget rule for machine-created
   assignments, and the parent-remainder arithmetic (budget minus used minus open children).
4. The projection check with `turnEstimateTokens`; warning for user-created, refusal for
   machine-created.
5. Round-cap storage and `rounds_used` accounting (the engine increments it in M5; the plumbing and
   the API exposure land here).
6. Events: `assignment.budget.raised`.

**Acceptance**
- A solo assignment with a deliberately tiny budget halts mid-session, produces a `budget_halt` card,
  and resumes correctly on *Raise budget* and terminates correctly on *Close assignment*.
- *Continue once* grants exactly one overdraft; the next crossing asks again.
- A raise beyond `raiseMaxFactor` requires and creates its own approval gate.
- `tokens_used` in the card always matches `session_usage` totals for the assignment's sessions
  (runner's arithmetic is consumed, never re-derived).

---

## M4 — Mailboxes and the in-process MCP server

1. `MessageRepository`: send, mailbox query, mark-read, broadcast reads via `message_reads`,
   undeliverable marking at assignment close.
2. `getSessionToolset(launch)` building a per-launch `createSdkMcpServer` instance closing over the
   `LaunchIdentity` (DESIGN §4.1).
3. All six tools with zod schemas exactly as DESIGN §4.3 specifies, the `scopeOf()` check on every
   scoped tool, structured named refusals, and the per-session call caps.
4. Wire R1 (resolved, roster §13): roster's `compileSession` mounts the instance at
   `options.mcpServers.agentmanager` via `ctx.require('orchestrator')?.getSessionToolset(...)`. Never a
   runner-side mutation of `mcpServers`, which would violate runner §3.3.
5. Wire R1b (resolved, roster §11): roster grants workers the four scoped tools —
   `send_to_agent`, `read_mailbox`, `report_status`, `request_user_decision` — and overseers all six.
6. `request_user_decision`'s hold-then-instruct behaviour (DESIGN §4.4), sharing runner's
   `question.holdMs` rather than a duplicate config key.
7. Prompt-time mail inlining helper (bounded by `mailbox.inlineMax` / `inlineMaxBytes`), used by M5.

**Acceptance**
- An overseer agent lists the roster and creates a child assignment; the returned ids resolve.
- A **worker** agent's `send_to_agent` to an agent outside its assignment is refused with
  `agent_not_in_assignment` and the refusal text reaches the model (per [A4]); the same call to a
  co-member succeeds.
- `read_mailbox` from a worker never returns a message from another assignment — tested with two
  concurrent assignments sharing one agent.
- Exceeding `messagesPerTurn` refuses the call and trips the breaker counter.
- With `modules.orchestrator.enabled: false`, roster drops every `mcp__agentmanager__*` rule with its
  diagnostic and no server is mounted (roster §11) — verified end to end.
- `request_user_decision` answered inside the hold returns the answer as the tool result; past the
  hold it returns the stop instruction and the session ends `done`, not `paused`.

---

## M5 — The pattern engine

1. `PatternDef` / `AssignmentState` / `plan()` types (DESIGN §3.1); the registry of patterns;
   `GET /api/patterns`.
2. The engine: per-assignment async mutex, reload-from-DB, breaker evaluation hook (a no-op stub
   until M7), `plan()` dispatch, turn-row insert guarded by `assignment_turns_active`,
   `startSession` / `continueFrom` dispatch.
3. Bus subscriptions: `session.ended` (turn completion + `permission_denials` capture),
   `session.message` (bounded output capture), `assignment.question.answered` (re-plan a blocked
   seat), `assignment.budget.exceeded`.
4. Prompt composition (DESIGN §3.2) with all seven sections and the byte cap.
5. Boot task: for every `open` assignment with a driver, reconcile turns whose sessions are
   `orphaned` (mark the turn `failed`) or `paused` (leave, the question drives it) and re-enter the
   loop.
6. `solo` registered with `driver: 'none'` — proving the abstraction rather than special-casing it.

**Acceptance**
- `plan()` is pure: a table-driven suite feeds turn-row fixtures and asserts the next plan, with no
  database or runner in the test.
- Killing the core mid-round and restarting resumes at the correct next turn exactly once — the
  partial unique index refuses a duplicate planned turn.
- A seat's second turn uses `continueFrom` and the resulting session carries `resumed_from` and the
  seat's prior SDK conversation.
- A solo assignment runs through the engine unchanged (driver `none` plans nothing after the first
  session).

---

## M6 — The adversarial pair (the v1 slice)

1. The `pair` pattern definition: two seats (`drafter`: `architect | implementer`, `critic`:
   `skeptic`), `requires.artifactPath`, `roundCap` defaults and bounds, seat order for card sorting.
2. `plan()` implementing DESIGN §3.3's table exactly, including the retry-once-on-unstructured rule
   and artifact-hash capture.
3. Convergence: `verdict.decision === 'accept'` **and** empty `blocking`; anything else is `revise`.
4. Termination cards: the informational completion card on `converged`, the three-option question
   card on `round_cap`.
5. Stance solicitation in the prompt's *Open decisions* section (DESIGN §6.4), with the join window
   waived for a solicited stance.
6. `GET /api/assignments/:id/conversation` (DESIGN §11.2) — enough for a human to read the
   collaboration through the API before the UI exists.
7. Events: `assignment.turn.started|reported|ended`, `assignment.round.completed`.

**Acceptance** — the milestone is done when this scenario passes end to end on a real project:

> An architect and a skeptic are assigned to write `docs/<x>/DESIGN.md` with a 3-round cap and a
> 400 k budget. The architect drafts the file; the skeptic critiques it with blocking issues; the
> architect revises; the skeptic accepts. The assignment closes `converged`, the file exists, the
> conversation endpoint renders six turns and the handoffs in order, `tokens_used` is under budget,
> and the whole run needed **no** user interaction.

Plus:
- A skeptic that never accepts hits the round cap and produces the three-option card; choosing *Run 1
  more round* runs exactly one more and re-terminates.
- A skeptic that reports `accept` **with** blocking issues does **not** converge.
- A drafter that re-submits an unchanged artifact halts `no_progress`.
- Restarting the core between the drafter's and the critic's turn loses nothing.

---

## M7 — Guardrails: circuit breakers and approval gates

1. All eight breakers (DESIGN §8.1) as counters **re-derived from `assignment_turns` on every
   evaluation**, wired into the engine's pre-`plan()` hook.
2. `phase: halted` + `halt_reason` + exactly one card per halt; `POST /api/assignments/:id/advance`
   as the resume-after-halt path.
3. The five approval gates (DESIGN §8.2), including the write-capable `create_assignment` gate that
   blocks the first turn until approved, and the scope-overlap gate.
4. Scope-overlap detection at creation plus the `project.scope.overlap` subscription; the
   `assignment.conflict` event.
5. The staleness sweep as a periodic task.

**Acceptance**
- Each breaker has a test that trips it deterministically and asserts exactly one card, one
  `assignment.halted` event, and no further turns planned.
- A halt does **not** kill a running session (except `tool_flood`, which does and is tested).
- An overseer creating a `write: true` assignment starts no session until the gate is approved;
  denying it closes the assignment `gate_denied`; letting it expire closes it `gate_expired`.
- Two overlapping write-capable assignments produce a gate; two overlapping read-only ones produce
  nothing.

---

## M8 — Notifications

1. A `Notifier` with an `ntfy` channel: one outbound POST carrying title, body and the tailnet link;
   the topic URL resolved from `notify.topicSecretRef` through `SecretResolver`.
2. Trigger rules (DESIGN §10): fire at `notify.afterMs` for questions still open and meeting
   `minLevel`; one notification per question; `maxPerHour` with a digest for suppressed ones.
3. Failure handling: a failed send is logged and surfaced in `/api/health` as a degraded capability —
   never retried into a loop, and never blocking the question.
4. Config/secret wiring per R5, including the work-edition default of `enabled: false`.
5. Event: `orchestrator.notify.sent`.

**Acceptance**
- An approval gate left open for `afterMs` produces exactly one notification containing a link that
  opens the card over the tailnet.
- Answering inside `afterMs` produces none.
- `enabled: false` (work edition) sends nothing and logs nothing beyond one boot-time info line.
- A misconfigured or unreachable topic degrades: the question is still raised, answerable and
  visible; health shows the degraded channel.

---

## M9 — Status aggregation and UI-facing polish

1. `GET /api/orchestrator/status` (DESIGN §11.3), joined through foundation's repositories only.
2. Conversation-view completeness: `delivery` labelling for messages, undeliverable marking at close,
   question entries with recommendations inline.
3. Card ordering, `disagreement` / `contested` flags, and attribution on every recommendation
   (DESIGN §16-1/2) exercised by fixtures covering: one recommendation, two agreeing, two disagreeing,
   one `blocking` against one `lean`.
4. `GET /api/patterns` enriched for the create dialog: seats, allowed roles, defaults,
   `preferredTier`, and the candidate-ranking payload.
5. Event replay verification: a client reconnecting with `?since=` reconstructs an assignment's
   lifecycle from the persisted `assignment.*` events plus the conversation endpoint.

**Acceptance**
- The fleet status endpoint reports every agent's state correctly across a live mix of solo and pair
  assignments, including `awaiting_user` and `halted`.
- Disagreement and contested flags match the fixture matrix exactly; no numeric confidence appears
  anywhere in any payload.
- A simulated reconnect replays a full pair run with no gaps in rounds, turns or questions.

---

## M10 — The overseer pattern (**complete**)

Three or more agents on one goal, on one project: an `overseer`-led assignment whose lead decomposes
the goal into child assignments and verifies what they produce (DESIGN §3.5). Promoted from §3.4's
sketch; the review-loop sketch stays deferred.

1. `OVERSEER_PATTERN` in `patterns.ts`, registered in `PATTERNS`: one `lead` seat (`write: false`),
   `requires: { roundCap, tokenBudget }`, and §3.5's turn table — decompose, wait while any child is
   open, review each batch of finished children, converge on a structured `accept`, halt
   `review_unresolved` on a revision nobody was given. §3.3's three seat-agnostic rows (blocked,
   unstructured, failed) refactored into one implementation both sequential patterns call.
2. Creation: `POST /api/assignments` with `pattern: 'overseer'` validates (`SUPPORTED_PATTERNS`
   widened); a non-null `tokenBudget` is required (§7.2) and the round cap defaults from
   `patterns.overseer.roundCap`; a second seat is refused `seat_not_in_pattern`.
3. The child of an overseer: `create_assignment` still mints only `solo | pair`, the child's budget
   is debited from the parent's remainder, `parent_assignment_id` is set, and a `write: true` child
   is parked at `phase: planned` behind §8.2-1's gate. A machine-created **`solo`** is driven as
   exactly one turn (`planChildSolo`) — launch, wait, close — because nothing else starts it, gives
   it a turn row to report against, or closes it for the parent to review.
4. Cadence: `assignment.closed` on a child advances its parent; the review prompt carries each
   finished child's report **and** artifact path with the instruction to read the file before
   accepting. Children run concurrently (each is its own assignment with its own loop, bounded by
   runner's cap of 2); the parent reviews them in batches — one lead turn per wave.
5. The budget tree (DESIGN §7.5): reservations bound *creation* (open children's budgets **plus what
   closed children spent**, so a remainder never heals), actual spend bounds *running* (the parent's
   `budget` breaker reads `tokens_used + Σ children`). Runner stays the only writer of any
   `tokens_used`.
6. Projections: `children` (id, goal, pattern, status, phase, closeReason, haltReason, artifactPath,
   write, budget, tokens, members) and `childTokensUsed` on `GET /api/assignments/:id` **and** on the
   conversation view, oldest first.
7. **Owner decision, 2026-08-18** — capabilities are ranking hints, never gates: `role_not_declared`
   and `lead_not_overseer` became warnings, `GET /api/patterns`'s candidate list ranks instead of
   filtering (`declaresRole` per candidate), and the coordinator toolset is granted by the **lead
   seat**, with roster compiling its allow rules from the names the instance mounted.

**Acceptance**
- A user creates an `overseer` assignment with a lead and a budget; the engine plans the lead's
  decomposition turn, and the composed prompt names `create_assignment` and `list_roster`.
- The lead mints two children through the real toolset; both carry `parent_assignment_id`,
  `created_by: overseer:<id>` and their own budgets, and a `solo` child's single turn starts.
- A child's budget larger than the parent's remainder is refused `budget_exceeds_parent` — before and
  after an earlier child closed, so a closed child's spend still counts.
- A `write: true` child holds no session and no turn row until the gate is approved; denying it
  closes the child `gate_denied` and leaves the parent open.
- When every child has closed, the parent's next turn is a review round whose prompt carries each
  child's id, report headline and artifact path; the lead's `accept` with an empty blocking list
  closes the assignment `converged` with `phase: converged`.
- A `revise` verdict with no follow-up child halts `review_unresolved` with exactly one card and one
  `assignment.halted` event; *Continue anyway* runs one more review round, bounded by the cap.
- A child exhausting its own budget parks the **child** at `awaiting_user` and the parent keeps
  planning; the parent parks only when `tokens_used + Σ children` crosses its own budget.
- `GET /api/assignments/:id` carries the children and `childTokensUsed`; it is empty for a solo.
- Closing the parent closes its still-open children `user_closed` (never `converged`).
- A lead with no `capabilities.overseer` is created with a warning, runs, and is mounted all six
  tools; the same agent in a worker seat is mounted four.
- `GET /api/patterns` offers every agent for every seat, role-declaring ones first, each labelled
  `declaresRole`.

---

## Not in v1

The `review` pattern, parallel turns within one assignment, per-child review the moment a child
closes, nesting deeper than one level, declared per-seat model overrides, mail pushed into live
sessions, semantic question de-duplication, and the remaining notification channels — all with their
rationale and unblocking conditions in DESIGN §18. Nothing in M1–M10 may be shaped around them beyond
the extension points already named (`PatternDef.driver`, `AssignmentContext`, `Notifier.channel`).
