# WO4 — Start work in one gesture: preflight the gates, default the prerequisites

**Elements:** ui (Start-work flow), orchestrator (creation), roster (validate/permissions),
runner (gate consumption). **Amends:** ui DESIGN's Start-work section; orchestrator `DESIGN.md`
§2 (creation inputs) and §6 (questions); roster `DESIGN.md` §6/§9.1 where the dry-run compile is
specified. **Depends on WO2** (artifact guard exists before we default the path).

## The goal (owner's words)

> "Easily assign multiple agents to work a task on a project without the need of multiple VS Code
> windows open, or many Claude CLIs via cmd."
> "We really need to find a way to streamline these without so many filters and prerequisites."

In the observed run the user had to answer two mid-flight "Allow the agent to use Bash?" cards
and supply pattern prerequisites by hand. Every mid-run question is a stall (the session pauses
until answered) and a trip to the machine. The plumbing to fix this exists:

- `POST /api/roster/agents/:id/validate` — the dry-run permission compile behind the launch
  flow's permission preview (roster DESIGN §9.1).
- "Always allow on tool gates" (commit `2c32a5e`) — a gate answered once is remembered through
  roster.
- The one Start-work flow (commit `fbe2436`) — pick a project, pick any agents, describe the task.

## The fix

### 1. Permission preflight in the Start-work dialog (ui + roster)

When agents and a project are selected, call `validate` for each seat with the assignment's
posture (write/read). Render the tools that **would gate at runtime** (Bash first among them) as
a short chip list per agent with a toggle: **"Pre-allow for this assignment"** — default ON for
tools the same agent was previously allowed on this project (read the Always-allow memory),
default OFF otherwise. One extra second in the dialog instead of N stalls mid-run.

### 2. Assignment-scoped pre-grants (orchestrator + runner)

Creation (`POST /api/assignments`) accepts a new optional `preGrants: { agentId, tool }[]`.
Orchestrator stores them on the assignment (new table or JSON column per foundation's storage
decisions — follow foundation, don't invent). Runner consults them at gate time exactly where it
consults the Always-allow memory today: a pre-granted tool for that agent **in that assignment**
proceeds without a card. Scope is the assignment, not the roster — this is narrower than
Always-allow, deliberately: it expires with the assignment and never widens the agent's baseline
(roster's `compilePermissions` remains the sole composer; a pre-grant can only pre-answer a gate
the compiled permissions would have raised, never add capability).

### 3. Default every pair prerequisite (ui + orchestrator)

- **artifactPath**: prefill `docs/assignments/<assignment-slug>/DRAFT.md` (slug from the goal's
  first words + short id). Editable, never empty-blocking. Orchestrator accepts it as today.
- **roundCap / tokenBudget**: already defaulted in config (3 / 400k) — ensure the dialog shows
  them as filled-in values that can be expanded, not as required fields.
- The minimal path must be: **pick project → tick agents → type the task → Start.** Everything
  else is a visible default behind one "options" disclosure.

### 4. Surface the mid-run questions that remain

Any gate that still fires mid-run (a tool nobody predicted) stays a question card — unchanged.
This WO removes the *predictable* ones only.

## Acceptance tests

- Roster/routes: `validate` response enumerates gate-liable tools per agent (extend if it does
  not already).
- Orchestrator: creation persists `preGrants`; the assignment view returns them; a pre-grant for
  agent A does not apply to agent B or to another assignment.
- Runner: a gated call with a matching pre-grant proceeds with no question card and is recorded
  in the transcript/timeline as pre-allowed; without one, the card fires as today.
- Web: Start-work with two agents shows per-agent gate chips after validate resolves; toggling
  writes `preGrants` into the create call; the dialog submits with nothing but project + agents +
  goal filled by the user.

## Addendum (2026-08-19, owner report): denials are invisible and quietly fatal

Owner observation from the incident run: the constant mid-run "allow" cards are wearing, and **a
deny earlier likely stopped the drafter from storing its document** — which is consistent with
all the evidence (clean `git status`, drafter reported anyway, `permission_denials` recorded on
the turn row but surfaced nowhere prominent). A single deny does not stop a session; the agent
loses that one call, keeps going, and can report success without its main deliverable. The
`tool_denials` breaker only trips at 5 denials in one session (config
`breakers.denialsPerSession`), so one fatal deny sails under it.

Two additions to this WO's scope:

### 5. Denials must be visible where the work is judged

- **Turn card (web timeline):** any completed turn with `permissionDenials > 0` shows a warning
  chip — "N tool calls denied" — with the denied tool names if the runner records them (extend
  the `session.ended` payload/turn row if it currently stores only the count; keep the count as
  the fallback for old rows).
- **Completion/verdict cards:** the pair's completion card and the halt cards include the
  assignment's total denial count when non-zero, so "it finished but was denied X times" is
  readable at the moment the user judges the result.

### 6. A deny offers its consequence up front

When the user denies a gate card, the answer UI offers the existing options plus context: which
seat/turn is asking and (from WO2, once merged) a note when the denied tool is the one the
artifact write depends on — e.g. "Denying this likely prevents the drafter from writing
`<artifactPath>`". Keep it one line; the point is an informed deny, not a nag. (If wiring the
artifact-dependency hint proves speculative, ship the seat/turn context alone and note the rest
as future work — do not overbuild.)

### Acceptance tests (addendum)

- Web: a turn row with `permissionDenials: 2` renders the chip; zero renders nothing.
- Orchestrator: pair completion card payload carries the summed denial count when > 0.
- Runner (only if the payload extension is needed): denied tool names travel on
  `session.ended` and land on the turn row.
