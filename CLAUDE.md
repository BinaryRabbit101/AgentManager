# AgentManager

Manager for a roster of Claude agents (persona + specialty + permissions) pointed at projects, with remote start/stop. See [README.md](README.md) for the overview.

## Ground rules

- All designs and code must conform to [docs/architecture.md](docs/architecture.md) (D1–D6). If a change conflicts with a decision there, raise it — don't silently diverge.
- Design docs live in `docs/<element>/`: `README.md` (scope, owned by humans), `DESIGN.md` (design spec), `IMPLEMENTATION.md` (ordered steps). Read the element's README and architecture.md before writing a design.
- Cross-cutting concerns (storage, config/editions, secrets, logging, service lifecycle, module registration) belong to `docs/foundation/` — feature elements consume its decisions rather than inventing their own.
- Stack: Node.js/TypeScript core service; Claude Agent SDK for agent execution; single web frontend (Electron-wrapped locally, browser remotely). PowerShell only for install/setup scripts.
- Two editions, one codebase: home (remote listener on, Tailscale-bound) and work (listener never started, localhost only). Edition is configuration — never fork code paths by copy.
- Secrets (`CLAUDE_CODE_OAUTH_TOKEN`, remote bearer tokens) never go in git or in code — see foundation's secrets decision.
