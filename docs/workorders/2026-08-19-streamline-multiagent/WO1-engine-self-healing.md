# WO1 — The engine must never stall silently

**Element:** orchestrator. **Amends:** `docs/orchestrator/DESIGN.md` §3.1 (the loop), §8.1
(breakers — `stale`), §11.1 (advance). Update `IMPLEMENTATION.md` with a new milestone entry.

## The defect

`advance()` runs only on four bus events (`engine.ts`, `attach()`). Three dead-ends exist where an
**open, `phase: running`** assignment has no planned/running turn and no future event will ever
fire for it:

1. **Launch failure.** `launch()` catches a `startSession`/`continueFrom` error, marks the turn
   `failed`, logs a warning, returns `{ kind: 'idle', reason: 'launch_failed' }` — and nothing
   re-advances. The pattern's retry rule (`unfinishedTurn`, `patterns.ts` ~line 932: one retry,
   then `turn_failures` halt) is correct but unreachable until something calls `advance()` again.
2. **`awaiting_answer` with a stale answer.** `answeredOrWait()` (`patterns.ts` ~line 943)
   returns `wait` when the latest decision's `answeredAt` predates the turn's `endedAt`. If the
   blocked seat died without raising a fresh question, no `question.answered` will ever arrive.
3. **A missed `session.ended`** (crash between session end and event handling — `reconcileOnBoot`
   covers restarts, but nothing covers a dropped event in a live process).

The only backstop, `sweepStale()`, fires at `assignment.maxAgeHours` (**24 h**) and **halts** —
it never retries. Observed effect: a pair sits at "running" doing nothing, indefinitely, with no
card and no timeline entry.

## The fix

### 1. A recovery pass in the periodic sweep

In the sweep driven by `module.ts` (~line 355), before the staleness check, add: for every open
assignment whose phase is `running` with **no** turn in `planned`/`running`, and whose last turn
transition is older than a new config knob `orchestrator.assignment.recoverAfterMinutes`
(default **2**), call `advance()`. Log at `info` with a distinct message. The stale *halt*
remains, unchanged, for assignments that keep failing to move (`maxAgeHours`).

- The existing breaker protections make this safe to re-run: `turn_failures` halts after two
  consecutive failed turns, so the recovery pass cannot spin a broken launch forever.
- Add the knob to `config.ts` (schema + default) and to DESIGN §14's config table.

### 2. Re-advance promptly after a launch failure

In `launch()`'s catch: after `turns.complete(turn.id, { status: 'failed' })`, schedule a one-shot
delayed `advance(assignmentId)` via the injectable `timers` (30 s). This gives transient runner
errors (queue full, SDK hiccup) a fast retry instead of waiting for the sweep. Keep the sweep as
the belt to this suspender.

### 3. Escape the `awaiting_answer` dead-end

In `answeredOrWait()`: when the answer is stale **and** no open question exists for the
assignment (expose the existing inbox query through `AssignmentState` — plan stays pure), return
`retryPlan(...)` for the same seat/round instead of `wait`. The re-planned turn re-raises its
question or completes; `unstructured`/`turn_failures` counters still bound it. Record `retryOf`.

### 4. Make failures visible

- On `launch_failed`, in addition to the log line, ensure the failed turn renders in the
  assignment timeline (check `web/src/assignments/` renders `status: 'failed'` turn rows with the
  failure reason; add if missing).
- Emit the already-existing `assignment.turn.ended` with `exitReason: 'launch_failed'` (done
  today) **and** verify the UI's conversation merge shows it.

## Acceptance tests

- `engine.test.ts`: a `startSession` that rejects → turn `failed` → the scheduled retry advances
  and the second launch succeeds; two consecutive rejections → `turn_failures` halt with card.
- `engine.test.ts` (sweep): open running assignment, no live turn, last transition > recover
  threshold → sweep calls advance and a turn is planned; the same assignment with a fresh
  transition is left alone; a genuinely stale one still halts at `maxAgeHours`.
- `patterns.test.ts`: blocked turn + stale answer + no open question → retry plan with `retryOf`;
  blocked turn + open unanswered question → still waits.
- Web: a `failed` turn row renders in the timeline with its exit reason.
