# Runner

Agent session execution — where roster agents actually run, via the Claude Agent SDK.

## Responsibilities

- Session lifecycle: start (agent × project × prompt, always under an assignment id — see orchestrator), stream output, interrupt/steer, stop, resume.
- Question/answer bridge: when a running session needs user input, the runner surfaces it as a structured question event and can **deliver the user's answer back into the live session** (SDK permission callbacks / streaming input). The orchestrator's question cards and the UI's inbox are built on this — without it, answers arrive after the agent has given up and moved on.
- Auth: subscription OAuth via `CLAUDE_CODE_OAUTH_TOKEN`; startup warning if `ANTHROPIC_API_KEY` would override it; environment-based swap for the work edition.
- Concurrency cap and queue (shared rate-limit windows with the owner's own Claude usage — see architecture D2).
- Usage tracking: surface plan-window consumption to the UI, and meter tokens **per session** so the orchestrator can enforce per-assignment budgets and the UI can show what each agent/assignment is costing.
- Emitting structured session events (tool calls, messages, completion) that the orchestrator and UI consume.

## Depends on

roster (agent definitions), projects (targets). Feeds orchestrator and ui.

## Contracts already pinned by wave 1

Foundation, roster, and projects have shipped designs that depend on runner behaving in specific
ways. These are settled inputs to runner's design, not open questions:

- **`sessions.assignment_id` is NOT NULL.** Every session belongs to an assignment; a solo
  drag-and-drop launch creates the trivial one first. There is no unassigned-session path.
- **Session status vocabulary is exactly** `queued | running | paused | done | failed | interrupted |
  orphaned` (foundation §1.4). Projects' activity timeline derives its assignment outcome from these
  values, so runner may not add, rename, or repurpose one without a cross-element change.
- **Runner populates `sessions.summary`** — a one-line digest (first user prompt, last assistant
  message, outcome). Projects' timeline renders from it and never opens a transcript to do so.
- **Runner populates `sessions.transcript_path`** using foundation's layout,
  `state/transcripts/<YYYY>/<MM>/<session-id>.jsonl` (foundation §1.5). This is the single addressing
  scheme; nothing derives a transcript path from a project slug or any other renameable thing. It
  settles the open question below about where transcripts live.
- **The transcript writer maintains `sessions.transcript_bytes`** as it appends. Projects' per-project
  size cap is `SUM(transcript_bytes)`, so an unmaintained column silently disables retention.
- **Per-session token metering lands in `session_usage`** (append-only deltas in `usage_events`, the
  rollup written in the same transaction). The input/output split lives there and is joined by read
  models; it is not duplicated onto the session row.

## Open questions for design

- SDK streaming-input mode vs. one-shot runs: what does "steering a running agent" require?
- Crash/restart recovery: can in-flight sessions be resumed after the core restarts?
- Sensible default concurrency cap, and is it configurable per plan tier?
