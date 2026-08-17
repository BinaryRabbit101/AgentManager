# Architecture Decision Record

Decisions made 2026-08-16 at project kickoff. Each element in [docs/](./) designs within these constraints.

## D1 — Core stack: Node.js service

The always-running core is a Node.js/TypeScript service. It owns agent sessions, roster/project state, the orchestrator, and the remote listener. PowerShell is used only for install/setup/environment scripts, not the runtime.

**Why**: the Claude Agent SDK is TypeScript-native; long-lived sessions, streaming, and WebSockets are natural in Node and painful in PowerShell. munder-difflin validated the shape.

## D2 — Agent execution: Claude Agent SDK on subscription auth

Agents run through the Claude Agent SDK. Auth comes from the owner's Claude Max subscription via `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` (durable for a headless service; interactive `/login` credentials expire).

Consequences the design must honor:

- Rate-limit windows (5-hour + weekly) are shared with the owner's interactive Claude usage → the runner needs a **concurrency cap and queue**, and the UI should surface plan usage.
- If `ANTHROPIC_API_KEY` is set in the environment it silently overrides subscription auth → **startup warning**.
- The work edition swaps to API key/Bedrock purely via environment — no code changes.

## D3 — UI: one web frontend, two delivery modes

A single web frontend served by the Node core. Locally it is wrapped in Electron to be the Windows app; remotely it is reached in a plain browser over the tailnet. One UI codebase.

## D4 — Orchestration: app-orchestrated

AgentManager itself routes work between roster agents (like munder-difflin's "Michael"): inter-agent messaging, mailboxes, and an orchestrator that assigns work. This is deliberate scope — chosen over the simpler agent-internal-subagents model — and is its own element ([orchestrator/](orchestrator/)).

## D5 — Remote access: Tailscale-only + bearer token

The remote listener binds **only** to the Tailscale interface — never LAN or public. Requests additionally require a bearer token. Remote access auto-enables when an agent is started remotely; the security design must also define when it turns back off.

*Amended 2026-08-17 (owner decision): Tailscale only ever lives on the household's proxy host (the mini-pc), never on the core's machine.* The remote listener therefore supports two bind modes, both bearer-authenticated and both absent from the work edition: **`tailscale`** (the original — bind the local Tailscale interface; retained for installs where the tailnet reaches the machine) and **`proxy`** — bind a single configured LAN address and accept TCP connections **only from the declared proxy peer's IP** (the mini-pc, whose nginx + `tailscale serve` provide tailnet-only exposure and TLS). In proxy mode the tailnet-membership gate moves to the proxy host; the listener's peer-IP allowlist plus the bearer token are the core's own controls. The proxy→core LAN hop is plain HTTP in v1 (bearer tokens transit the home LAN); TLS on that hop is a deliberate deferral, not an oversight.

## D6 — Two editions, one codebase

- **Home**: full app with remote listener.
- **Work**: same codebase, listener module not started, localhost-only binding, auth via whatever the workplace provides (API key/Bedrock).

Edition is configuration, not a fork.
