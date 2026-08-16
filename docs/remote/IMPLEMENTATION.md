# Remote — Implementation

Ordered milestones for the v1 remote listener. Each is independently verifiable and leaves the tree
in a working state; each assumes foundation milestones 1–9 are done (module system, route table,
`remote_tokens`, `settings`, `access.log`, the bind-time assertion) and runner M-complete for the
end-to-end milestone.

Scope discipline: build only what [DESIGN.md](DESIGN.md) specifies, and nothing from its §14 deferred
list. In particular: no TLS, no browser Web Push, no identity headers, no token scopes. (The v1 push
channel is orchestrator's ntfy notifier, out-of-band and built there — remote implements no part of
it; DESIGN §7.4.)

The final milestone (M10) is the edition boundary suite and is the gate for merging any change to
binding, listeners, or module wiring.

---

## 1. Module skeleton, config sub-schema, and edition wiring

The `remote` module under foundation's `Module` contract: `id: 'remote'`, `dependsOn: ['storage',
'http']`, **`critical: false`**, `init(ctx)` returning a handle with `start`/`stop`/`health`. Register
the §11 config sub-schema (with `bind` as a literal-`"tailscale"`-only enum) and its defaults. Ship
`migrations/remote/0001_last_used_peer.sql` adding `last_used_peer TEXT` to `remote_tokens`. Wire the
dynamic import in `main.ts` behind `edition === 'home' && modules.remote.enabled`. No socket yet —
`start()` logs and returns.

**Acceptance**
- Home edition with `modules.remote.enabled: true` starts the module and reports it in `/api/health`;
  work edition does not, and the module file is never imported (module-load counter, sharing
  foundation M7's harness).
- `remote.bind: "100.101.102.103"` is rejected by config validation with a message naming D5;
  `"tailscale"` validates.
- The module migration applies once, in module topological order, and is recorded in
  `schema_migrations`; re-boot applies nothing.
- Throwing in `init()` leaves the core running and marks remote unhealthy — proving `critical: false`.

## 2. Tailscale detection

`TailscaleDetector` with the CLI primary path (`tailscale status --json`, resolved from
`remote.detect.cli` → `C:\Program Files\Tailscale\tailscale.exe` → `PATH`; spawned directly, no
shell, 5 s timeout) and the `os.networkInterfaces()` fallback. The §2.1 validator: IPv4,
`100.64.0.0/10`, non-internal, adapter matching `/tailscale/i` **or** CLI-reported, exactly one
candidate. Returns `{ address, magicDnsName, backendState, source: 'cli' | 'interface' } | Refusal`.
Includes the 60 s-TTL peer map for later audit enrichment.

**Acceptance**
- Against a fixture `status --json` from a real Windows 11 + Tailscale host, the address, MagicDNS
  name (trailing dot stripped), and `BackendState` are extracted correctly.
- `BackendState` of `Stopped` / `NeedsLogin` / `NoState` / `Starting` yields a refusal carrying that
  string, never an address.
- A LAN adapter holding a `100.64.0.0/10` address (the CPE-CGNAT case) is **refused** — this is the
  test that proves the range check alone is insufficient.
- A `/tailscale/i` adapter holding a non-CGNAT address is refused.
- CLI missing, hung past 5 s, and returning malformed JSON each fall back to interface enumeration,
  produce a valid address, and log at `warn` with `source: 'interface'`.
- Two valid candidates produce an "ambiguous interface" refusal, not a selection.
- An IPv6-only tailnet (ULA prefix only) refuses with a distinct reason rather than binding.
- Zero subprocesses are spawned on the interface-fallback path.

## 3. Listener lifecycle

The §2.3 state machine: `waiting → binding → listening → (waiting | down)`, backoff with jitter to
`retryMaxMs`, the `pollMs` address watcher, immediate close on address disappearance or change with
rebind after fresh validation, and the 5-failures-in-10-minutes `down` state. Mount foundation's
existing route table on the second server. Publish `ctx.provide('remote', { boundAddress() })` and a
`health()` reporting state, address, `tailscaleState`, and `lastError`.

**Acceptance**
- With Tailscale down at boot the core starts normally, **no socket exists**, `/api/health` reports
  `remote: degraded` with the backend state, and the listener binds automatically within one poll
  interval of the address appearing.
- With Tailscale up at boot the listener binds the validated address; `netstat`-equivalent socket
  enumeration shows exactly one non-loopback listener and its address is the Tailscale one.
- Simulating address disappearance closes the socket within one poll interval and returns to
  `waiting`; **no socket is left open**.
- Simulating an address *change* rebinds to the new address only after re-running full validation;
  a change to an invalid address leaves the module in `waiting`, never bound.
- `EADDRINUSE` five times in ten minutes reaches `down`, stops retrying, and reports the port in the
  health message; `POST /api/remote/restart` resumes the cycle.
- A code path calling `server.listen(port)` without an address fails a static test (grep-level
  assertion in the boundary suite, M10).
- Running sessions survive every transition above untouched (asserted by a live session's status and
  transcript across a forced unbind/rebind).

## 4. Token store and bearer authentication

`RemoteTokenService` over `remote_tokens`: create (32 random bytes base64url, sha256 hash, 6-char
prefix, `label` required, `ttlDays` default 90, `maxActive` 10), list, revoke. The auth middleware:
prefix-indexed lookup, `timingSafeEqual` digest comparison, expiry/revocation checks, uniform 401
body, `last_used_at`/`last_used_peer` update throttled to one write per token per 60 s. Peer-address
validation (§9.2 #6) and the `Host` allowlist (#8). Access-log fields per §9.1 #4.

**Acceptance**
- A created token authenticates; its plaintext appears in the creation response and in **no** log
  file, DB column, or subsequent response (asserted by scanning `core.log`, `access.log`, and the DB
  for the literal).
- Unknown, malformed, expired, and revoked tokens produce byte-identical 401 bodies.
- Revoked and expired tokens fail immediately, including one revoked mid-test.
- `last_used_at` updates at most once per 60 s under a 100-request burst.
- Every request appears in `access.log` with `origin: 'remote'`, `tokenId`, prefix, peer, and
  `requestId`; a failure appears at `warn`.
- A connection from a peer outside `100.64.0.0/10` is refused before routing.
- A request with a foreign `Host` header gets 421; the bound IP, MagicDNS name, and `hostnameHint`
  all pass.
- Timing test (statistical, not a single measurement) shows no correlation between response time and
  the number of matching leading bytes.

## 5. Rate limiting and lockout

The §4.6 per-peer sliding window (`maxFailures` in `failWindowMs` → `blockMs` with `Retry-After`),
the single persisted `remote.auth.failed` event per window, and the per-token `fs/browse` bucket
(`browseRateLimitPerMin`). Explicitly **no** auto-revocation on repeated failures.

**Acceptance**
- 10 failures inside 5 minutes from one peer produce a 429 with `Retry-After`; a *different* peer is
  unaffected.
- The block lifts exactly after `blockMs`, verified with the injected `ctx.clock`, not a real sleep.
- 100 failures emit **one** `remote.auth.failed` event and one `warn` block line, not 100 of each.
- A valid token is never revoked by any number of failures against its prefix (the DoS-resistance
  test named in DESIGN §4.6).
- 61 `fs/browse` calls in a minute from one token yields a 429 on the last one; other routes are
  unaffected.

## 6. Route policy middleware

The §3.1 four-rule pipeline: static shell bypass → deny list → bearer auth → grant gate (stubbed
until M8). Both deny sources: foundation's per-route `{ remote: 'deny' }` metadata — shipped by
foundation §6.4, defaulting to `allow`, recorded on the route table and enforced by nothing but this
middleware — and remote's hardcoded pattern list, which stays as the backstop for routes whose author
did not think about it. Deny evaluated **before** auth. Expose the effective deny list in `GET /api/remote/status`.

**Acceptance**
- `GET /` and `/assets/*` are served over the remote listener **without** a token; `GET /api/health`
  without one is 401.
- `POST /api/service/shutdown`, `POST /api/remote/tokens`, `POST /api/remote/restart`, and
  `PUT /api/remote/enabled {enabled:true}` all return `403 route_denied_remotely` over the remote
  listener and succeed over the local one.
- The same four return 403 **without a token**, proving deny precedes auth (no token oracle).
- `DELETE /api/remote/tokens/:id` and `PUT /api/remote/enabled {enabled:false}` succeed remotely —
  the loosening principle, tested in both directions.
- `GET /api/fs/browse` succeeds remotely, is confined to `projects.browseRoots`, returns no file
  contents, and logs its **resolved** path.
- A route registered with `{ remote: 'deny' }` in a fixture module is refused remotely with no change
  to remote's code.
- Every other route in the v1 inventory (roster, projects, sessions, questions, events, logs) is
  reachable remotely with a valid token — the default-allow half of the policy, asserted as a table
  test over the actual route table so a new route is covered automatically.

## 7. Stream tickets, WS/SSE, and connection lifecycle

`POST /api/remote/stream-ticket` (32 bytes, in-memory, single-use, 30 s, bound to `tokenId`), ticket
acceptance on WS upgrade and SSE, the `tokenId → Set<connection>` map, heartbeat ping/pong (30 s, two
missed = close) and the SSE comment keepalive, and `ticket=` scrubbing in the access log.

**Acceptance**
- A browser-shaped client (`new WebSocket` / `new EventSource`, no custom headers) connects to
  `/api/events`, `/api/logs/stream`, and `/api/sessions/:id/stream` using a ticket, and receives an
  event emitted after subscription within 1 s.
- A reused ticket is refused; an expired ticket is refused; a ticket minted by token A cannot be used
  after token A is revoked.
- Revoking a token closes its live streams within 1 s and leaves other tokens' streams open.
- A silently dropped client is reaped within two heartbeat intervals and its map entry removed (no
  leak under 100 connect/drop cycles).
- No `ticket` or `Authorization` value appears in `access.log`.
- `/api/events?since=<id>` over the remote listener replays missed events in order and continues into
  the live stream with no gap and no duplicate.

## 8. Per-agent remote access grants

Grant storage in `settings` as one row per agent (`remote.agentAccess.<agentId>`), the §6.2 three-tier
gate, the §6.3 grant flow (`409 remote_access_required`, `PUT /api/remote/agents/:id/access`,
`confirmRemoteAccess: true` on start), lazy read-time expiry plus boot and hourly sweeps, the
`remote.agent.access.granted|revoked|expired` events, and every disable trigger (TTL, explicit,
`roster.changed` archive/delete, last-token-revoked, global kill switch).

**Acceptance**
- A remote `POST /api/sessions` for an ungranted agent returns 409 with the agent id and creates no
  session row; after the grant it succeeds and the session carries `origin: 'remote'`.
- **A remote `POST /api/assignments/solo` for an ungranted agent is refused with `409
  remote_access_required` and creates no assignment and no session row** — the product's real launch
  path, tested as such; the same test covers `POST /api/assignments` (409 listing *every* ungranted
  member) and `POST /api/assignments/:id/advance`. A test enumerates the live route table and asserts
  every route that can start a session is gated, so a new launch route fails this milestone rather
  than shipping ungated (DESIGN §6.2).
- `confirmRemoteAccess: true` grants and starts in one call, including granting every listed member
  of a pattern launch.
- Stop, pause, transcript read, event stream, and **question answer** all succeed for an agent with
  **no** grant and for one whose grant has expired — the safety-valve and never-stranded invariants,
  each an explicit named test.
- `/steer` and `/continue` are gated; `/stop` and `/pause` are not.
- The TTL slides: a remote start refreshes `expiresAt`; after `ttlHours` with no remote start the
  grant is gone and the next start 409s.
- An expired grant is refused at read time even when the sweep has not run (clock advanced past the
  deadline with the sweep disabled).
- Archiving the agent, revoking the last token, and toggling the grant off each clear it immediately
  and emit the event.
- `remote.enabled: false` blocks all initiation but **preserves** grants; re-enabling does not
  re-prompt.
- The local UI receives grant events live and `GET /api/remote/agents` reports `expiresAt`.

## 9. End-to-end: launch, watch, and answer from a phone

Integration milestone, no new mechanism. Drive the full §7.4 path against a real core with a real
session, using a browser-shaped client that only ever holds a bearer token and tickets.

**Acceptance**
- **Live answer**: pair by QR URL fragment (token read from `location.hash`, stripped from the URL) →
  list roster → start a session (grant prompt on first launch) → stream output → the agent raises an
  `AskUserQuestion` → the card appears on the remote client within 1 s → answer it → the pending
  `canUseTool` resolves **inline**, `questions.answered_via = 'remote'`, and the session continues in
  the same turn with no re-decided tool call.
- **Parked answer**: with `runner.question.holdMs` shortened, let the session park (`paused`,
  `exit_reason: awaiting_answer`), then answer from the remote client → runner auto-resumes at
  `interactive` priority with the injected answer message, and `session.resumed` reaches the remote
  stream. **Runner's auto-resume is not modified for this to work** — asserted by diffing runner's
  behaviour against the identical local-answer run.
- **Answer after grant expiry**: park a session, expire the agent's grant, answer from remote →
  the answer is accepted and the session resumes. The regression test for the §6.2 invariant.
- **Disconnect mid-session**: kill the tailnet link, let the session progress, reconnect → replay
  from the stored watermark plus a transcript byte-offset tail reproduces the missed output exactly
  once, and the session is still running.
- **Remote stop**: stop a session from the remote client; the runner path, `exit_reason`, and events
  are identical to a local stop.
- **Project quick-add from remote**: `GET /api/fs/browse` → `POST /api/projects/inspect` →
  `POST /api/projects` completes without touching the desktop (D3's promise, and the payoff of the
  §3.3 decision).

## 10. Edition and boundary test suite

The gate. A dedicated suite proving the work edition **cannot** listen and that the home edition
cannot listen anywhere but Tailscale. Runs in CI on every change; required for any change to
binding, listeners, config validation, or module wiring. Extends foundation's M11 suite rather than
duplicating it.

**Acceptance**
- **Work edition boots with zero non-loopback listeners**, the remote module file never imported
  (load counter), and `/api/remote/*` returning 404 on the local listener — asserted against the live
  route table, not a source-code list.
- **Work edition + `modules.remote.enabled: true` in `config.json` fails config validation** and does
  not start (foundation §2.2's invariant, re-asserted from remote's side because remote is what it
  protects against).
- **Work edition + a forced non-loopback listener** (test harness binds one directly) exits fatally
  via foundation §6.3's assertion, with the offending address in the message.
- **Home edition with `modules.remote.enabled: false`** is byte-identical to the work edition with
  respect to listeners.
- **Home edition never binds a non-Tailscale address**: forcing the detector to return a LAN address,
  `0.0.0.0`, `::`, `127.0.0.1`, and a CPE-CGNAT LAN address each cause a refusal to bind — five
  separate cases, each asserting no socket exists afterwards.
- **Static assertions**: no `listen(` call in the tree omits an address argument; no string literal
  `0.0.0.0` exists outside a test; the remote module imports no other feature module directly
  (foundation's existing dependency-graph test covers the last one).
- **The bind assertion cross-check**: foundation's post-start assertion and remote's
  `boundAddress()` agree; deliberately desynchronising them (harness returns a different address)
  fails the boot.
- **`GET /api/config/effective` and every error body over the remote listener contain no token
  material**, asserted by scanning responses for the active token, its hash, and any `sk-ant-`
  pattern.
- The suite is documented in the repo README as the merge gate for D5/D6-touching changes.
