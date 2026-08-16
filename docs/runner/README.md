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

## Open questions for design

- SDK streaming-input mode vs. one-shot runs: what does "steering a running agent" require?
- Crash/restart recovery: can in-flight sessions be resumed after the core restarts?
- Where do session transcripts live and how are they linked to project history?
- Sensible default concurrency cap, and is it configurable per plan tier?
