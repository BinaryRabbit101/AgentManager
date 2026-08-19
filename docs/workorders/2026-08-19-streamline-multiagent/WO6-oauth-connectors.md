# WO6 — Claude MCP connectors: OAuth instead of stored creds, and no scavenging

**Elements:** roster (IntegrationConfig, compile), foundation (token storage decision), runner
(needs-auth flow), orchestrator (prompt guardrail), ui (preflight + auth action). **Amends:**
roster `DESIGN.md` §10 (integrations), foundation's secrets decision (extension, not
replacement), ui DESIGN §7.3.1 (integrations panel) and the Start-work section. **Depends on
WO4** (the preflight chips live in its Start-work surface).

## The incident (owner report, 2026-08-19)

An agent on a live assignment could not call the todo MCP server and responded by **searching
the machine for API credentials**. Two failures:

1. **The connector was unavailable at session time** — not attached to that agent, or attached
   but `failed`/`needs-auth` — and the session ran anyway with no instruction about what to do
   when a declared integration is missing.
2. **Credential-shaped auth is the wrong default.** The owner's direction: use Claude MCP
   connectors (OAuth-authorized remote servers) so agents need no API keys at all, and there is
   nothing on the machine worth scavenging for.

What already exists and must be built on, not duplicated: roster compiles `integrations` →
`mcpServers` with `secretRef` resolution that fails launches loudly (roster DESIGN §10);
`initMessage.ts` maps server status `needs-auth`/`failed` to distinct diagnostics; runner
surfaces the `needs-auth` actionable card (`launch.ts` ~1441). The gap is *when* these fire
(mid-run instead of preflight), OAuth as a first-class auth mode, and agent behaviour on a
missing tool.

## The fix

### 1. OAuth as a first-class integration auth mode (roster + foundation)

Extend `IntegrationConfig` for `http`/`sse` transports with `auth: 'oauth'` (mutually exclusive
with credential-bearing `headers`). An OAuth integration carries **no secretRef and no literal
credential** — the credential-shaped-key schema rule stays as-is for everything else.

**Verify before designing the mechanism:** the implementing agent must check the installed
`@anthropic-ai/claude-agent-sdk` (and `docs/orchestrator/SDK-NOTES.md`'s verification method —
static `sdk.d.ts` reading plus offline probe) for what the SDK actually supports for remote MCP
OAuth: how a server is declared, how the authorize flow is initiated, and where tokens are
cached. Design to that reality. Token storage follows foundation's secrets decision — wherever
the SDK caches them, the path lives under the data root, never in `agent.json`, git, or exports
(same posture as `CLAUDE_CODE_OAUTH_TOKEN`). If the installed SDK version cannot do headless
OAuth for remote MCP at all, say so in the report and ship items 2–4 anyway — they do not depend
on it.

### 2. Integration preflight at Start-work (ui + roster)

Alongside WO4's permission chips, per seated agent, render each declared integration with its
resolvable state: `ready` (stdio/creds resolve), `needs-auth` (OAuth grant missing/expired —
with an **Authenticate…** action that runs the flow *now*, before launch), `missing secret`
(link to the secrets setup), `not attached` (the task's template requires it — WO5's
`requiredIntegrations` — link to the MCP integrations editor). The roster API exposes this as
data (extend the existing `{ secretRef, resolved }` shape); the UI never sees a secret value.

### 3. The needs-auth card completes the loop (runner + ui)

The existing mid-run `needs-auth` card gains the same **Authenticate…** action. Completing auth
re-checks the server and lets the session continue where the SDK supports reconnection;
otherwise the card says plainly that the turn must be relaunched (and WO1's recovery makes that
one click).

### 4. No scavenging — the guardrail (orchestrator prompt + compile)

- **Prompt rule**, one fixed paragraph in every composed prompt's tooling section: *"Use only the
  tools and MCP servers provided to this session. If a tool or integration you need is missing,
  failing, or unauthorized, call `report_status` with `state: blocked` naming it. Never search
  the filesystem, environment, or configuration for credentials or API keys — that is always the
  wrong move, and the block report is the fast path to getting the connector fixed."*
- **Known-at-launch honesty:** when the init message reports a declared server `failed` or
  `needs-auth`, the fact is already a diagnostic — additionally inject it into the session's
  context (system-reminder style line in the prompt or first tool result, wherever the runner
  already injects launch diagnostics) so the agent starts its work *knowing* the connector is
  down instead of discovering it by failed calls.

## Acceptance tests

- Roster schema: `auth: 'oauth'` accepted on http/sse, rejected on stdio, rejected alongside
  credential headers; export/`.agentpack` of an OAuth integration carries no token material.
- Roster API: the integration-state projection answers ready / needs-auth / missing-secret per
  agent without revealing values.
- Prompt tests: the guardrail paragraph present for every pattern (solo included — the incident
  was not pattern-specific).
- Runner: a declared server reporting `needs-auth` at init produces the card **and** the
  in-session context line.
- Web: Start-work renders integration chips per agent; the required-but-missing case links to
  the integrations editor.
