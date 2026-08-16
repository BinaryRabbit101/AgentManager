# UI

One web frontend, two delivery modes (architecture D3): Electron-wrapped as the local Windows app, plain browser over the tailnet for remote.

## UX north star

Managing agents must feel visual and direct, not form-driven. The roster is a board of agent cards; assignment is **drag and drop** — drag an agent card onto a project to open the launch flow (prompt + remote toggle) pre-filled. Creating agents and registering projects must each be doable in under a minute without editing files by hand.

## Responsibilities

- Roster view: the agents as a team — a card/board layout with avatar, specialty, and live status per agent. Light character flavor, not munder-difflin-level animation.
- Drag-and-drop assignment: agent card → project starts the launch flow; dragging onto an active project could also reassign/add the agent (design decides the exact semantics).
- Agent drafting wizard: create a new agent from a short description — the app uses Claude to draft the persona, specialty, and suggested tool permissions, which the user then tweaks and saves to the roster. Duplicate-and-edit ("clone a person") is a first-class path.
- Project quick-add: browse to a folder or paste a repo URL; sensible defaults, no config-file editing.
- Launch flow: agent × project, session prompt, remote-access toggle, start.
- Session view: live streamed output, steer/interrupt/stop controls, session history.
- Orchestrator view: what the overseer is doing, message flow between agents, approval-gate prompts. Multi-agent collaborations (e.g. architect/skeptic pairs) render as a readable conversation between the agents, not two disconnected terminals.
- Question inbox: one surface for everything agents need from the user — questions, orchestrator approval gates, and budget-exceeded halts all land here as cards, not in separate places. Each card shows which agent(s) are asking, their weighted recommendations, and highlighted disagreement for pair questions. Works from the remote browser too (an unanswered question should never be stranded on the desktop).
- Usage display: plan-window consumption, the runner's queue state, and per-assignment token spend against its budget.
- Electron shell: tray icon, packaging — thin wrapper only; all real UI is the web app.

## Depends on

Every other element's API. Design after roster/runner/orchestrator schemas exist.

## Open questions for design

- Frontend framework (React is the default assumption — confirm) and how the Electron wrapper stays thin.
- Terminal-style session rendering (xterm.js) vs. structured event rendering, or both?
- How much of the UI is disabled/hidden in the work edition vs. remote browser mode?
