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

## Development

Requires Node.js 22 LTS or newer (`engines: { "node": ">=22" }`); newer majors are fine.

```
npm ci          # install exactly what package-lock.json pins
npm run build   # tsc -> dist/
npm test        # vitest
npm run lint    # eslint + prettier --check
npm run format  # prettier --write
npm start       # node dist/main.js
```

**`npm run ci` is the gate** — it runs `lint`, `typecheck`, `build` and `test` in that order, and is exactly what a CI job should execute. Anything that passes it locally passes CI.

Source layout mirrors the foundation design ([docs/foundation/DESIGN.md](docs/foundation/DESIGN.md)):

```
src/
  config/    # layered config loader + zod schema (M2)
  logging/   # pino JSONL logger, rotation, redaction (M3)
  storage/   # better-sqlite3, migrations, repositories (M4/M5)
  secrets/   # SecretStore: dpapi -> keyfile -> env (M6)
  modules/   # feature modules; the remote module is dynamically imported (M7)
  http/      # route table, health, log API (M8)
  main.ts    # composition root / CLI entry point
```

Current state is foundation milestone M1: skeleton and toolchain only. `main.ts` parses `--version`/`--help` and exits; no service is started.

All runtime state lives under the data root (`%LOCALAPPDATA%\AgentManager` by default, overridable with `AGENTMANAGER_HOME`), never inside this repository. Secrets are never committed — see [docs/foundation/DESIGN.md](docs/foundation/DESIGN.md) §3.
