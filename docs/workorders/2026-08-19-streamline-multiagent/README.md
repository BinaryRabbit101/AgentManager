# Work orders — streamline multi-agent assignments (2026-08-19)

## Why this exists

The product's north star, in the owner's words: **assign multiple agents to work a task on a
project without needing multiple VS Code windows or many Claude CLIs in terminals.** A real pair
run on 2026-08-19 (assignment `01M0B8BH8WQ016VGRZV7M741E6`, Merritt architect / Dana skeptic,
goal: improve the Site Telemetry page) showed how far the current build is from that, and each
failure is reproducible from the code alone:

1. **The drafter burned round 1 without producing the artifact.** Merritt reported without
   writing anything at `scope.artifactPath` (clean `git status`). The engine planned the critic
   anyway — `pairPattern.plan()` never checks that an artifact exists before spending the
   critic's turn (`src/modules/orchestrator/patterns.ts`, drafter-reported branch). Dana's whole
   248-second turn was "I can't find the artifact."
2. **The assignment then stalled silently.** Dana reported `revise`; the engine should have
   planned Merritt round 2. Nothing appeared. The engine only advances on four events
   (`engine.ts attach()`: `assignment.created`, `session.ended`, `question.answered`,
   `assignment.closed`). If the post-report advance fails at launch (`launch()` marks the turn
   `failed` and returns idle — `engine.ts` ~line 610) or a plan returns `wait` that no future
   event re-triggers, **nothing ever advances again**. The only backstop is the staleness sweep,
   whose threshold is `assignment.maxAgeHours: 24` — and it *halts*, it never retries. The user
   watches a "running" assignment do nothing, for up to a day.
3. **Messaging looked broken while working as designed.** Dana's mid-turn question to Merritt was
   labelled "never seen by the recipient" while the assignment was still running and delivery at
   Merritt's next launch was still possible (`web/src/assignments/conversation.ts` renders
   `undelivered` and `undeliverable` identically). And Dana wasted turn-time expecting a mid-turn
   reply, which the sequential driver can never produce — the prompts don't tell agents how the
   mailbox actually behaves.
4. **Permission gates interrupt every run.** Two "Allow the agent to use Bash?" cards had to be
   answered mid-flight. The plumbing to do better exists (`POST /agents/:id/validate` dry-run
   permission preview; the "Always allow" gate memory, commit `2c32a5e`) but the Start-work flow
   doesn't use it to pre-answer the obvious gates.
5. **The round header misleads.** "Round 0 of 3" while round 1 is in flight — `rounds_used`
   increments only when the critic reports, and the UI prints it raw.

## The work orders

| # | Doc | Element(s) | Depends on |
|---|-----|-----------|------------|
| WO1 | `WO1-engine-self-healing.md` | orchestrator | — |
| WO2 | `WO2-pair-artifact-guard.md` | orchestrator, ui | — |
| WO3 | `WO3-messaging-clarity.md` | orchestrator, ui | — |
| WO4 | `WO4-frictionless-start.md` | ui, orchestrator, roster, runner | WO2 (artifact default) |
| WO5 | `WO5-task-templates.md` | roster, orchestrator, ui | WO4 (start flow) |
| WO6 | `WO6-oauth-connectors.md` | roster, foundation, runner, orchestrator, ui | WO4 (preflight surface) |
| WO7 | `WO7-token-economy.md` | orchestrator, roster, ui | — |

WO1–WO3 are independent and can run in parallel worktrees. WO4 builds on WO2's artifact
defaulting; WO5 builds on WO4's start flow.

## Rules for every implementing agent

- Conform to `docs/architecture.md` D1–D6. Nothing here forks an edition (D6), adds a second
  frontend (D3), or moves orchestration out of the app (D4).
- Each WO names the element DESIGN.md sections it amends. **Update the design doc in the same
  change as the code** — a WO is an instruction to amend the spec, not to diverge from it.
- Tests are part of the deliverable. Each WO lists its acceptance tests; the existing suites
  (`vitest`, `--project server` and web) must stay green.
- Keep to the WO's scope. If a WO conflicts with something you find in the code, stop and report
  rather than improvising.
