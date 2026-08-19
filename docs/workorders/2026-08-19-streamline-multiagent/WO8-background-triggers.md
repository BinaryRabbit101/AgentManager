# WO8 — Background triggers: assignments that start themselves

**Elements:** orchestrator (trigger scheduler, creation provenance), ui (triggers surface),
runner (admission priority), foundation (storage — one table, no new decision). **Amends:**
orchestrator `DESIGN.md` §2.3 (creation paths — adds the third), §10 (away-notification cases),
§11.4 (events), §12 (config); ui DESIGN (new triggers surface + project page section).
**Depends on WO4** (preflight-as-data), **WO5** (templates are the payload), **WO6**
(integration-state projection). WO7 is not a dependency but its seat overrides are the cost
lever for quiet runs.

## The ask (owner's words, 2026-08-19)

> "Agents can perform operations such as replying to a todo ticket with 'I'm looking into
> this', then after the work is completed, finish with a reply of 'task complete' … Ooo,
> assigning background agents would be pretty cool."

Everything today is human-initiated: someone presses **Start work**. The missing piece is a
**trigger** — a standing instruction that fires a template on a schedule, so "work the open
todo tickets" happens while the owner is away. The always-running core (foundation §4.3:
Task Scheduler autostart, survives reboot) is already the right host; nothing new runs.

## Design

A trigger is *when* + *what*. The *what* is exactly a WO5 template application — a trigger
adds **no new creation semantics**, it calls the same `createAssignment` path the Start-work
dialog does, with provenance `origin: 'trigger', triggerId` recorded on the assignment.

```jsonc
// row in SQLite `triggers` (foundation storage decision: operational state, machine-local,
// mutated concurrently — a table, NOT a library file; schedules reference local projects
// and are not shareable content the way templates are)
{
  "id": "01T…",
  "templateId": "todo-ticket-replies",   // WO5 template — the whole task shape
  "projectId": "01P…",
  "agentIds": ["merritt"],               // seats, same shape as Start-work
  "everyMinutes": 60,                    // v1 schedule: interval + active-hours window
  "activeHours": { "from": 8, "to": 22 },// local time; null = always
  "enabled": true,
  "variables": { "source": "…" },        // fills the template's {{source}}
  "maxRunsPerDay": 24,
  "lastFiredAt": null, "nextFireAt": "…",// persisted; recomputed on boot
  "consecutiveFailures": 0
}
```

### 1. The scheduler (orchestrator)

An in-process timer in the orchestrator module — no OS cron, the core is already always-on.
On each fire, in order, **skip-don't-stall**:

1. **Singleflight** — the previous assignment from this trigger is still open → skip, event
   `trigger.skipped` reason `still-running`.
2. **Preflight, unattended-strict** — run WO4's permission dry-run and WO6's
   integration-state projection *as data, at fire time*. Anything short of green (a tool not
   pre-granted, a connector `needs-auth`/`failed`/missing) → **do not launch**. Event
   `trigger.blocked` naming the gate, plus an ntfy notification (orchestrator §10 gains this
   case). An unattended launch that would park on a permission card or a dead connector is
   worse than no launch.
3. **Caps** — `maxRunsPerDay` reached, or global `triggers.enabled: false` → skip.
4. Otherwise create the assignment via the normal path and let the engine drive it.

**Failure backoff:** a run whose assignment ends `failed` increments `consecutiveFailures`;
at 3 (config) the trigger **disables itself** and notifies. Success resets the counter.

**Boot:** recompute `nextFireAt`; fires missed while the core was down collapse to **at most
one** catch-up run — never a backfill storm.

### 2. Unattended economics

- **The quiet run is the agent's job, not the core's.** The core never calls the todo/email
  connector itself to ask "is there anything to do?" — WO6 just established that connectors
  belong to agents (OAuth, no machine-scavengeable credentials), and the core impersonating
  an agent's grant is a new security surface for a marginal saving. Instead the seeded
  templates' `goalTemplate` gains the standing first line: *"If the source has no open
  items, report done immediately and write nothing."* A quiet run is one short turn.
- Templates meant for triggers should carry a WO7 seat override to a small model; the seeded
  todo/email templates get one.
- Trigger-launched sessions enter the runner queue at **low priority** (runner scheduler:
  admit only when no interactive session is waiting) and obey rate-limit cool-downs as
  usual — background work must never starve the owner's own usage (D2).

### 3. Surface (ui + API)

- `GET/POST/PATCH/DELETE /api/triggers`, `POST /api/triggers/:id/run` (fire now, same path
  as the timer including preflight). On foundation's single route table, therefore
  remote-reachable — the phone can fire one later.
- UI: a **Triggers** section on the project page and a global list (settings → Automation).
  Each row: template, agents, schedule, enabled toggle, last run (links to the assignment),
  next fire, and the blocked/disabled reason when there is one. Events invalidate; nothing
  polls (ui §3.4 rule). `trigger.fired|skipped|blocked|disabled` join §11.4's bus.
- Editions do not differ (D6): triggers are outbound-only, no listener involvement.

## Deferred, deliberately

- **Webhooks / inbound triggers** — an inbound HTTP surface conflicts with the D5 posture
  (the listener is the remote UI, Tailscale/proxy-bound; the work edition has none). Revisit
  as "the proxy host forwards a webhook" if polling proves too slow.
- **Core-side connector condition probes** (see §2 rationale) and **cron expressions**
  (interval + active hours covers the real cases; a parser can come later).

## Acceptance tests

- Fire with everything green → assignment created with `origin: 'trigger'`, engine advances
  it exactly like a Start-work launch; provenance visible in the UI and Usage.
- Previous run still open → `trigger.skipped(still-running)`, no assignment row.
- A `needs-auth` connector at fire time → `trigger.blocked`, ntfy sent, no assignment, and
  the trigger row shows the reason; authenticating then "Run now" succeeds.
- Three consecutive failed assignments → trigger disabled, notification sent, success after
  manual re-enable resets the counter.
- Restart the core across a missed window → exactly one catch-up run.
- `maxRunsPerDay` and `activeHours` are honored; a trigger-launched session queued behind an
  interactive launch admits second.
- Work edition boots with triggers functional and no listener (D6 unchanged).
