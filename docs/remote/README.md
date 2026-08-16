# Remote

The remote listener — start/stop/watch agents from another device (architecture D5). Present in the home edition only; the work edition never starts this module.

## Responsibilities

- HTTP/WebSocket listener bound **only** to the Tailscale interface (never LAN/public), with bearer-token auth on every request.
- Remote API surface: list roster/projects, start/stop sessions, stream session output, toggle remote access per agent.
- Auto-enable rule: starting an agent remotely enables its remote access; design must define when/how it disables (session end? explicit toggle? timeout?).
- Edition gating: clean module boundary so the work edition simply omits it (architecture D6).

## Depends on

runner (session control), roster, projects. The browser UI over the tailnet is a client of this API.

## Open questions for design

- Same API the local UI uses (one API, two bind addresses) vs. a separate reduced remote surface?
- Token lifecycle: generation, rotation, per-device tokens?
- Should remote sessions carry restricted permission modes by default (e.g. no unattended destructive commands when started remotely)?
- Detecting the Tailscale interface robustly on Windows at startup.
