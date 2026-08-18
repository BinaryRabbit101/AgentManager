---
name: agent-widget
description: AgentManager's iPhone Home Screen widget — the phone-side client for GET /api/widget. Its source lives in a different project (Scriptables), so use this whenever the request touches the widget: "the widget", "the phone widget", "update/redeploy the widget", "the widget shows the wrong thing", "add X to the widget", or any change to /api/widget or orchestrator DESIGN §11.5 that the phone has to keep up with.
---

# The AgentManager widget

AgentManager has a Home Screen widget on the iPhone that answers one question —
**is anything waiting on me?** It is the pull counterpart to §10's ntfy push.

The two halves live in two repos, and that is the first thing to know:

| Half | Where | What it is |
| --- | --- | --- |
| The feed | **this repo** — `src/modules/orchestrator/widget.ts`, `widgetRoutes.ts` | `GET /api/widget`, orchestrator DESIGN §11.5 |
| The phone client | `C:\Users\binar\OneDrive\Documents\Claude\Projects\Scriptables\widgets\agentmanager.js` | a single self-contained Scriptable `.js` |

The Scriptables project is **not a git repo** and is not a checkout of this one.
It has its own conventions and its own skills (`/new-widget`, `/verify-widget`,
`/deploy-widget`) — open that folder when working on the phone half rather than
reinventing its shape here.

## The contract between them

`GET /api/widget` takes no parameters and returns:

```jsonc
{ "generatedAt": "…",
  "waiting": [ { "id": "01J…", "kind": "question|approval_gate|budget_halt",
                 "agentName": "Sam Skeptic",   // null when two seats could be the asker
                 "prompt": "…",                // clipped to orchestrator.widget.promptChars
                 "createdAt": "…", "waitingSec": 244, "contested": false } ],
  "waitingTotal": 5,          // taken BEFORE the maxWaiting slice — "+N more" is honest
  "oldestWaitingSec": 244,
  "agents": { "working": 3, "queued": 1, "awaitingUser": 2,
              "paused": 0, "halted": 0, "idle": 4 },
  "assignments": { "open": 2, "halted": 0, "awaitingUser": 1 } }
```

Three properties are load-bearing, and a change that breaks one is a design
change, not a refactor:

- **`agents` is a tally of §11.3's fleet reader**, not a recount. The widget and
  the board cannot disagree about whether an agent is working, and the test that
  says so asserts against the reader rather than a fixture.
- **`waitingSec` is served, not derived.** A phone subtracting `createdAt` from
  its own clock is how "waiting 4m" renders negative.
- **No tool input, ever.** A gate's `toolName` would be safe; the arguments it
  came with are not, and `widget.test.ts` scans the serialised payload for them.

Tunables: `orchestrator.widget.maxWaiting` (default 4) and `promptChars`
(default 140), in `src/modules/orchestrator/config.ts` and `config/defaults.json`.

## How the phone reaches it

The widget pulls over the tailnet — widgets cannot be pushed to. The path is the
same one everything remote takes (see the deploy topology; the core runs on the
Windows box, the mini-PC is only its front door):

```
https://minipc.jackal-hippocampus.ts.net:455/api/widget
  → mini-PC nginx (127.0.0.1:93) → http://192.168.0.197:7478 (the core's remote listener)
```

Auth is a **bearer token in the `Authorization` header** — minted by
`POST /api/remote/tokens` (or Settings → Remote access), shown once, and stored
in the widget's `CONFIG.token`. It is unrecoverable afterwards: a lost token is
re-minted, never looked up. Revoking it in the app kills the widget immediately.

The route registers with the default `remote: 'allow'`, so nothing extra is
needed to expose it — but the phone must be on the tailnet for the name to
resolve.

## Changing it

**Changing what the widget shows** usually means changing both halves:

1. Amend **DESIGN §11.5** first (ground rule: designs before code), then
   `widget.ts` + `widget.test.ts` here.
2. `npm run ci` — note it builds `dist/` before testing, and the process-spawn
   boundary tests validate `config/defaults.json` against the *compiled* schema.
   Adding a config key and running bare `npm test` fails those tests until you
   rebuild. That is a stale `dist/`, not a real break.
3. Edit `widgets/agentmanager.js` in the Scriptables project, verify it with
   that project's `/verify-widget`, and deploy with its `/deploy-widget`
   (copies the file flat into the iCloud `Scriptable` folder).
4. Restart the core so the new route is live — see the deploy topology:
   `POST http://127.0.0.1:7477/api/service/shutdown`, then
   `Start-ScheduledTask -TaskPath '\AgentManager\' -TaskName 'AgentManager Core'`.

**Testing the feed by hand**, from the Windows box (no Tailscale needed):

```powershell
curl.exe -s -H "Authorization: Bearer <token>" http://127.0.0.1:7477/api/widget
```

From the tailnet, swap in `https://minipc.jackal-hippocampus.ts.net:455`. A
`401` there means the path is good and auth is doing its job; a `421` means the
`Host` allowlist rejected the name.

## Widget-side conventions worth not relearning

- One file, no imports. Scriptable reads only the **root** of its folder.
- Medium and large widgets get a tap target **per stack** — the rows deep-link to
  `/questions/<id>`; the widget background falls back to `/questions`.
- Always cache and fall back. A widget rendering a stale answer is useful; one
  rendering an error is not.
- `config.widgetFamily` is `null` when the script runs inside the Scriptable app,
  so the size switch needs a default.
