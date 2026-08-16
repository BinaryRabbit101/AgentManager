# Foundation — Implementation

Ordered milestones for the v1 foundation. Each is independently verifiable and leaves the tree in a working state. **M1–M8 are prerequisites** for any other element's implementation; **M9–M11 can overlap with element work**.

Scope discipline: build only what [DESIGN.md](DESIGN.md) specifies, and nothing from its §7 deferred list.

---

## 1. Repository skeleton and toolchain

Set up the TypeScript project the whole app is built in: `package.json` (ESM, Node 22 LTS), `tsconfig.json` (strict), build (tsup or tsc), test runner (vitest), lint/format, and the source layout `src/{config,logging,storage,secrets,modules,http,main.ts}`. No application behaviour beyond a `main.ts` that starts and exits cleanly.

**Acceptance**
- `npm ci && npm run build && npm test && npm run lint` all pass from a clean clone.
- `node dist/main.js --version` prints the version and exits 0.
- `.gitignore` covers `node_modules/`, `dist/`, `.env`, `*.local.json`; no data-root path is ever written inside the repo.
- CI-equivalent script documented in the README of the repo root or `package.json` scripts.

## 2. Configuration and edition resolution

Implement the five-layer loader (defaults → edition → machine-local → env → CLI), the zod schema for the §2.3 key inventory, deep merge with array-replace semantics, per-key source tracking, and the fatal-on-invalid behaviour. Ship `config/defaults.json`, `config/edition.home.json`, `config/edition.work.json`. Resolve `AGENTMANAGER_HOME` first; default `edition` to `work`.

**Acceptance**
- Unit tests prove precedence for every layer, including an env var overriding a machine-local value and a CLI `--set` overriding the env var.
- A malformed `config.json` produces a non-zero exit with a per-key error report and no partial start.
- `edition: "work"` + `modules.remote.enabled: true` is rejected by validation with a specific message.
- With no `config.json` present, the resolved edition is `work` and a warning is logged.
- The resolved config object is frozen; mutation attempts throw in tests.

## 3. Logging

pino-based JSONL logger with `core.log` and `access.log` streams, size+age rotation, the 2000-record ring buffer, child loggers tagged by component, correlation-id fields, the dev stderr pretty stream, and write-time redaction (key paths plus the `sk-ant-`/`Bearer` regex scrub).

**Acceptance**
- Records are valid JSON lines carrying `ts`, `level`, `component`, `msg`.
- A test that logs an object containing an OAuth-shaped token and a `Bearer` header finds `[redacted]` in both the file and the ring buffer, and the raw value nowhere.
- Rotation test: writing past `maxFileMB` produces a rotated file; exceeding `maxFiles` and `retentionDays` prunes correctly, including a prune pass triggered on boot.
- Runtime level change takes effect without restart.

## 4. Storage: engine, migrations, data root

better-sqlite3 with the specified pragmas, the data-root/library-root directory bootstrap (created with the current-user ACL), the migration runner (`user_version`, one transaction, pre-migration backup to `state/backups/`), `PRAGMA quick_check` on boot, and ULID generation.

**Acceptance**
- First run on an empty machine creates the full §1.2 tree and a DB at `user_version = 1`.
- Re-running is a no-op; `user_version` is unchanged and no second backup is written.
- A deliberately corrupt DB fails boot with a message naming the newest backup file.
- Applying a test migration `0002` produces a backup and advances `user_version`; a failing migration rolls back entirely and leaves the DB at the prior version.
- WAL files are present and a graceful shutdown checkpoints and removes them.

## 5. Core schema and repositories

`0001_init.sql` creating every table in DESIGN §1.4 with the stated keys, indexes, and FK behaviours, plus repository modules (`agents`, `projects`, `assignments`, `sessions`, `usage`, `messages`, `questions`, `events`, `settings`, `remoteTokens`) exposing typed CRUD. Include the transcript path helper and the append-only JSONL transcript writer with its fsync policy and its maintenance of `sessions.transcript_bytes`. Also the element-owned migration runner of DESIGN §1.3: `migrations/<moduleId>/NNNN_*.sql` applied after the core set in module topological order, tracked in `schema_migrations(module, version, applied_at)`. This milestone is the handoff point other elements code against.

**Acceptance**
- Every table, index, and FK from §1.4 exists; a schema snapshot test guards against accidental drift. **The snapshot covers foundation-owned tables only** — element migrations vary by which modules are enabled, so including them would make the snapshot a flapping test of module configuration.
- A fixture module shipping `migrations/<moduleId>/0001_*.sql` has its table created after the core set, in topological order relative to its `dependsOn`; re-running the boot applies nothing further; and `schema_migrations` carries one row naming the module and version.
- Repository tests cover: creating an assignment with members and a session under it; recording usage deltas and reading the rollup in one query; a mailbox query returning only undelivered messages in order; opening, answering, and re-reading a question across a simulated restart.
- `sessions.countByAgent(agentId)` returns the right count and uses the `sessions(agent_id)` index (asserted via `EXPLAIN QUERY PLAN`, not a timing test); it is the call roster's purge guard makes.
- Deleting a project with sessions is refused; deleting an assignment cascades its members and recommendations; deleting an agent row leaves its sessions intact.
- A transcript can be appended to and tailed from a byte offset; a missing transcript file yields a defined "pruned" result rather than an exception.
- Appending to a transcript advances `sessions.transcript_bytes` to match the file's actual size, including across a writer restart; `SUM(transcript_bytes)` over a project's sessions is what projects' size cap reads.
- `events` pruning by age and row cap runs on boot and is covered by a test.

## 6. Secrets

The `SecretStore` interface with the `dpapi` provider (`@primno/dpapi` — amended from `win-dpapi`, see DESIGN §3.1 — CurrentUser + app entropy, base64 envelope at `state/secrets/secrets.json`), automatic `keyfile` fallback (AES-256-GCM, ACL'd key, warning + degraded health flag), the `env` provider, the `Secret` wrapper type, and the `ANTHROPIC_API_KEY` startup warning.

**Acceptance**
- Round-trip set/get/delete/list works under `dpapi`; `list()` returns previews only.
- Simulating a native-binding load failure transparently selects `keyfile`, logs a `WARN`, and surfaces the degraded flag in health output.
- `JSON.stringify`, template interpolation, and `console.log` of a `Secret` all yield `[redacted]`; only `.reveal()` returns plaintext.
- Under `auth.mode: "env"` no secret file is created and nothing is written to disk.
- With `ANTHROPIC_API_KEY` set and `auth.mode: "subscription"`, boot logs a warning and the health payload carries the condition.
- ACL test: `state/secrets/` grants the current user only, with inheritance disabled.

## 7. Module system and composition root

The `Module`/`ModuleHandle`/`ModuleContext` contracts, service registry (`provide`/`require`), typed event bus with `persist` writing to `events`, topological start order with per-module timeout, reverse-order stop, critical vs. degradable failure handling, boot-task and health-check registration, and the `main.ts` composition root with the dynamic import of the remote module.

**Acceptance**
- A dependency cycle in `dependsOn` is detected and fails fast with the cycle named.
- A non-critical module that throws in `init` leaves the service running and marked unhealthy; a critical one exits non-zero.
- Start order matches the topological order and stop order is exactly its reverse, proven by a test recording hook calls.
- Emitting a `persist: true` event writes exactly one `events` row and fans out to subscribers; a subscriber that throws does not break other subscribers.
- With `edition: "work"`, the remote module file is never imported (asserted via an import spy or module-load counter).

## 8. HTTP surface, health, and the log API

Single route table and framework instance bound to `http.bind`/`http.port`; foundation routes `/healthz`, `/api/health`, `/api/config/effective`, `/api/logs`, `/api/logs/stream`, `/api/logs/download`, `/api/logs/level`, `/api/events`, `/api/service/shutdown`; access logging middleware with `origin` and `requestId`; the mount point the remote module will reuse.

**Acceptance**
- `/healthz` returns 200 with `{status, version, edition, uptime}` in under 50 ms.
- `/api/health` aggregates every registered module health check and reports degraded modules individually.
- `/api/config/effective` shows each key's winning layer and contains no secret values (asserted by scanning the response for known secret material).
- `/api/logs` filters by level, component, and `sessionId`; `/api/logs/stream` delivers a record emitted after subscription within 1 s.
- `/api/events?since=<id>` replays missed events in order, then the live stream continues without a gap or duplicate.
- Every request appears in `access.log` with method, path, status, duration, and origin.

## 9. Windows process lifecycle

Exclusive-handle single-instance lock, `run/core.port` publication and stale-file handling, SIGINT/SIGTERM/API graceful shutdown with the grace budget, boot reconciliation hook execution ordering, and the post-start bind-time invariant assertion (DESIGN §6.3).

**Acceptance**
- A second `node dist/main.js` prints the running port and exits 0 without touching the DB.
- Killing the core hard leaves a stale `run/core.port`; the next start detects it, overwrites it, and boots normally.
- Graceful shutdown completes within `shutdownGraceSeconds`, checkpoints WAL, removes `run/core.port`, and releases the lock; a module that hangs in `stop()` does not prevent process exit.
- Boot tasks run after storage is ready and before any listener binds, proven by a test observing bind order.
- Work edition with a forced non-loopback bind exits fatally with a clear message; home edition with a non-loopback bind not owned by the remote module does the same.

## 10. PowerShell install, setup, and autostart

`Install-AgentManager.ps1`, `Setup-Auth.ps1`, `Register-Autostart.ps1`/`Unregister-Autostart.ps1`, `Test-AgentManagerHealth.ps1`, `Uninstall-AgentManager.ps1`, plus `launch-core.vbs`. Also the minimal `agentmanager` CLI entry points these scripts call (`secrets set --stdin`, `migrate`, `health`) so no capability is PowerShell-only.

**Acceptance**
- A clean non-admin install on a fresh Windows 11 user account completes end to end: data root created and ACL'd, config written with the chosen edition, schema migrated, autostart registered (home) or skipped (work), core reachable at the printed URL.
- Re-running `Install-AgentManager.ps1` is idempotent — no duplicate task, no config clobber of user edits, and no write inside `library/` beyond creating and ACLing the directory itself (its contents are roster's, DESIGN §4.4).
- Log off and back on: the scheduled task starts the core with **no visible console window**, and `/healthz` answers before the desktop app is opened.
- `Setup-Auth.ps1` stores a working token with the value never appearing in the console, the PowerShell history, the process command line, or any log file.
- `Test-AgentManagerHealth.ps1` produces a single readable report covering edition, ports, task state, DB check, secret provider, `ANTHROPIC_API_KEY` presence, and a log tail.
- `Uninstall-AgentManager.ps1` without `-RemoveData` removes program files and the task while leaving the data root and library intact, and refuses to delete a library root outside the data root.

## 11. Edition and boundary test suite

A dedicated suite that pins the D5/D6 boundaries so a future refactor cannot quietly cross them: work-edition module inventory, socket binding assertions in both editions, config validation rejections, and a static check that no feature module imports another feature module directly.

**Acceptance**
- Booting the work edition yields zero non-loopback listeners and no remote routes on the route table.
- Booting the home edition with `modules.remote.enabled: false` behaves identically to the work edition with respect to listeners.
- A dependency-graph test fails if any `src/modules/<feature>` file imports from another `src/modules/<feature>` — cross-module access must go through the registry or bus.
- The full suite runs in CI on every change and is documented as the gate for merging changes to config, module wiring, or listeners.
