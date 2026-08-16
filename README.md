# AgentManager

A graphical manager for a roster of Claude agents. Agents are defined like people on a team — each with a persona, specialty (bug patching, feature implementation, email response, overseeing other agents), model, and tool permissions — and pointed at a project with a session prompt. AgentManager starts, stops, watches, and coordinates them, locally or remotely.

Successor to the ControlPanel web app, with deeper per-project agent management and remote start/stop. Inspired by [munder-difflin](https://github.com/chaitanyagiri/munder-difflin), minus most of the animation.

## Architecture at a glance

- **Core**: long-running Node.js/TypeScript service — owns agent sessions, roster/project state, the orchestrator, and the remote listener.
- **Agent execution**: Claude Agent SDK under the owner's Claude subscription auth (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`), with a concurrency cap and queue because rate-limit windows are shared with the owner's own Claude usage.
- **UI**: one web frontend served by the core — wrapped in Electron for the local Windows app, plain browser over the tailnet for remote.
- **Orchestration**: app-orchestrated — AgentManager routes work between roster agents via an inter-agent messaging layer.
- **Remote access**: listener binds to the Tailscale interface only, plus a bearer token. Remote access auto-enables when an agent is started remotely.
- **Editions**: home edition runs the remote listener; work edition is the same codebase with the listener module disabled and localhost-only binding.

## Documentation

Design docs live in [docs/](docs/) — one subfolder per element, each with a design spec and implementation steps. See [docs/architecture.md](docs/architecture.md) for the decision record.
