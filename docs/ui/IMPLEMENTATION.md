# UI — Implementation

Ordered milestones for the v1 frontend and Electron shell. Each is independently verifiable and leaves
the tree in a working state.

**Staging principle**: the **core loop — board → drag → launch → watch → answer — ships in M1–M5**, in
a plain local browser tab, before any shell, wizard, collaboration view, or polish. Everything after
M5 is additive. If the project runs out of time at M5, what exists is a usable agent manager.

**Scope discipline**: build only what [DESIGN.md](DESIGN.md) specifies and nothing from its §20
deferred list. In particular: no service worker, no charts, no import UI, no avatar upload, no
kanban, no command palette, no theme editor.

**Dependencies**: M1 assumes foundation's HTTP surface, event bus and `/api/config/effective` are up.
M3 assumes roster, projects, orchestrator (solo assignments) and runner can complete a launch end to
end. M5 assumes orchestrator's question bridge. M10 assumes remote.

**Reconciliations**: all seven of DESIGN §19 are **resolved** in their target docs, so nothing here is
blocked and no milestone carries a fallback. The three that shaped this plan are now capabilities to
build against: foundation §6.4 serves the bundle and the SPA history fallback (M1), roster §9.5's
`PUT /api/roster/board-order` persists the board order (M3), and remote §6.2's initiate tier covers
`POST /api/assignments/solo` (M10).

**Cross-element sequencing that does bite**: `GET /api/orchestrator/status` is orchestrator M9, which
lands after ui M2 — M2 says how it degrades until then.

---

## 1. App shell, build pipeline, and transport

Vite + React 18 + TypeScript. Wire the whole spine before any feature: the API client, the event
stream, the theme tokens, routing, and the boot sequence.

- Build to `dist/` and hand it to the core's static route — foundation §6.4 serves the bundle plus the
  SPA history fallback on both listeners; dev runs Vite with a proxy to the core's `run/core.port`.
- API client per DESIGN §3.1: relative `/api`, optional bearer, the five typed status-code outcomes,
  server messages surfaced verbatim, `fetch`-to-object-URL helpers for avatars and downloads.
- `EventStream` singleton per §3.3: connect with the `types=` subscription filter (foundation §6.5) so
  the global feed never carries another session's `session.delta`/`.message`/`.tool.*`/`.usage`, ticket
  dance when a token is held, watermark in `localStorage`, `?since=` replay on reconnect (same filter,
  same subset), exponential backoff, heartbeat handling, and the event→cache invalidation map of §3.4.
- Boot sequence: `GET /api/config/effective` + `GET /api/health` → edition, module list, policy flags,
  health warnings → then render. A failed boot renders a diagnostic screen with the core URL and the
  log path, never a blank page.
- Theme tokens (light/dark/system, `data-theme`, no flash), the SVG sprite, the system font stack, the
  app frame (left rail / bottom tab bar), and the connection indicator.

**Acceptance**
- `npm run build` produces a single self-contained bundle with **zero external network references** —
  asserted by scanning the built output for `http://` / `https://` origins other than same-origin, and
  by loading the app with the network blocked to everything but the core.
- The app boots against a running core, renders the frame, shows edition and module list on a debug
  panel, and reports `live` on the connection indicator.
- Killing the core flips the indicator to `reconnecting` within 2s and `offline` within 5s; restarting
  it reconnects and replays `/api/events?since=` with no duplicate and no gap (asserted by emitting a
  known event while disconnected).
- Deep-linking to `/questions/abc` on a full page reload renders the app (proves the SPA fallback).
- Both delivery modes are the same artifact: the byte-identical `dist/` is loaded from Electron's
  window (stubbed) and from a browser, with no build flag distinguishing them.
- Theme switches with no flash on reload; `prefers-reduced-motion` disables transitions.

## 2. Roster board, the projects screen, and minimal project quick-add

The home screen, read-first, plus the smallest path to having something to launch against.

- `GET /api/roster/agents` → card grid; card anatomy per DESIGN §5.2 including avatar kinds, specialty
  chip, tagline, badges (needs-credential, diagnostic, overseer, pinned) and the archive filter.
- Status pill and headline per agent. The source is `GET /api/orchestrator/status` (DESIGN §5.2), but
  that endpoint is **orchestrator M9**, which lands after this milestone: until it does, the board
  derives the same six-word vocabulary (`idle | queued | working | awaiting_user | paused | halted`)
  from `session.*` events and the session record, and swaps to the endpoint behind one accessor when it
  ships. The rendering, the words and the tests do not change — only where the value is read. This is a
  deliberate degrade, not a fallback for an unresolved contract.
- The **projects screen** (`/projects`, DESIGN §5.1) from `GET /api/projects`, with status and health
  chips. Its own route rather than a rail on the board, and its own entry in the frame's navigation.
- **Minimal quick-add** (the register-an-existing-folder half of DESIGN §8.1): path field +
  `GET /api/fs/browse` navigator, `POST /api/projects/inspect` → prefilled form with warnings →
  `POST /api/projects`. Clone, the project page, and the native picker come later.
- Filters (specialty, working now, needs attention, archived) and sort (board order default).

**Acceptance**
- All three avatar kinds render, including a `file` avatar fetched with the API client to an object
  URL; no `<img src="/api/…">` exists in the tree (asserted by grep).
- Editing an `agent.json` on disk updates the affected card within one debounce window, via
  `roster.changed` — no reload.
- A roster diagnostic (deliberately broken `agent.json`) shows on the board as a badge with the
  server's message, and the rest of the board still renders.
- Starting and stopping a session by API changes the agent's status pill and headline live.
- An archived agent is hidden by default, visible under the archive filter, and greyed with reduced
  actions; a session referencing a deleted agent renders "deleted agent" rather than blank.
- Registering a folder takes **under a minute** from clicking Add project to seeing the card,
  measured end to end, including the browse navigation; a typed path works identically.
- Registration refusals (nested project, already registered, inside the data root) render the server's
  message with the offending path.

## 3. Drag and drop, board order, and the launch flow

The north star's central gesture, and the first milestone that starts work.

- One `DndContext` with pointer, touch (250ms long-press) and keyboard sensors. Draggable agent cards;
  droppables for project cards (on `/projects`, beside the agent chips that are their drag source) and
  the board's sortable context. Drag preview, target highlighting, the floating "Launch X on Y" label,
  `Esc` cancel, auto-scroll near a long list's edges, invalid targets dimmed with a reason.
- Reorder persistence via `PUT /api/roster/board-order { order: string[] }` (roster §9.5): the whole
  ordered id list in one request, applied optimistically, rolled back with a toast on failure.
- Every non-drag equivalent of DESIGN §5.4: card `⋯` → Launch on… / project page → Launch an agent…,
  and the explicit **Reorder mode** with ▲▼ controls.
- Launch flow per DESIGN §6: agent × project × prompt; collapsed Details (role, write, work items);
  collapsed permission preview from `POST /api/roster/agents/:id/validate`; the always-visible
  elevation banner with its reason; the remote toggle (home edition); submit to
  `POST /api/assignments/solo`; navigate to the session.

**Acceptance**
- Dropping an agent card on a project opens the launch flow pre-filled with both, and starts nothing
  by itself.
- **Under a minute, three ways**: drag→type→Enter, card menu→pick project→type→Enter, and project
  page→pick agent→type→Enter all reach a running session; each is timed.
- Keyboard-only: Tab to a card, `Space`, arrows, `Space` reaches the launch flow for the intended
  project, with each target change announced in a live region.
- Touch-only on a 390px viewport: the launch flow is reachable **without any drag**, and every control
  in it has a ≥44px target.
- Reorder persists across a reload and across a second client; replaying the same order is a no-op and
  an unknown agent id is a 400 that leaves the previous order intact; an optimistic reorder that fails
  rolls back with a toast.
- A `provisioning`, `archived`, or `missing` project is not a valid drop target, dims during the drag,
  and explains why.
- The permission preview matches roster's compiled effective set for the same agent × project (asserted
  against a direct API call); a project with `permissionElevation` shows the widened rules **and the
  reason** before launch; with `policy.allowPermissionElevation: false` the banner renders disabled
  with the work-edition reason.
- `429 queue_full` renders as an explanation with a link to the queue, not a stack trace.

## 4. Session view

Watch, steer, and stop — the second half of the core loop.

- Header, blocks, controls, and the usage rail per DESIGN §9. Structured rendering only; the ~2KB
  ANSI-SGR formatter scoped to `Bash` results.
- Transcript load: `?tail=<bytes>` on open (runner §11.1), `?from=<offset>&limit=` to page and to
  re-tail after a disconnect, whole lines, offsets retained; live stream on
  `/api/sessions/:id/stream`, merge on `seq`, 500-block cap with **Load earlier**.
- Controls mapped to runner §11.1: Steer (with interrupt toggle), Pause, Resume, Stop, Continue,
  Relaunch, Pin — inapplicable ones disabled **with the reason**.
- Cost and budget labelling per runner §15.2 #13 and orchestrator §16.8.

**Acceptance**
- Assistant text streams token-by-token via `session.delta` and settles into the complete message
  without duplication when `session.message` arrives.
- Tool calls render collapsed with a one-line preview and expand to input and result; an errored call
  expands by default; a `Bash` result containing ANSI colour renders coloured, and one containing
  cursor-movement escapes renders without artefacts.
- Reload mid-session reproduces the full history from the transcript and continues live with **no
  duplicated and no missing** blocks — asserted by comparing the rendered `seq` sequence against the
  transcript file.
- Disconnect for 30s during active output, then reconnect: replay + byte-offset tail reproduces the
  missed output exactly once, and the session is still running (no full refetch, asserted by request
  count).
- Every control round-trips and is idempotent: pressing Stop twice, or Resume on a running session,
  produces a state, not an error.
- A `paused` session with `exit_reason: awaiting_answer` shows "waiting for your answer" with a link to
  the card and **no Resume button**.
- A session with `questionBridge: 'disabled'`, an elevation, a remote origin, or a pruned transcript
  each render their specific banner.
- The usage rail shows tokens as the primary unit and the dollar figure **only** as "estimated model
  cost"; a string assertion proves no percentage, "remaining", or plan-quota wording appears.

## 5. Question inbox — **core loop complete**

- List, card anatomy, stance ladder as words, server-computed `disagreement` / `contested`, ordering
  preserved from the server, options rendered from `options_json`, free text and multi-select,
  expiry countdown with **no** timeout-default affordance.
- `POST /api/questions/:id/answer`; optimistic answered state; Answered tab.
- Badge in the rail/tab bar from `GET /api/orchestrator/status`, live from
  `assignment.question.raised` / `.answered`.
- `/questions/:id` deep link (the ntfy target).
- **No client-side join**: orchestrator §11.1's pinned list projection carries the recommendations
  inline and the assignment / project / session ids denormalised, so the inbox is one request cold.
  A cold `/questions` load issuing a second request is a milestone failure, asserted by request count.

**Acceptance**
- All three kinds (`question`, `approval_gate`, `budget_halt`) render from the same component with the
  right chip and options.
- Stance renders as the **word** in every case; a scan of the rendered output finds no numeric
  confidence, percentage or bar in a recommendation.
- An engine-raised gate is attributed to **"AgentManager"**, never to an agent.
- A card with differing stances shows the disagreement divider; one with a `blocking` stance in the
  disagreement shows the contested banner — both driven by server flags, asserted by flipping the
  flags in a fixture and changing nothing else.
- Answering inside runner's hold resolves the pending tool call **inline** and the session continues in
  the same turn; answering after a park triggers runner's auto-resume — both verified end to end with
  the session view open.
- No approval gate offers a default action on expiry, anywhere.
- The badge increments within 1s of a question being raised and clears on answer.
- Deep-linking `/questions/:id` cold (no prior state) renders the answerable card.
- **The core loop runs end to end on a phone-sized viewport in a plain browser**: board → launch →
  watch → answer, with no drag used.

## 6. Electron shell

Thin wrapper, seven responsibilities, nothing else.

- Discover-or-spawn the core from `run/core.port` + `/healthz`, detached spawn, readiness poll, splash,
  and a failure screen naming the log path.
- Window loading `http://127.0.0.1:<port>`; `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`; preload exposing exactly `{ isElectron, coreUrl, pickFolder, notify, setBadge }`;
  navigation locked to the core's origin; external links to the system browser.
- Tray: Open, "N questions waiting", Stop background service, Quit. Single-instance lock.
- Native folder picker wired into the quick-add dialog. Desktop toast + taskbar badge on question
  raised while unfocused.

**Acceptance**
- With no core running, launching the app starts one detached and connects; **closing the window leaves
  the core running** (asserted by process check and by a session continuing to progress).
- With a core already running, the app connects without spawning a second (single-instance lock in the
  core is not tripped).
- A second app launch focuses the existing window.
- The renderer has no Node access: `require`, `process` and `window.electron` beyond the declared five
  keys are undefined; navigating to an external URL is refused and opens in the system browser.
- The folder picker returns a path that quick-add posts unchanged; with the bridge stubbed (browser
  build) the same dialog falls back to `/api/fs/browse` with no code change at the call site.
- A question raised while the window is unfocused produces a toast; clicking it focuses the window on
  that card. The tray label and the taskbar badge match the inbox count.
- "Stop background service" stops the core and the window reports the disconnected state honestly.

## 7. Project page and the clone flow

- Header with health chips and Relocate; **Review needed** worktrees with commit count, dirty flag and
  a confirmed Clean up; activity timeline from `GET /api/projects/:id/activity` with per-session rows,
  transcript links, pin toggles and the "started remotely" badge; work items list with inline create,
  reorder, and drop-target behaviour.
- Clone half of quick-add: inspect → `POST /api/projects/clone` → immediate card in `provisioning` with
  a progress bar from `project.clone.progress`, dismissible dialog, verbatim git stderr on failure.
- Collapsed project settings: default agents, permission override, elevation with its required reason,
  env entries as `secretRef` names with set/unset state (never values), setup command, instructions
  path, workspace policy, retention.

**Acceptance**
- Cloning a repo shows progress, survives dismissing the dialog, flips the card to `active` on
  completion, and on failure shows git's own message and removes the row.
- A worktree with unmerged commits appears under **Review needed** with its branch and commit count;
  Clean up requires a confirmation naming the branch; a clean worktree never appears there.
- The timeline's assignment `outcome` matches the server's value in all four cases
  (`running`/`completed`/`stopped`/`failed`) — read, never derived.
- A session whose transcript was pruned shows "transcript pruned" and offers no dead link.
- Dropping an agent on a work item opens the launch flow with the item attached and its scope paths
  shown; the created assignment carries `workItemIds` and the item flips to `in_progress`.
- No project env **value** appears anywhere in the DOM or in a network response the UI renders.
- Health states `missing`, `dirty`, `stale-agents` and `orphaned-worktrees` each render; `missing`
  offers Relocate, which preserves the project id and its history.

## 8. Agent wizard, editor, duplicate, archive

- Three-step wizard per DESIGN §7.1: describe → `POST /api/roster/draft` → review and edit with roster's
  per-section `rationale` beside each group, `warnings[]`, the `degraded` banner, suggested skills as
  checkboxes, suggested integrations read-only.
- Redraft presenting the fresh draft **beside** the current one for an explicit swap.
- Save via `POST /api/roster/agents`; the same editor component reused for
  `POST /api/roster/agents/:id/duplicate` and for `/agents/:id`.
- Agent detail: session history, diagnostics, permission preview against a chosen project, remote grant
  with expiry, Export, Archive (and hard purge only when roster says it is possible), plus the
  read-only **Connectors** summary of DESIGN §7.3.1.
- The integrations panel of DESIGN §7.3.1: add/edit/remove per-agent MCP servers (roster §10), the
  secret-reference toggle, roster's `integrations.*` diagnostics shown in context, and paste-import
  from a `.mcp.json`.

**Acceptance**
- **Under a minute** from clicking New agent to a saved card on the board, measured end to end with a
  one-sentence description and no edits.
- A `degraded: true` response renders every partial field editable with the plain explanation, and the
  agent can still be saved.
- Redraft never overwrites in-progress edits without an explicit swap.
- The saved definition is byte-equal to what the form posted (no client-side merge, no server
  reconciliation) — asserted by reading back `GET /agents/:id`.
- `persona.md` round-trips byte-for-byte through the textarea, including trailing whitespace and
  Windows line endings.
- Accepting a suggested skill creates `skills/<name>/SKILL.md` and adds the name to `skills.names`;
  declining it writes nothing.
- Duplicate opens the editor on the returned definition with the "cloned from" line and the shared-
  credentials note; saving creates a second, independent folder.
- `replace` persona mode surfaces roster's warning verbatim.
- Archive confirms with what is retained; purge is offered only when no session references the agent.
- An integration added, edited or removed in the panel round-trips through the same whole-agent save,
  and the `integrations` object it posts validates against roster's own `integrationsSchema`
  (asserted by importing the real schema, not a copy of it).
- A `secretRef` is rendered as a **name** and never as a value, in the panel and in the summary; an
  unresolved one shows the "needs credential" badge and the `secrets set … --stdin` command.
- Paste-import maps stdio/sse/http fixtures, forces a credential-shaped key to a ref, converts
  `${VAR}`, rewrites `streamable-http` to `http`, and writes nothing until the editor is saved.

## 9. Assignment and collaboration view

- `GET /api/assignments/:id` + `/conversation`: header with goal, pattern, phase, seats, artifact link;
  the round pips and the token budget bar; rounds → entries as a dialogue with turn/message/question
  blocks per DESIGN §10.2, including `delivery` state with **undelivered** distinctly marked.
- Solo assignments render through the same view with one seat and no rounds.
- Pattern create dialog driven by `GET /api/patterns`, with model tiers, open-assignment counts, the
  returned `warnings[]` shown before start, and a returned `gate` linking to the card.
- Agent-card-onto-agent-card drag opens that dialog pre-filled.
- Advance / Close / edit budget & round cap (`PATCH` limited to `tokenBudget`, `roundCap`, `goal`).

**Acceptance**
- A completed 3-round pair renders as an ordered, readable dialogue: who spoke, in which seat, in which
  round, with the report headline, the verdict chip, blocking issues, and the artifact link; every turn
  links to its full session transcript.
- Message entries show `inlined`, `read` and **`undelivered`** distinctly, and `undelivered` reads off
  the assignment's status (§10.2): on an open assignment it is labelled as waiting on the named
  recipient's next turn, and only on a closed one — or as `undeliverable` — is it labelled as never
  seen by the recipient.
- Phase, rounds used/cap and tokens used/budget are visible without scrolling on desktop and above the
  fold on phone.
- The budget is shown in **tokens**; no currency figure appears in this view.
- A halted assignment names its halt reason and links to the card that resolves it; a converged one
  shows the completion summary and artifact.
- The create dialog refuses nothing client-side that the server would accept, and surfaces every
  server `warning` before the user confirms; a returned `gate` prevents any "it's running" impression.
- Members and pattern are not editable anywhere in the UI.
- On a 390px viewport the two seats stack and identity is still unambiguous.

## 10. Usage view and settings

- Usage: the three panels of DESIGN §12 with their provenance labels and the API's own `disclaimer`
  string; queue and cool-down; capacity control with the remote lower-only rule; per-assignment spend.
- Settings: Remote access (status, tokens with client-side QR, per-agent grants with `expiresAt`,
  kill switch), Runner, Notifications, Appearance, Logs, Health & about.
- Remote parity behaviours: pairing screen on `401`, denied controls disabled with reasons read from
  `GET /api/remote/status`, the 14-day token expiry banner, the grant prompt retry.
- Work-edition presentation per DESIGN §13.5.

**Acceptance**
- The usage screen contains no percentage, no gauge, and none of the strings "remaining", "% of plan",
  or "quota" — a literal assertion over the rendered output.
- A rate-limit cool-down renders prominently with its `until` and `source`; the queue panel shows
  blocked entries with their `blocked_reason`.
- Capacity can be lowered from the tailnet and the raise control is **disabled with the reason**;
  locally both work.
- Creating a token shows the plaintext exactly once, renders a QR generated client-side (no network
  request during generation), and the plaintext never reappears in any later view or in
  `localStorage` on the desktop.
- Scanning that QR from a phone browser pairs it: the token is read from `location.hash`, stripped
  before first render (asserted by reading `location.href` in the first effect), stored, and the app
  loads authenticated.
- Over the tailnet: Create token, Enable remote access, Restart listener and Stop background service
  are **visible and disabled with their reasons**, and never produce a raw 403 to the user.
- Per-agent grants show `expiresAt` on both the settings screen and the board card, and update live on
  `remote.agent.access.*`.
- The grant can be **ended** from the board, not only from settings: §5.2's `⋯` → **Allow remote starts**
  is a checkbox item reflecting the live grant, absent in the work edition. The earlier cut shipped the
  badge without the toggle §13.2 requires, and this line is what that omission passed through.
- A remote launch of an ungranted agent shows the grant prompt and retries automatically — tested
  against **`POST /api/assignments/solo`**, the path the UI actually uses, which remote §6.2's
  initiate tier now covers; a pattern launch with two ungranted agents prompts **once** from the
  `409` body's list, not twice.
- Work edition: the Remote section is absent, Health & about carries the one-line explanation, and
  `orchestrator.notify` renders disabled with the layer that set it.
- Health warnings from `/api/health` (degraded keyfile secret provider, `ANTHROPIC_API_KEY` present)
  are displayed persistently, not as a dismissible toast.

## 11. Accessibility, responsive, and the cross-delivery acceptance suite

The gate. No new features; this milestone makes the previous ten hold up.

- Full keyboard pass, focus management and trapping, live-region audit (streaming output **not**
  announced), semantic landmarks and headings, accessible names for avatars and icon buttons.
- Contrast audit of both themes including the specialty and status ramps, with the measured ratios
  recorded in the token file and checked in CI.
- Responsive pass at 390 / 768 / 1280 / 1920, and a 200% zoom pass.
- The cross-delivery suite: the same build driven through Electron and through a browser-shaped remote
  client, asserting the screens behave identically except for DESIGN §13.4's enumerated differences.

**Acceptance**
- Every interactive element is reachable and operable by keyboard alone, with a visible focus ring;
  every dialog traps focus, closes on `Esc`, and restores focus to its trigger.
- **Every drag gesture has a working keyboard path and a working pointer-free path**, each covered by
  its own test: agent→project, agent→work item, agent→agent, and board reorder.
- Automated axe (or equivalent) passes with zero serious/critical violations on all ten routes in both
  themes.
- Contrast meets AA on every token pair in both themes, asserted programmatically rather than by eye.
- `prefers-reduced-motion: reduce` removes both looping indicators and all transitions.
- A screen reader announces status transitions, arriving questions and drag events — and does **not**
  announce streaming assistant text.
- No horizontal page scroll at 390px or at 200% zoom on any route; code and diff blocks scroll inside
  their own containers.
- The cross-delivery suite passes: the same `dist/` in Electron and in the remote browser produces the
  same behaviour on board, launch, session, inbox, project and usage — with only the §13.4 differences,
  each asserted explicitly rather than by absence.
- CSP is enforced with no third-party origins, and the app functions fully with all non-core network
  access blocked.
