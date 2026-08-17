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

### The edition and boundary suite — the merge gate for D5/D6

```
npm run test:boundary
```

`npm run test:boundary` runs the **edition and boundary suite**, and it is the **merge gate for any change that touches binding, listeners, config validation, or module wiring** ([docs/remote/IMPLEMENTATION.md](docs/remote/IMPLEMENTATION.md) §10, [docs/foundation/IMPLEMENTATION.md](docs/foundation/IMPLEMENTATION.md) §11). It exists to pin architecture **D5** (the remote listener binds only a *proven* address — the Tailscale interface, or in proxy mode the one declared LAN address behind the household proxy host) and **D6** (the work edition is the same codebase with the listener module never loaded), so a future refactor cannot quietly cross either boundary.

It proves, over real boots and real sockets:

- the **work edition** boots with zero non-loopback listeners, never evaluates the remote module file, and carries no `/api/remote/*` route on the live route table;
- the work edition's **module inventory** is exactly the list foundation [DESIGN.md](docs/foundation/DESIGN.md) §6.2 composes — an exact set, so a module *appearing* fails as loudly as one disappearing — and the home edition's inventory differs from it by exactly one id, `remote`, across the module graph, `/api/health`, the route table's owners and the service registry;
- **work edition + `modules.remote.enabled: true`** fails config validation and never starts;
- a **forced non-loopback listener** — including one a harness module opens directly — is fatal in both editions;
- **home edition with remote disabled** is the work edition, listener for listener;
- the **home edition refuses to bind** a LAN address, `0.0.0.0`, `::`, `127.0.0.1`, a CPE-CGNAT LAN address, an IPv6 tailnet address, or any address other than the one proxy mode declares — leaving no socket behind in every case;
- foundation's post-start bind assertion and remote's published `boundAddress()` **agree**, and a deliberate desynchronisation kills the boot;
- no response or error body carries token material;
- statically: no `listen(` call in the tree omits an address, no wildcard bind literal exists in shipped code, and no feature module imports another directly.

The script deliberately runs more than the `boundary*` files: it also pulls in `src/lifecycle/bind.test.ts` (every branch of the §6.3 assertion), `src/lifecycle/process.test.ts` (the spawned bundle's fatal-bind cases), `src/main.test.ts` (the composition root's edition gate) and `src/modules/runner/boundaries.test.ts` (the element-scoped import and SQL checks), because the gate is the *set* of proofs that pin D5/D6 rather than one file.

`npm run ci` runs all of it as part of `npm test`, so the gate cannot be skipped by running the normal command; `npm run test:boundary` is the fast path when reviewing a change to a bind path.

#### The module-boundary rule

Foundation [DESIGN.md](docs/foundation/DESIGN.md) §6.1 — *"feature modules never import each other directly"* — is enforced by ESLint, not only by a test: [eslint.config.js](eslint.config.js) configures `no-restricted-imports` per feature module, so a forbidden import fails in the editor and in `npm run lint` before it reaches CI. `src/modules/boundaryImports.test.ts` lints fixtures for every feature against every sibling, so the rule is proven to *fire* rather than merely to be present, and scans the tree for the two forms ESLint's rule cannot see (`await import(…)` and `require(…)`).

The exception surface is exactly two tiers, and nothing else:

| Tier | Applies to | Rule |
|---|---|---|
| 1 | Shipped source | **No** import of a sibling feature module, in any form — not even type-only. What an element needs from another it declares locally (`orchestrator/ports.ts`, `runner/contracts.ts`) and adapts from whatever `ctx.require(<service>)` returns. |
| 2 | `*.test.ts`, `__tests__/`, `__fixtures__/`, `__spike__/` | A sibling's **pure units** are allowed, because a cross-element *agreement* test has to see both sides. A sibling's **wiring** — `index`/`module`/`service`/`routes` — is not: constructing a sibling module is the lifecycle coupling tier 1 forbids. A test needing two real modules boots them through `src/main.ts`. |

`src/main.ts` is deliberately outside both: the composition root is the one file whose job is knowing how the elements fit together.

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
