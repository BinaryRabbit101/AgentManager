# Remote — Design

The remote listener: start, stop, and watch agents from another device over Tailscale
(architecture **D5**), present only in the home edition (**D6**).

Conforms to [architecture.md](../architecture.md) D1–D6 and consumes
[foundation/DESIGN.md](../foundation/DESIGN.md) without inventing parallel mechanisms. Runner's
[§15.3 contracts](../runner/DESIGN.md) are treated as binding.

**The one-sentence shape of this element**: remote is a *transport*, not a policy layer. It adds a
second socket, an authentication check, an origin marker, and a per-agent consent gate. It adds no
routes that only exist remotely, no permission behaviour, and no second implementation of anything.

---

## 1. What remote owns and what it deliberately does not

| Owns | Does not own |
|---|---|
| Tailscale interface detection and the bound socket's whole lifecycle | The route table (foundation §6.4) |
| Bearer-token issuance, verification, rotation, revocation, lockout | Session semantics (runner), assignments (orchestrator) |
| The remote route **policy** (which shared routes it refuses) | Permission composition (roster) — see §7.3 |
| Per-agent remote-access grants and their expiry | The question card's content or recommendations (orchestrator) |
| Stream authentication for WS/SSE (browsers cannot set headers) | The event bus, replay, or the events table (foundation §6.5) |
| Remote-specific access logging and audit enrichment | Log storage or format (foundation §5) |

Foundation §6.4 already settled the brief's first open question: **one route table, two listeners.**
Everything below builds on that rather than reopening it.

---

## 2. Binding to Tailscale on Windows 11

### 2.1 The address must be proven, not assumed

D5 says "Tailscale interface only, never LAN or public". That is only a real boundary if the address
is *validated* rather than picked. A candidate address is accepted only if **all** of these hold:

1. It is IPv4 and inside `100.64.0.0/10` — the CGNAT range Tailscale allocates node addresses from.
2. It is on a non-internal interface whose adapter name matches `/tailscale/i`, **or** it was reported
   by the Tailscale CLI as `Self.TailscaleIPs[]`.
3. Exactly one candidate survives. Two surviving candidates is a refusal, not a coin toss — a
   security boundary does not guess.

Condition 1 alone is insufficient: some ISP CPE hands out `100.64.0.0/10` addresses on the LAN, and
binding one of those would put the listener on the LAN while passing a naive range check. Condition 2
alone is insufficient: an adapter can be renamed. Both together are cheap and hard to trip
accidentally.

`0.0.0.0`, `::`, a LAN address, and a bare `server.listen(port)` (which binds every interface) are
**never** used. The listener is always `server.listen(port, address)` with a validated literal, and
the edition/boundary suite asserts the absence of a bare-port listen call statically (§11, M10).

### 2.2 Detection: CLI primary, interface enumeration fallback

**Primary — `tailscale status --json`.** Resolved from `remote.detect.cli`, then
`C:\Program Files\Tailscale\tailscale.exe`, then `PATH`. Spawned directly (no shell), 5 s timeout,
output parsed as JSON. We read exactly four fields:

| Field | Use |
|---|---|
| `BackendState` | `Running` = bindable. `Stopped` / `NeedsLogin` / `NoState` / `Starting` = not bindable, and the string is what the health report shows the user. |
| `Self.TailscaleIPs[]` | The candidate address (first IPv4). |
| `Self.DNSName` | The MagicDNS name (trailing dot stripped) — used for the client URL, the QR payload, and the `Host` allowlist (§5.6). |
| `Peer[].{TailscaleIPs, HostName}` | Best-effort peer-IP → node-name map for audit enrichment only (§9.3). Never an authentication input. |

Chosen as primary because it is the only source that distinguishes "Tailscale is installed and this
address is live" from "an adapter with an address exists" — `BackendState` is the difference between
a working listener and one bound to a dead interface — and because it yields the MagicDNS name, which
the browser client needs and interface enumeration cannot produce.

**Fallback — `os.networkInterfaces()`.** Used when the CLI is absent, not on `PATH`, times out, or
returns unparseable output. Filters for `family === 'IPv4' && !internal` on an adapter matching
`/tailscale/i`, then applies §2.1's validation. Loses `BackendState` and the MagicDNS name; health
reports `tailscaleState: 'unknown (interface-derived)'` and the client URL falls back to the literal
IP or `remote.hostnameHint`. A fallback bind is logged at `warn` — it works, but it is the degraded
path.

**Rejected**: the Windows LocalAPI named pipe
(`\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled`) — Administrators-scoped on Windows,
which breaks foundation's non-admin install premise, and undocumented enough to be a liability.
**Rejected**: `tailscale ip -4` — the same subprocess cost as `status --json` for strictly less
information.

**IPv6 is out of scope for v1.** The tailnet ULA prefix `fd7a:115c:a1e0::/48` is recorded in the
validator so an IPv6-only tailnet is *refused loudly* rather than silently mis-bound, but v1 binds
IPv4 only.

### 2.3 The listener state machine

```
             detect ok                bind ok
  waiting ─────────────────► binding ─────────────► listening
     ▲                          │                       │
     │  backoff retry           │ bind error            │ address gone / adapter down
     └──────────────────────────┴───────────────────────┘
                                        │  5 rapid failures
                                        ▼
                                      down (explicit restart required)
```

- **`waiting`** — no valid Tailscale address. **No socket exists.** The module is started and healthy
  enough for the core to run; `/api/health` reports `remote: degraded` with the reason string, and
  the local UI shows "Remote access unavailable — Tailscale is <state>".
- **Retry backoff** — 2 s, doubling to `remote.detect.retryMaxMs` (default 120 s), with jitter.
- **`listening`** — bound. A watcher re-runs detection every `remote.detect.pollMs` (default 30 s).
- **Address disappears while listening** — the socket is closed **immediately and unconditionally**,
  all open WS/SSE connections are terminated, and the module returns to `waiting`. Fail closed: an
  adapter that went away must never leave a socket that a re-appearing interface with a different
  owner could inherit.
- **Address *changes*** (tailnet re-key, node re-registration) — close, re-validate the new candidate
  through §2.1 from scratch, rebind. Tokens are not address-bound, so nothing else is invalidated.
- **`down`** — 5 bind failures within 10 minutes (the realistic cause is `EADDRINUSE` on 7478).
  Health goes `unhealthy` with the actionable message; retries stop until `POST /api/remote/restart`
  (§5.5) or a core restart. Endless retry against a permanently occupied port is log spam pretending
  to be resilience.

**Tailscale down at boot** and **Tailscale drops later** are therefore the same state, reached from
two directions, with one recovery path. That is the point of modelling it as a state machine rather
than as boot-time detection plus an error handler.

**Running sessions are unaffected by any of this.** The runner lives in the core process; losing the
tailnet loses the *view*, never the work. A remote client that reconnects after an outage replays
from `/api/events?since=<watermark>` and tails transcripts by byte offset (foundation §1.5, §6.5) and
finds its session exactly where it left it. This is the single most important consequence of
foundation §4.1's headless core, and remote depends on it completely.

---

## 3. Route surface

### 3.1 Policy decision: authenticated-default with a declared deny list

**Decision: default-allow-authenticated, not an explicit allowlist.**

An allowlist would mean every route any element adds is remotely broken until someone remembers to
add it here — and the failure is silent, discovered on a phone, at the worst moment. That is exactly
the drift foundation §6.4 rejected two implementations to avoid; an allowlist reintroduces it as a
config file instead of as code. Default-allow also matches the product promise: runner §15.2 pins
"all session controls available identically over the tailnet", ui's README pins "an unanswered
question should never be stranded on the desktop". The safe default for a transport whose only user
is the machine's owner, holding a 256-bit token, over a WireGuard mesh, is *allow*.

The remote middleware applies four rules, in order:

| # | Rule | Response |
|---|---|---|
| 1 | **Static shell bypass** — the SPA bundle foundation §6.4 serves on both listeners (`GET /`, `/assets/*`, `/index.html`, favicon, service worker) **and its history fallback** for any other non-`/api` `GET`: served **without** a bearer token. They contain no data; the phone must be able to load the app — including a deep-linked route arriving from an ntfy notification — before it can authenticate. | 200 |
| 2 | **Deny list** — path matches a denied pattern (§3.2). Evaluated *before* auth so a denied route cannot be used as a token oracle. | `403 route_denied_remotely` |
| 3 | **Bearer auth** — everything under `/api/**` (§4). | `401 unauthorized` |
| 4 | **Per-agent grant gate** — only on the launch verbs of §6.2. | `409 remote_access_required` |

### 3.2 The deny list

Two sources, both enforced:

**(a) Declared at registration.** Foundation's `registerRoutes(router)` gains optional per-route
metadata `{ remote: 'allow' | 'deny' }`, defaulting to `allow`. An element that adds a route which
must never be remote says so where the route is defined, next to the code that makes it dangerous.
Raised as reconciliation **R1** (§13).

**(b) Remote's own hardcoded pattern list**, as belt-and-braces for a future route that forgets the
flag:

| Pattern | Verdict | Why |
|---|---|---|
| `POST /api/service/shutdown` | **deny** | The one action whose effect removes the ability to undo it: shutting down the core kills the listener that would restart it. Remote users stop *sessions*, not the service. |
| `POST /api/secrets/**`, any route declaring it accepts a secret value | **deny** | A remote token must not be able to write a credential into the machine's secret store. Foundation ships no such route in v1; the pattern exists so the first one is denied by default rather than by memory. |
| `POST /api/remote/tokens` | **deny** | Minting a *new* long-lived credential from a stolen one is privilege continuation. Local-only (§4.2). |
| `POST /api/remote/restart`, `PUT /api/remote/enabled {enabled:true}` | **deny** | See the loosening principle below. |
| `GET /api/logs/download` | **allow** | It is a zip of already-redacted logs, and remote diagnosis of a remote incident is precisely when you need it. |
| `GET /api/config/effective` | **allow** | Already secret-redacted by foundation §2.4, and it is how the client learns the edition and capability set. |
| **everything else** | **allow (authenticated)** | §3.1. |

**The loosening principle**: *a remote client may always reduce remote privilege; only a local action
may restore it.* Revoke a token remotely — yes. Mint one — no. Disable remote access entirely from
your phone — yes. Re-enable it — no. Restart the listener — no (it is not a reduction, and a bricked
listener needs someone at the machine anyway).

There is **exactly one deliberate exception**: the per-agent remote-access grant (§6.1) is a
loosening action that is allowed remotely, because D5 mandates it and because it is bounded three
ways — scoped to one agent, time-limited (§6.3), and reachable only by an already-valid token. It is
called out here so the exception is a decision rather than an inconsistency.

### 3.3 `GET /api/fs/browse` — decided: **allowed**

The brief's specific open question. Allowed remotely, authenticated, unchanged from projects' local
behaviour (rooted in `projects.browseRoots`, directory names only, never file contents, `..`
traversal rejected).

Rationale, in order of weight:

1. **Refusing it would be security theatre.** The same token, on the same request, may start an agent
   session with write permissions inside those very directories. A token that can run `Bash` in a
   folder but may not list its subfolder names is not a smaller privilege — it is the same privilege
   with a worse UI.
2. **Refusing it breaks D3.** Projects §7.9 built the endpoint *specifically* so quick-add works
   without Electron's native dialog. Denying it remotely strands project registration on the desktop,
   which is the exact "one UI codebase, two delivery modes" failure D3 exists to prevent.
3. **Projects already scoped it as a remote-reachable surface** (projects D5). The hardening is
   already in the endpoint, where it belongs, rather than duplicated in a transport.

Remote adds two things on top, both cheap: every remote `fs/browse` request logs its **resolved**
path to `access.log` at `info` (this is the one route where the audit trail is the control), and it
is subject to a 60-requests-per-minute per-token bucket so a token holder cannot cheaply enumerate
the profile tree. One hardening request goes back to projects: **resolve junctions and symlinks
before the root check** — Windows directory junctions inside `%USERPROFILE%` are a real containment
escape and a lexical prefix check does not catch them (reconciliation **R7**, §13).

### 3.4 Streaming over the tailnet

The live surfaces are foundation's `/api/events` and `/api/logs/stream`, and runner's
`/api/sessions/:id/stream`. Remote does not add streams; it makes the existing ones authenticable
from a browser, which is a genuine problem: **`new WebSocket(url)` and `new EventSource(url)` cannot
set an `Authorization` header.**

Options weighed: the `Sec-WebSocket-Protocol` subprotocol smuggle (works for WS, not SSE, and abuses
a field with its own semantics); `?access_token=` in the query string (puts a long-lived credential
in URLs, browser history, and `access.log`); a session cookie (needs `Secure` to be respectable,
which needs TLS, which v1 does not have — §9.2 — and adds a CSRF surface where there is currently
none).

**Decision: single-use stream tickets.**

```
POST /api/remote/stream-ticket        Authorization: Bearer <token>
  → { ticket: "<32 bytes base64url>", expiresAt, ttlSec: 30 }

GET  /api/events?ticket=<ticket>      (WS upgrade or SSE)
```

- Minted in memory only, never persisted, bound to the issuing `tokenId`.
- Single use: consumed at connection establishment; a replayed ticket is refused.
- 30 s TTL (`remote.stream.ticketTtlSec`).
- The connection inherits the token's identity for the whole of its life, so revoking the token kills
  the stream (§4.5).
- `ticket=` is scrubbed from `access.log` query strings alongside foundation §5.4's existing
  redaction (reconciliation **R3**).

Works identically for WS and SSE, keeps the durable credential out of every URL-shaped place, and is
about forty lines. The client's flow is: hold the bearer, POST for a ticket, open the socket,
discard the ticket.

**Heartbeats.** A phone that drives out of coverage leaves a half-open connection holding a
token-connection map entry. Server pings every `remote.stream.heartbeatMs` (30 s); two missed pongs
closes. SSE gets a comment-frame keepalive on the same interval. Mobile clients need this; local
Electron clients never noticed its absence.

**Reconnection is foundation's mechanism, not a new one**: replay `/api/events?since=<lastEventId>`,
then tail transcripts from the last byte offset (runner §15.2, contract 12). Remote guarantees only
that the watermark survives a disconnect on the client side — which it does, because the client
stores it.

---

## 4. Authentication

### 4.1 Storage (unchanged from foundation §3.4)

`remote_tokens(id, label, device, token_hash, token_prefix, created_at, last_used_at, expires_at,
revoked_at)`. `token_hash = sha256(token)`; plaintext is never stored, logged, or recoverable. Remote
ships one module migration adding `last_used_peer TEXT` (the peer IP, plus the node name when the
CLI peer map resolves it) so "which device last used this token" is answerable during an incident.

Note a correction to foundation §3.2: verification is a hash comparison against a **database column**,
not a `SecretStore` read — remote never calls `.reveal()` at all (reconciliation **R5**).

### 4.2 Generation

- **Entropy**: 32 bytes from `crypto.randomBytes`, base64url — 43 characters, 256 bits. Brute force
  is not a threat model; the rate limiting in §4.6 exists for audit sanity and misconfiguration, not
  for cryptographic margin.
- **Where in the UI**: Settings → Remote Access, reachable **from the local listener only**
  (`POST /api/remote/tokens` is on the deny list, §3.2). Creating a device credential is a
  deliberate act performed at the machine.
- **Display-once**: the plaintext is in the creation response body and nowhere else. The UI shows it
  as copyable text **and as a QR code** encoding
  `http://<magicdns-name>:7478/#t=<token>` — because typing 43 base64url characters into a phone is
  how a good security decision becomes a user who writes the token in a note app. The token rides in
  the URL **fragment**, which browsers never send to the server, never write to `access.log`, and
  which the client strips from `location` immediately after reading (§8.1).
- **`maxActive`** (default 10) caps live tokens; the cap is a hygiene guard against accumulating
  forgotten devices, not a security control.

### 4.3 Per-device tokens

One token per device, always. `label` is the human name ("Pixel 9", "work laptop"), required and
non-empty; `device` is the client's self-reported platform string, advisory only. The list view shows
label, `token_prefix`, `created_at`, `last_used_at`, `last_used_peer`, and expiry — never the token.

Per-device is not optional bookkeeping: it is what makes revocation surgical. Losing a phone must not
mean re-pairing every device.

### 4.4 Expiry and rotation

- **Default TTL 90 days** (`remote.token.ttlDays`; `null` = never expire, allowed but flagged in the
  UI). The client surfaces a warning at 14 days remaining, because a credential that expires silently
  while you are away is worse than one that does not expire.
- **No in-place rotation.** Rotation is "create new, then revoke old" — the same two calls, with a
  window where both work, which is the only way to rotate a device you are not standing next to.
  In-place rotation would need the plaintext to travel twice for no benefit.
- Expired tokens stay in the table (greyed in the UI) until deleted, so `last_used_at` remains
  auditable.

### 4.5 Revocation

`DELETE /api/remote/tokens/:id` sets `revoked_at`. **Allowed remotely** — the "I left my tablet on a
train" case is the one where you are, by definition, not at the machine.

Revocation is effective immediately and **also terminates every live WS/SSE connection bound to that
token**. The listener keeps a `tokenId → Set<connection>` map for exactly this; without it, a revoked
device keeps streaming session output indefinitely, which would make the revoke button a lie.

Revoking the **last** active token additionally clears every per-agent remote grant (§6.3) — no
remote identity exists, so nothing should stay pre-authorized for one.

### 4.6 Failure handling, rate limiting, lockout

- Comparison is `crypto.timingSafeEqual` over the SHA-256 digests, after an indexed lookup by
  `token_prefix`. Prefix lookup narrows to one row; the constant-time compare is what decides.
- **Every failure returns an identical `401 {"error":"unauthorized"}`** — unknown, malformed,
  expired, and revoked are indistinguishable to the caller. No oracle.
- **Per-peer sliding window**: `remote.auth.maxFailures` (10) failures within
  `remote.auth.failWindowMs` (5 min) from one peer IP → that peer is blocked for
  `remote.auth.blockMs` (15 min), answered `429` with `Retry-After`. In-memory; a process restart
  clears it, which is acceptable because an attacker on the tailnet cannot restart our process, and
  because the outer boundary (tailnet membership) has already been passed by anyone who can reach
  the socket at all.
- **Deliberately not implemented: auto-revoking a token after N failures.** It sounds stronger and is
  weaker — the 6-character prefix is visible in the UI and in logs, so anyone who could brute-force
  could instead cheaply *revoke* every device by failing against known prefixes. Availability loses
  nothing real here: 256 bits does not fall to a 10-attempts-per-5-minutes budget.
- The first failure in a window and every block event log at `warn` to `access.log` and raise a
  persisted `remote.auth.failed` event, so the UI can show "3 failed remote sign-ins from 100.x.y.z".
  Repeat failures inside a window do not each emit an event — that is how a brute-force attempt
  becomes a self-inflicted log flood.
- Success updates `last_used_at` / `last_used_peer`, throttled to at most one write per token per
  60 s. Every authenticated request writing a row would make an SSE reconnect storm a write storm.

---

## 5. Remote's own routes

All under `/api/remote`, registered on foundation's shared route table like everyone else's. They
exist only in the home edition with the module loaded — the UI must feature-detect from
`/api/config/effective` and `/api/health`, never from a 404 (§12, contract 6).

```
GET    /api/remote/status              state, boundAddress, port, magicDnsName, tailscaleState,
                                       activeTokenCount, lastError
GET    /api/remote/tokens              list; never plaintext
POST   /api/remote/tokens              LOCAL ONLY — { label, device?, ttlDays? }
                                       → { id, token, prefix, expiresAt, qrUrl }   (token shown once)
DELETE /api/remote/tokens/:id          revoke; allowed remotely
POST   /api/remote/stream-ticket       single-use WS/SSE ticket (§3.4)
GET    /api/remote/agents              per-agent grants: { agentId, enabled, grantedAt, expiresAt,
                                       grantedVia }
PUT    /api/remote/agents/:id/access   { enabled: boolean } — the grant gate (§6.1)
PUT    /api/remote/enabled             { enabled } — global kill switch; false allowed remotely,
                                       true LOCAL ONLY
POST   /api/remote/restart             LOCAL ONLY — listener restart without a core restart (§10.3)
```

`remote.enabled` is a **`settings`** value, not config (foundation §2.4): it is a runtime toggle the
UI owns. Setting it false closes the socket and enters `waiting` without clearing grants or tokens,
so re-enabling does not re-nag the user through every consent prompt again.

---

## 6. Per-agent remote access

### 6.1 Storage and ownership

**Decision: foundation's `settings` table, one row per agent, key `remote.agentAccess.<agentId>`,
owned by the remote module.**

Foundation §1.4 already names "per-agent remote allowance" as a `settings` example, so this is
consistency with wave 1 rather than a new choice — but the reasons matter:

- Roster's `library/agents/<id>/agent.json` is **authored, git-versioned, portable content that must
  be identical in both editions** (roster §13, D6). A machine's remote posture is not a property of
  the agent; committing "this persona may be launched from a phone" would be committing a fact about
  one Windows box.
- It is toggled by the UI at runtime, which is precisely foundation §2.4's definition of `settings`
  rather than config.
- Roster explicitly declined remote-specific fields ("no roster-specific remote logic", roster D5).
  Putting the flag there would force roster to own a concept it disclaimed.

Value shape: `{ enabled: true, grantedAt, expiresAt, grantedVia: 'local' | 'remote', tokenId? }`.
Rows are deleted rather than set to `enabled: false` — absence is the disabled state, so a sweep has
nothing to garbage-collect.

This needs one small foundation addition: `settings.listByPrefix(prefix)` for the expiry sweep and
the list endpoint (reconciliation **R2**).

### 6.2 What the flag gates — and what it must never gate

Three tiers, and the boundaries are load-bearing:

| Tier | Verbs | Gated by the flag? |
|---|---|---|
| **Observe** | list roster/projects/sessions, read a session, tail a transcript, stream events, read logs | **No.** Watching is the point of remote. |
| **Restrain** | `POST /api/sessions/:id/stop`, `/pause`, `PUT /api/runner/capacity` (lower only, runner §15.3 #17) | **No — never.** Stopping a runaway agent from a phone must work for *any* agent, including one whose grant expired an hour ago. A safety valve behind a consent gate is not a safety valve. |
| **Initiate** | **Every session-initiating surface**: `POST /api/assignments/solo`, `POST /api/assignments`, `POST /api/assignments/:id/advance`, `POST /api/sessions` (where it exists as a raw route), `POST /api/sessions/:id/continue`, `POST /api/sessions/:id/steer` | **Yes.** These are the verbs that make an agent do new work. |

**The gate binds to launch semantics, not to a route name.** The rule is: *any route that can cause a
session to start, resume as new work, or receive new instructions is gated, for every agent it would
put to work* — and the tier list above is an enumeration of that rule as of v1, not its definition. An
element adding a route that starts sessions inherits the gate by virtue of what it does; if it is not
listed here, the list is out of date, not the route exempt. This is stated as a principle because the
enumeration was already wrong once: it named only `POST /api/sessions`, while the product's actual
launch path is `POST /api/assignments/solo` (orchestrator §11.1, and pinned in its §16.7) for a
drag-and-drop launch and `POST /api/assignments` for a pattern, so a remote client could start an
agent with no grant simply by using the endpoint the UI actually calls (ui §19, R3). A gate defined
over route names drifts silently the moment the launch path moves; one defined over launch semantics
does not.

`/steer` is in the gated tier because it injects arbitrary new instructions into a live session; it
is initiation wearing a continuation's clothes. `POST /api/assignments/:id/advance` is in it for the
same reason: it plans and starts the next turn, which is new work for whichever seats that turn fills.

**The gate binds to *client-initiated* launch routes, and deliberately not to engine-driven ones.**
Sessions the system starts on its own — runner's auto-resume of a session it parked on a question
(runner §5.4), and the pattern engine planning the next turn after `session.ended` or an answered
question (orchestrator §3.1) — pass through no HTTP route, carry no bearer token, and have no remote
request context to evaluate a grant against. They are out of the gate's scope by design, not by
oversight: the grant was already checked when the human started the assignment, and re-checking it
mid-pattern would strand a half-finished collaboration whenever a 72-hour grant lapsed between rounds.
The gate's question is *"may this remote client put this agent to work?"*, asked once at the point a
client asks; it is not a per-session execution permit. Revoking a grant therefore stops **new** remote
launches immediately and leaves work already in flight to finish — and the Restrain tier, ungated in
both directions, is how that work is stopped if the user wants it stopped.

**Assignments have members, so the gate is evaluated per agent and reported as a set.** A pattern
launch puts ≥2 agents to work; the request is refused unless **every** agent it would start holds a
live grant, and the `409 remote_access_required` body carries the full list of ungranted agents
(§6.3) so the client prompts once for all of them rather than N times through N retries.
`confirmRemoteAccess` is honoured on all of these routes, granting each listed agent and proceeding
atomically.

**Answering a question is in the Observe tier and is a hard invariant** (§7.4): it is never gated by
the flag, never on the deny list, never rate-limited beyond the global bucket. Gating it would
recreate exactly the failure ui's README forbids — a question stranded on the desktop.

### 6.3 The grant flow, the auto-enable rule, and the disable rule

**Grant / auto-enable.** A remote call to any initiating route of §6.2 — `POST
/api/assignments/solo`, `POST /api/assignments`, `POST /api/assignments/:id/advance`, `POST
/api/sessions`, `/continue`, `/steer` — naming one or more agents without a live grant returns:

```
409 { "error": "remote_access_required",
      "agents": [ { "agentId": "ada-architect", "agentName": "Ada" },
                  { "agentId": "sam-skeptic",   "agentName": "Sam"  } ] }
```

The list is always present, even for a solo launch of one agent, so the client has one shape to
handle. The client shows *"Allow **Ada** and **Sam** to be started remotely?"*, the user taps once,
the client grants each with `PUT /api/remote/agents/:id/access {enabled:true}`, and **retries the
original request**. The client may skip the round trip by sending `confirmRemoteAccess: true` in the
request body, which grants every named agent and starts atomically.

This satisfies D5's "remote access auto-enables when an agent is started remotely" — the enable
happens as part of the remote start, needing no trip to the desktop — while keeping it an *act*
rather than an invisible side effect. A grant that appeared with no user gesture would be a
permission the user could not remember agreeing to, and the roster board would sprout enabled flags
nobody set.

**The disable rule** (D5 requires this be defined precisely). A grant ends when **any** of:

| Trigger | Behaviour |
|---|---|
| **TTL expiry** — `remote.agentAccess.ttlHours`, default **72 h**, measured from the last remote start of that agent (sliding, not fixed) | Row deleted, `remote.agent.access.expired` emitted (persisted), the board card updates live |
| **Explicit toggle off** — roster board card or the remote settings screen, local or remote | Immediate |
| **Agent archived, deleted, or purged** — on roster's `roster.changed` bus event | Immediate |
| **Last active token revoked or expired** (§4.5) | All grants cleared |
| **Global `remote.enabled: false`** | Grants **survive**, all remote initiation is blocked anyway |

**Session end does not end a grant, and that is the decision, not an oversight.** The obvious reading
of D5 is "auto-off when the session finishes", and it is wrong in practice: the normal remote pattern
is start something, watch it finish, start the next thing ten minutes later. Consent-per-session
means a confirm dialog several times an hour, which trains the user to tap through prompts without
reading them — turning the one meaningful consent gate into muscle memory. A 72-hour sliding window
covers a working session or a weekend away, and self-clears over a week of non-use. Explicit-only
(never expiring) was rejected for the opposite reason: a grant nobody remembers granting is a grant
nobody will revoke.

Expiry is evaluated **lazily on read** (so a grant is never honoured past its deadline even if the
sweep is late) **plus** a boot sweep and an hourly sweep whose only job is emitting the events that
keep the UI honest.

---

## 7. Remote start/stop semantics

### 7.1 A remote start is a local start with a different origin

Per runner §15.3 #15, there is **no remote-specific launch path**. A remote client calls the same
route the local one does — **`POST /api/assignments/solo`** for a drag-and-drop launch (§6.2, §6.3;
orchestrator §16.7 pins it), or `POST /api/assignments` for a pattern — and orchestrator creates the
assignment and starts the first session in that one call, exactly as it does locally; runner reads
`origin: 'remote'` from foundation's request context and stores it on `sessions.origin`. Remote's
entire contribution to a launch is: authenticate, mark the origin, check the grant.

Consequently a remote client can launch anything a local client can — same agents, same projects,
same assignment patterns — subject only to §6.2's grant. Anything narrower would be a second launch
surface to keep in sync, which is the failure foundation §6.4 designed against.

### 7.2 Confirmation friction: the grant, and nothing else

**Decision: no per-start confirmation beyond the once-per-72-hours grant.** Repeated friction is
tapped through; it produces the *feeling* of a control and none of the effect. What remote provides
instead is **auditability**, which is the property that actually survives contact with a hurried
user:

- every remote request in `access.log` with `tokenId`, prefix, peer, and (best-effort) node name;
- `sessions.origin = 'remote'` on the row, which the desktop UI renders as a "started remotely" badge
  on the session and the timeline;
- persisted `remote.agent.access.granted` / `.revoked` / `.expired` events, so the grant history is
  reconstructable.

Stop and pause carry no friction at all, in either direction.

### 7.3 Permission modes: the pinned contract wins, and here is how the intent is met

The brief asks whether remotely started sessions should carry restricted permission modes by default.
Runner §15.3 #16 pins that they must not, and **that contract wins**. The reasoning is not
deference — it is that the alternative is genuinely worse:

A remote-only permission restriction is a rule that exists nowhere the user can see it. Roster's
permission preview (roster §6.2) composes agent baseline + project override + assignment scope and
shows the result; a transport that silently subtracted from that would make the preview wrong
whenever it mattered most, and would produce the worst class of support question — "it works at my
desk and fails from my phone" — with the answer hidden in a middleware.

The requirement's *intent* — "don't let a phone tap unleash something destructive unattended" — is
met by four mechanisms that are all visible:

1. **The per-agent grant (§6)** is the actual remote gate, and it is per-agent, expiring, and
   auditable. An agent you have not consented to remote-starting cannot be remote-started.
2. **The question inbox works remotely (§7.4)**, so an `ask` rule is a live prompt on your phone
   rather than a dead end. This is what makes "unattended" not the same as "remote": you are
   reachable.
3. **`policy.globalDeny`** (foundation §2.3) is the machine-wide, un-overridable lever for "never
   this, from anywhere" — the honest place for `Bash(git push*)`-class rules.
4. **A project's `PermissionOverride` or an agent's baseline** is where a cautious profile belongs, as
   runner says — composed by roster, previewable, editable, and identical whether you launch from the
   desk or the train.

If an origin-conditional permission profile is ever genuinely wanted, the right shape is an explicit
**launch profile** the user selects (and that roster composes), not an implicit function of the
transport. Deferred, and named as deferred (§14) so a later wave does not "discover" it as a gap.

### 7.4 The question inbox, end to end, from a phone

This path is the element's acceptance test as much as its design. Nothing in it is remote-specific
except authentication.

1. An agent's tool call reaches `canUseTool`; runner calls orchestrator's `QuestionBridge.ask()`
   (runner §5.2). A row lands in `questions`; `question.raised` is emitted with `persist: true`.
2. **Live case** — the phone holds a WS to `/api/events` (authenticated by a §3.4 ticket). The event
   arrives in the same tick it is emitted. **Cold case** — the phone was asleep; on wake the client
   replays `/api/events?since=<watermark>` and reconciles with `GET /api/questions?status=open`, so a
   question raised during the outage is present, not merely missed.
3. The user answers: `POST /api/questions/:id/answer`. Foundation's request context supplies
   `origin: 'remote'`; orchestrator writes `answered_via = 'remote'` (foundation §1.4). **Remote
   applies no gate here** (§6.2) — the flag, the deny list, and the grant TTL are all bypassed by
   construction for this route.
4. **Inside runner's 15-minute hold**, the pending `canUseTool` resolves *inline*: the agent never
   left the tool call, and the next token the model sees is the tool result (runner §5.3). A phone
   answer and a desktop answer are byte-identical at this point.
5. **After the park**, runner's stage-3 auto-resume fires on the answer, re-queues the session at
   `interactive` priority, and injects the answer as the first turn (runner §5.4 and §15.1 #7).
   **This works unchanged when the answer arrives from a phone browser**, because the resume trigger
   is the answered row, not the answering client. Remote does nothing to make it work and must do
   nothing to break it — specifically, it must not gate `/answer` behind a grant that expired while
   the session sat parked, which is why §6.2 puts answering in the ungated tier.
6. The phone observes `session.question.answered` and `session.resumed` on the same stream it was
   already holding.

**The gap in the browser, and what closes it**: with no browser tab open, nothing reaches the user
*through this transport*. Foreground and backgrounded tabs get the WS; a closed tab gets nothing.
**Browser** Web Push needs HTTPS and a service worker, which needs `tailscale cert` (§9.2), so it
stays deferred together with TLS (§14) — that reasoning is unchanged.

What closes the gap in v1 is a channel that does not travel over this transport at all.
**Orchestrator owns the away-notification question and has decided it: the v1 push channel is
[ntfy](https://ntfy.sh)** (orchestrator §10) — one outbound HTTPS POST from the core to a
user-configured topic, delivered by the ntfy app to a phone that need not be on the tailnet. Remote's
side of that decision:

- **It is out-of-band.** The notification does not ride remote's listener, needs no inbound port, and
  is unaffected by TLS being deferred here. Remote neither implements nor gates it.
- **It carries no content.** The payload is a generic "AgentManager needs you" plus a **tailnet deep
  link** to the question card. No question text, no agent names, no project or path names, no session
  ids, no token — **nothing of substance transits ntfy's servers**, which is what makes a third-party
  relay acceptable at all under D5.
- **The link is not an authorization.** Tapping it opens the tailnet URL, which still requires the
  device to be on the tailnet and still requires the bearer token (§4). A notification wakes the user;
  the tailnet serves the answer. The API remains Tailscale-only.
- **The topic URL is a secret.** An ntfy topic URL is a capability URL — anyone holding it can post to
  it — so it lives in foundation's secret store as `notify.ntfy.topicUrl` (foundation §3.3), never in
  config and never in the library.

So the v1 answer is: **the tailnet browser is the surface, and ntfy is the wake-up** — with browser
Web Push as the successor once TLS lands, at which point the third party is no longer needed at all.
Named rather than hand-waved, because an approval gate nobody sees for six hours is that question's
whole point.

---

## 8. The browser client's side of the contract

### 8.1 Token acquisition and storage

- **Pairing**: scan the QR from the local settings screen → the phone opens
  `http://<magicdns>:7478/#t=<token>`. The client reads `location.hash`, stores the token, and calls
  `history.replaceState` to strip it before anything can screenshot or bookmark it. Manual paste is
  always available.
- **Storage**: `localStorage` under one key, alongside the label the server returned. Not
  `sessionStorage` — a phone that forgets its credential on every tab close is a phone whose owner
  writes the token in a notes app. Not a cookie — no TLS in v1 means no `Secure` flag, and cookies
  would add a CSRF surface where a header-only scheme has none.
- The XSS caveat is real and bounded: the app serves no third-party script and ships a strict CSP
  (§9.2). This is the same trust boundary as the app itself.

### 8.2 Status codes the client must distinguish

| Code | Meaning | Client behaviour |
|---|---|---|
| `401 unauthorized` | absent/invalid/expired/revoked token | Clear stored token, show the pairing screen. Never retry. |
| `403 route_denied_remotely` | §3.2 | Show "not available remotely"; **never retry** and never surface as a network error. |
| `409 remote_access_required` | §6.3 | Show the grant prompt, then retry the original request. |
| `429` | auth lockout or a route bucket | Honour `Retry-After`. |
| `503 remote_unavailable` | listener in `waiting` — only reachable locally | Local UI shows the Tailscale state from `/api/remote/status`. |

---

## 9. Edition and security invariants

### 9.1 Restated from foundation (binding, not commentary)

1. **The work edition never loads this module.** Dynamic import behind
   `edition === 'home' && modules.remote.enabled` (foundation §6.2); the schema rejects the
   combination outright (§2.2); foundation's M7 acceptance asserts the module file is never imported.
2. **The post-start bind assertion** (foundation §6.3) is authoritative. Remote publishes
   `ctx.provide('remote', { boundAddress(): { address, port, source } | null })` so the assertion
   reads the claim rather than inferring it (reconciliation **R4**), and remote independently
   re-validates the same address through §2.1 immediately before `listen()`. Two independent checks
   on the same fact, deliberately.
3. **No secrets over the wire.** Token plaintext appears exactly once, in the creation response, on
   the **local** listener only. `/api/config/effective` is redacted by foundation. Error bodies never
   echo credentials. `ticket=` and `Authorization` are scrubbed from `access.log` (**R3**).
4. **Every remote request is access-logged** — method, path, status, duration, `origin: 'remote'`,
   `tokenId`, `token_prefix`, peer IP, resolved node name, `requestId`. Auth failures at `warn`.
5. **Only the remote module may own a non-loopback socket**, and only one.

### 9.2 Added by this element

6. **Peer-address validation.** A connection whose remote address is not inside `100.64.0.0/10` is
   refused before any routing. Bound to a Tailscale-only address this should be unreachable; it costs
   five lines and catches the misconfiguration that would otherwise be silent.
7. **`Tailscale-*` request headers are explicitly ignored.** We bind a raw socket rather than sitting
   behind `tailscale serve`, so any such header is attacker-supplied. Identity headers are a *deferred*
   feature (§9.3), and until then trusting them would be strictly worse than not having them.
8. **`Host` header allowlist** — the bound IP, the MagicDNS name, and `remote.hostnameHint`; anything
   else gets `421 Misdirected Request`. Defence in depth against DNS rebinding from a browser that is
   itself on the tailnet. The bearer token already defends this, which is why it is a cheap second
   layer rather than the primary one.
9. **No CORS headers, ever.** The client is served same-origin by this listener; `Access-Control-Allow-Origin`
   is never set. Plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a strict CSP
   with no third-party origins, and `Cache-Control: no-store` on every `/api` response.
10. **Plain HTTP over the tailnet in v1.** WireGuard already provides device-to-device confidentiality
    and authenticity; adding `tailscale cert` + certificate renewal to v1 buys little and costs a
    renewal failure mode. It is deferred (§14) and its absence is what forces the ticket scheme (§3.4)
    and blocks Web Push (§7.4) — those dependencies are stated so the deferral is priced honestly.

### 9.3 Tailscale identity cross-check — **deferred**, with a v1 substitute

Full identity-based authorization (`Tailscale-User-Login` / `tailscale whois`, tying a token to a
tailnet node or user) is deferred past v1. It requires either running behind `tailscale serve` — a
different deployment shape with its own TLS and lifecycle — or the Administrators-scoped LocalAPI,
which foundation's non-admin install forbids. And with a single-owner tailnet (foundation §7), it
authenticates the same person twice.

**The v1 substitute, which is real and cheap**: peer IP → node name enrichment for `access.log` and
the token list, resolved from the cached `tailscale status --json` peer map (60 s TTL, refreshed by
the detection poll that already runs). "Token *phone* used from node *pixel-9*" is a genuinely useful
audit line. It is **never** an authentication or authorization input — if the map is stale or absent,
the request proceeds and the field is `null`.

---

## 10. Failure modes

### 10.1 Token brute force

Bounded by §4.6: identical 401s (no oracle), per-peer sliding-window block, constant-time comparison,
`warn`-level audit on the first failure and on every block, one persisted event per window. 256-bit
tokens make the arithmetic uninteresting; the mechanisms exist so an attempt is *visible*, not so it
is *expensive*.

### 10.2 Tailscale interface changes mid-session

Covered by §2.3. The socket closes, streams die, sessions keep running, the client reconnects and
replays. The three things that must not happen and are individually tested (§11, M10): binding a
non-Tailscale address after a change; leaving a socket open on a departed address; and losing a
running session because its viewer disconnected.

### 10.3 Listener crash — restart the module, not the core

Foundation §6.1's `ModuleHandle.start()` / `stop()` is exactly the mechanism: an uncaught listener
error closes the socket, terminates connections, logs, and re-enters `waiting` with backoff. The
**core process, the runner, and every running session are untouched** — which is the whole reason a
non-critical module boundary exists. `POST /api/remote/restart` (local-only) forces a full
detect-and-rebind cycle for the `down` state. Remote is never `critical: true`: a broken remote
listener must not take down a machine that is happily running agents locally.

### 10.4 The rest

| Failure | Behaviour |
|---|---|
| Port 7478 occupied | Module unhealthy with the actual `EADDRINUSE` message and the port number; core keeps running; `remote.port` is one config key away. |
| Tailscale CLI missing or hung | 5 s timeout → interface-enumeration fallback → `warn` + degraded health, not a failure. |
| Two candidate Tailscale addresses | Refuse to bind; `waiting` with an explicit "ambiguous interface" reason. Never guess. |
| Clock skew across expiry boundaries | All comparisons in UTC ISO through `ctx.clock`, so tests are deterministic and DST does not move a token's expiry. |
| Half-open mobile connections | Heartbeat + 2-missed-pong close (§3.4). |
| Grant sweep missed (machine asleep) | Lazy read-time evaluation means an expired grant is never honoured regardless of sweep timing (§6.3). |
| Revoked token holding a live stream | Connection map + terminate on revoke (§4.5). |

---

## 11. Configuration (module sub-schema, contributed per foundation §2.1)

```jsonc
"remote": {
  "bind": "tailscale",            // v1 schema accepts this literal ONLY — an IP literal is rejected,
                                  //   because a config-editable bind address is a hole through D5
  "port": 7478,                   // foundation §2.3
  "hostnameHint": null,           // foundation §2.3; MagicDNS name for the client URL / QR / Host allowlist
  "detect":      { "cli": null, "pollMs": 30000, "retryMaxMs": 120000 },
  "token":       { "ttlDays": 90, "maxActive": 10 },
  "auth":        { "maxFailures": 10, "failWindowMs": 300000, "blockMs": 900000 },
  "stream":      { "ticketTtlSec": 30, "heartbeatMs": 30000 },
  "agentAccess": { "ttlHours": 72 },
  "browseRateLimitPerMin": 60
}
```

`bind`, `port`, and `hostnameHint` are already in foundation §2.3; the rest is remote's namespace
extension. `remote.enabled` is deliberately **not** here — it is `settings` (§5).

---

## 12. Contracts pinned for ui

Binding outputs the UI element designs against.

1. **Token pairing**: QR encodes `http://<magicdns>:7478/#t=<token>`; the client reads
   `location.hash`, stores the token in `localStorage`, and `history.replaceState`s it away
   immediately. Plaintext is shown once, at creation, on the local listener only, and is never
   rendered again anywhere (the list shows label + prefix + last-used).
2. **All `/api/**` requests carry `Authorization: Bearer <token>`.** Never a query parameter, never a
   cookie. WS and SSE authenticate by POSTing `/api/remote/stream-ticket` and passing the single-use
   `?ticket=` (30 s TTL, one connection).
3. **Status codes** of §8.2 are load-bearing and semantically distinct: `401` = re-pair, `403` = never
   retry, `409 remote_access_required` = show the grant prompt then retry, `429` = honour
   `Retry-After`, `503` = listener down.
4. **The remote-access toggle** lives on the roster board card and in the remote settings screen,
   reading `GET /api/remote/agents`. It shows `expiresAt` — a grant with an invisible deadline is a
   grant the user will be surprised by. It updates live from `remote.agent.access.*` events.
5. **A remote launch may need one extra tap.** The launch flow must handle `409` inline (prompt →
   grant → retry), or pre-empt it by sending `confirmRemoteAccess: true`. It must never present the
   409 as an error.
6. **Feature-detect remote, never 404-detect it.** `/api/config/effective` (edition) plus
   `/api/health` (module list) tell the UI whether remote exists. In the work edition `/api/remote/*`
   does not exist at all, and probing it is indistinguishable from a routing bug.
7. **Everything works remotely except the §3.2 deny list.** Assume any route is remote-reachable; the
   deny list is short, stable, and enumerated in `GET /api/remote/status` so the UI can grey the
   affected controls rather than let the user discover them by 403.
8. **Answering a question is never gated.** The question inbox must be built assuming it always works
   remotely — no capability check, no grant check, no degraded mode (§7.4).
9. **`sessions.origin === 'remote'`** renders as a "started remotely" badge in the session view and
   the project timeline. This is the visible half of §7.2's audit-over-friction trade.
10. **Reconnection is replay, not reload.** Persist the `/api/events` watermark and the transcript
    byte offset across a disconnect; on reconnect, replay then resume the stream. A tailnet drop must
    not cost the user their place, and it must not trigger a full refetch.
11. **No *browser* push in v1; the wake-up is ntfy, out-of-band.** An open tab (foreground or
    background) receives events; a closed tab receives nothing over this transport, and the UI must
    not imply otherwise. Reaching a user with no tab open is orchestrator's ntfy channel
    (orchestrator §10, §7.4 above): a generic "AgentManager needs you" plus a tailnet deep link,
    carrying no question content. The UI may say a notification was sent; it must never suggest the
    notification carried the question or that answering is possible off the tailnet.

---

## 13. Reconciliations raised

Raised per CLAUDE.md's ground rule rather than silently diverged from. None blocks remote's
implementation; each is a small, additive change to a wave-1/2 element.

| # | Against | Request | Why |
|---|---|---|---|
| **R1** | foundation §6.4 | Add optional per-route metadata `{ remote: 'allow' \| 'deny' }` to `registerRoutes`, defaulting to `allow`. | §3.2's declared deny list. A route's remote policy belongs next to the code that makes it dangerous; remote's hardcoded pattern list should be the backstop, not the register. |
| **R2** | foundation §1.4 / settings repository | Add `settings.listByPrefix(prefix)` and `deleteByKey(key)`. | §6.1 stores one row per agent under `remote.agentAccess.<id>`; the sweep and the list endpoint need a prefix scan. Per-agent rows avoid read-modify-write races that one JSON blob would have. |
| **R3** | foundation §5.1 / §5.4 | `access.log` lines carry `tokenId` (not only `token_prefix`), and the redactor scrubs `ticket=` and `access_token=` from logged query strings. | §3.4 and §4. Prefixes collide in principle and are not a stable join key for incident review; a ticket in a log line is a (short-lived) credential in a log line. |
| **R4** | foundation §6.3 | Have the bind-time assertion read `ctx.require('remote').boundAddress()` rather than inferring which listener belongs to remote. | Makes the assertion compare two independently produced claims about the same socket instead of trusting a heuristic. |
| **R5** | foundation §3.2 | Correct the authorized `.reveal()` list: **remote does not call `.reveal()`.** Bearer verification hashes the presented token and compares against `remote_tokens.token_hash`. | The list is meant to be exact (runner raised the same list in its §15.4 #19); item 2 as written implies a stored-secret read that does not exist. |
| **R6** | foundation §6.4 / §5 | State explicitly that the **local** listener has no authentication, and that this is the intended trust boundary (any process running as the user can already read the DPAPI secrets). | Remote's policy is written as "auth is what the remote listener adds"; that only makes sense against a stated local baseline. |
| **R7** | projects §2.1 / D5 | `GET /api/fs/browse` must **resolve symlinks and directory junctions before** the browse-root containment check, and reject UNC/network paths. | §3.3 allows the route remotely. Windows junctions inside `%USERPROFILE%` defeat a lexical prefix check, and this is the one endpoint where containment is the whole control. |
| **R8** | orchestrator (away-notification channel) — **resolved, orchestrator's answer stands** | Remote asked for a channel that is not this one, having no *browser* push without TLS. Orchestrator answered with **ntfy** (orchestrator §10) and owns the question. Recorded here as the resolution: v1 push **is** ntfy, out-of-band via the ntfy app, carrying only a generic "AgentManager needs you" and a tailnet deep link — no question content, no secrets, nothing through a third party. Topic URL lives in foundation's secret store (`notify.ntfy.topicUrl`). Remote implements and gates nothing here; §7.4 is amended to match. | Remote's position ("no push") was scoped to its own transport and was correct about it — browser Web Push still needs `tailscale cert` and stays deferred (§14). The gap it named is closed by a channel that never touches this listener, which is exactly what remote asked for. |

---

## 14. Deliberately deferred past v1

| Deferred | Why / what would unblock it |
|---|---|
| **TLS via `tailscale cert` / `tailscale serve`** | WireGuard already encrypts device-to-device. Adds certificate renewal as a new failure mode. Unblocks: Web Push, `Secure` cookies, and identity headers — so it is the single highest-value deferral to revisit. |
| **Browser Web Push notifications for questions and approval gates** | Requires HTTPS + service worker (above). Until then, an open tab is remote's notification surface and orchestrator's ntfy channel is the out-of-band wake-up (§7.4). Web Push is the successor precisely because it needs no third party. |
| **Tailscale identity headers / `whois` authorization** | §9.3. Needs `tailscale serve` or the admin-scoped LocalAPI; authenticates the same single owner twice. The peer-name audit enrichment captures most of the practical value now. |
| **Tailscale ACL / tag-based authorization** | Single-owner tailnet (foundation §7). Meaningful only once more than one person or a service node exists. |
| **IPv6 binding** | IPv4 tailnet addressing is universal in practice; the ULA prefix is in the validator so an IPv6-only tailnet fails loudly rather than binding something unexpected. |
| **Origin-conditional permission profiles** ("cautious when remote") | §7.3. If ever wanted, it belongs in roster's composer as an explicit, previewable launch profile — never as an implicit function of the transport. |
| **A dedicated `remote_sessions` / device-session concept** | Tokens are the device identity; a second session layer over them buys nothing for one user. |
| **Token scopes** (read-only vs full tokens) | Attractive, but the per-agent grant already provides the meaningful split (observe/restrain vs initiate) without a second permission vocabulary the UI would have to explain. Revisit only if a genuine read-only-viewer use case appears. |
| **Remote service restart / update** | The loosening principle (§3.2): a remote action that can brick the transport it travels on needs someone at the machine. |
| **Non-Tailscale remote transports** (Cloudflare tunnel, reverse proxy, port forward) | D5 says Tailscale-only, and every alternative reintroduces the public-exposure risk the decision exists to eliminate. |

---

## 15. Architecture conformance

- **D1** — a TypeScript module under foundation's module contract; PowerShell appears only in
  `Test-AgentManagerHealth.ps1`'s existing Tailscale-detection line (foundation §4.4), never at
  runtime.
- **D2** — untouched. Remote never handles Claude auth; the bearer token is a separate credential
  with a separate store.
- **D3** — the tailnet browser and Electron are the same client against the same route table. Remote
  adds no endpoint the local UI cannot also call, which is what keeps them one codebase.
- **D4** — remote never mints assignments or routes work; `POST /api/sessions` requires an
  `assignmentId` from remote exactly as from local (§7.1).
- **D5** — §2 (validated Tailscale-only binding), §4 (bearer on every `/api` request), §6 (auto-enable
  on remote start and a precisely defined disable rule).
- **D6** — dynamic import, no `edition` branch anywhere inside this module, and the boundary suite of
  M10 proving the work edition cannot listen.
