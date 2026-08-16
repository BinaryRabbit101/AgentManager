# Design Docs

One subfolder per element. Each element's `README.md` states its scope, dependencies, and the open questions its design must answer. Design work (by Opus subagents) produces two further files per element:

- `DESIGN.md` — the design spec: data model, interfaces, behavior.
- `IMPLEMENTATION.md` — ordered implementation steps.

Designs must conform to the decisions in [architecture.md](architecture.md).

## Elements

| Element | Scope |
|---|---|
| [foundation/](foundation/) | Service skeleton and cross-cutting concerns — storage, config/editions, secrets, logging, Windows service lifecycle |
| [roster/](roster/) | Agent definitions — personas, specialties, models, tool permissions |
| [projects/](projects/) | Project registry — what agents get pointed at |
| [runner/](runner/) | Agent SDK session execution — lifecycle, concurrency cap, queue, usage tracking |
| [orchestrator/](orchestrator/) | Inter-agent messaging and work routing (the app-orchestrated overseer) |
| [remote/](remote/) | Remote listener — Tailscale-only binding, bearer token, auto-enable rules |
| [ui/](ui/) | Web frontend + Electron shell — roster view, session view, remote controls |

Suggested design order: foundation, roster, and projects first (everything hangs off their storage and schemas), then runner, then orchestrator and remote, then ui.
