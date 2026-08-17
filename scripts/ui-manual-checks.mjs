#!/usr/bin/env node
/**
 * The ui M1–M8 acceptance criteria that cannot be automated in this repository,
 * as a runnable checklist.
 *
 * `npm run checks:ui` prints it. Everything **not** listed here is automated —
 * each item names the test file that covers the automatable part, so the split
 * is explicit rather than a silent omission.
 *
 * Why these and not the rest:
 *
 * - Three of them are about the *first paint* or about *how the network
 *   behaves*, and jsdom has neither a paint nor a network stack.
 * - Three are wall-clock measurements of a **human** doing something. A test can
 *   prove the flow is four interactions and that the machine half takes
 *   milliseconds (it does), but "under a minute" is a claim about a person.
 * - Several are **Electron at the window level**. The shell's logic is unit-
 *   tested against the `ElectronHost` seam (`electron/*.test.ts`), because
 *   Electron needs a downloaded binary and a display that this environment does
 *   not have. What needs a real window, a real detached process or a real OS
 *   notification is here.
 *
 * Playwright was considered and not used: it needs a browser download this
 * environment cannot rely on, and a suite that silently skips is worse than a
 * checklist that has to be read.
 */

const CHECKS = [
  {
    id: 'M1-no-flash',
    criterion: 'Theme switches with no flash on reload.',
    reference: 'ui DESIGN §14.2, IMPLEMENTATION §1',
    why: 'A flash is a property of the first paint. jsdom does not paint.',
    automated:
      'web/src/theme/theme.test.ts — that theme-boot.js is a blocking <head> script loaded before the module bundle, and that it agrees with theme.ts on the storage key, the attribute and the accepted values.',
    steps: [
      'Start the core and open http://127.0.0.1:<port>/ in Chrome and in Firefox.',
      'Set the theme toggle to Dark. Reload with F5, then reload with Ctrl+Shift+R.',
      'Watch the first frame: no light flash before the dark surface appears.',
      'Set the toggle to Light on a machine whose OS theme is dark, and reload: the app stays light.',
      'Set the toggle to System, change the OS theme while the tab is open: the app follows without a reload.',
      'Throttle to "Slow 3G" in devtools and reload: still no flash (this is where a deferred script would show).',
    ],
  },
  {
    id: 'M1-reduced-motion',
    criterion: '`prefers-reduced-motion` disables transitions and both looping indicators.',
    reference: 'ui DESIGN §14.1, §15',
    why: 'jsdom evaluates no media queries and runs no animations.',
    automated:
      'web/src/theme/theme.test.ts — that the reduce block sets --duration to 0ms and forces animation-iteration-count and transition-duration.',
    steps: [
      'Windows: Settings → Accessibility → Visual effects → Animation effects off. (Or devtools → Rendering → Emulate CSS prefers-reduced-motion: reduce.)',
      'Start a session so an agent card shows the `working` pulse.',
      'The pulse is static and no card transition animates on hover or on filter change.',
    ],
  },
  {
    id: 'M1-network-blocked',
    criterion: 'The app loads with the network blocked to everything but the core.',
    reference: 'ui IMPLEMENTATION §1 (second half of the first acceptance)',
    why: 'Requires a real browser with a request-blocking rule.',
    automated:
      'web/test/bundle.test.ts — scans the built output for any absolute origin, CDN host, webfont or source-map sidecar; web/test/sourceScan.test.ts catches the same class at the source.',
    steps: [
      'Devtools → Network → Request blocking → block pattern `*` , then unblock the core origin (or use a host-level firewall rule allowing only 127.0.0.1:<port>).',
      'Hard-reload. The board renders, the connection indicator reaches `live`, and the Network panel shows requests to the core origin only.',
      'Repeat over the tailnet from a phone with mobile data off and only the tailnet reachable.',
    ],
  },
  {
    id: 'M1-kill-the-core',
    criterion:
      'Killing the core flips the indicator to `reconnecting` within 2s and `offline` within 5s; restarting it replays `?since=` with no duplicate and no gap.',
    reference: 'ui IMPLEMENTATION §1',
    why: 'Killing a real process and timing a real socket. The timings and the replay contract are unit-tested; the process is not.',
    automated:
      'web/src/events/EventStream.test.ts — the state ladder, the backoff ladder, the heartbeat watchdog, and that the reconnect URL carries ?since=<watermark> with an identical types= filter. src/http/api.test.ts (foundation) — that the server replays from a watermark in order with no gap or duplicate, against a real listener.',
    steps: [
      'With the board open and `live`, stop the core (Ctrl+C, or Stop background service).',
      'Within 2s the indicator reads `reconnecting`; by 5s it reads `offline`; after a further 5s the full-width banner appears.',
      'While it is down, cause a persisted event — edit an agent.json on disk.',
      'Start the core again. The indicator returns to `live` and the edited card repaints exactly once.',
      'Confirm in the Network panel that the reconnect request carries both `types=` and `since=`, and that no full page reload happened.',
    ],
  },
  {
    id: 'M1-both-delivery-modes',
    criterion:
      'The byte-identical dist/ loads from an Electron window (stubbed) and from a browser, with no build flag distinguishing them.',
    reference: 'ui IMPLEMENTATION §1',
    why: 'Needs a real Electron window beside a real browser. The shell landed in M6; the diff is still a pair of eyes.',
    automated:
      'vite.config.ts has no mode switch, no `define`, and one `base`; web/test/bundle.test.ts asserts every asset reference is relative and same-origin, which is what makes one artifact serve both. web/src/app/bridge.test.ts asserts the only runtime difference is whether the preload bridge is there.',
    steps: [
      'Build once and start the shell (see M6-shell-runs-at-all).',
      'Open the same http://127.0.0.1:<port> in Chrome beside the Electron window.',
      'Diff the rendered board: identical, except that the Electron window’s Add project → Browse opens the native dialog.',
      'Confirm no second build was produced: app/web has one index.html and one asset set, loaded by both.',
    ],
  },
  {
    id: 'M2-under-a-minute',
    criterion:
      'Registering a folder takes under a minute from clicking Add project to seeing the card, including the browse navigation; a typed path works identically.',
    reference: 'ui IMPLEMENTATION §2',
    why: 'A stopwatch on a person.',
    automated:
      'web/src/projects/QuickAddDialog.test.tsx — the full flow in four interactions with no typing, the typed-path flow with no browsing, and that the machine half completes in milliseconds.',
    steps: [
      'Start a stopwatch, click Add project, browse to a folder you already work in, Inspect, Create.',
      'Stop when the card appears in the projects rail. Record the time.',
      'Repeat by pasting the absolute path instead of browsing. Record the time.',
      'Repeat both from a phone browser over the tailnet.',
    ],
  },
  {
    id: 'M2-file-edit-debounce',
    criterion:
      'Editing an agent.json on disk updates the affected card within one debounce window.',
    reference: 'ui IMPLEMENTATION §2',
    why: 'The debounce belongs to roster’s file watcher; the browser half is what needs the eye.',
    automated:
      'web/src/board/Board.test.tsx — that a `roster.changed` frame refetches the roster and repaints the card with no reload. roster’s own watcher.test.ts covers the debounce.',
    steps: [
      'With the board open, edit an agent’s tagline in its agent.json and save.',
      'The card text changes within about a second, with no reload and no flicker on the other cards.',
      'Change the avatar file and confirm the face updates rather than staying behind the memo.',
    ],
  },
  {
    id: 'M3-under-a-minute-three-ways',
    criterion:
      'Under a minute, three ways: drag→type→Enter, card menu→pick project→type→Enter, and project page→pick agent→type→Enter all reach a running session; each is timed.',
    reference: 'ui IMPLEMENTATION §3, DESIGN §6',
    why: 'A stopwatch on a person, three times. The machine half is milliseconds and is asserted; the human half is not.',
    automated:
      'web/src/board/BoardDnd.test.tsx — all three entry points open the same launch flow pre-filled (keyboard drop, card ⋯ → Launch on…, project card → Launch an agent…). web/src/launch/LaunchFlow.test.tsx — the fast path is type-then-Enter with one request. web/e2e/launch.test.ts — the submit reaches a session that runs to completion against a real core.',
    steps: [
      'Start the core with at least one agent and one active project. Open the board.',
      'Time 1 — drag: start the stopwatch, drag the agent card onto the project card, type one sentence, press Enter. Stop when the session view shows `running`.',
      'Time 2 — card menu: ⋯ → Launch on… → pick the project → type → Enter.',
      'Time 3 — project card: Launch an agent… → pick the agent → type → Enter.',
      'Record all three. Any over a minute is a milestone failure, not a slow tester — say which step ate the time.',
    ],
  },
  {
    id: 'M3-pointer-and-touch-drag',
    criterion:
      'The pointer drag and the 250ms touch long-press both lift the card, highlight valid targets, dim invalid ones with a reason, auto-scroll the rail, and cancel on Esc.',
    reference: 'ui DESIGN §5.3, IMPLEMENTATION §3',
    why: 'jsdom has no layout, no pointer events with real coordinates and no scrolling, so collision detection and auto-scroll cannot be exercised there. The keyboard path — which shares the drop handler — is fully automated.',
    automated:
      'web/src/board/BoardDnd.test.tsx — the real KeyboardSensor through dnd-kit, the live-region announcement on every target change, the refusal of a provisioning/archived/missing project, and the reorder round-trip. web/src/board/dnd.test.ts — every drop outcome and every announcement string.',
    steps: [
      'Desktop, mouse: press on a card and move 5px. It lifts (shadow + slight tilt) and the floating label reads "Launch <agent> on <project>" as you cross the rail.',
      'Cross an archived or provisioning project: it dims and its tooltip says why. Release on it — nothing starts and a toast says why.',
      'Drag toward the top and bottom of the projects rail: it auto-scrolls.',
      'Press Esc mid-drag: the card returns and nothing opens.',
      'Phone or touch emulation at 390px: press and hold a card for ~250ms — it lifts; a quick swipe scrolls the page instead.',
      'Confirm the same drop opens the launch flow, and that the flow is a bottom sheet rather than a centred dialog.',
    ],
  },
  {
    id: 'M4-disconnect-30s',
    criterion:
      'Disconnect for 30s during active output, then reconnect: replay plus the byte-offset tail reproduces the missed output exactly once, the session is still running, and there is no full refetch.',
    reference: 'ui IMPLEMENTATION §4, DESIGN §9.4',
    why: 'A real socket held open for 30s across a real network interruption. The merge algebra and the request count are both asserted; the interruption is not.',
    automated:
      'web/src/session/blocks.test.ts — a delta interrupted mid-turn, then a re-tail that overlaps what is held, rendering each `seq` exactly once. web/src/session/SessionView.test.tsx — the open path is one `?tail=` request and Load earlier pages with `?from=`. web/e2e/launch.test.ts — the rendered `seq` sequence against a real transcript file.',
    steps: [
      'Start a long session (something that streams for a minute) and open its view.',
      'Devtools → Network → Offline (or pull the tailnet) for 30 seconds while output is arriving.',
      'Restore the network. The transcript continues; scroll back over the seam and confirm no line appears twice and none is missing.',
      'Confirm in the Network panel that the reconnect issued `?from=<offset>` and **not** a fresh `?tail=` or a page reload.',
      'Confirm the session status is still `running` and the controls still work.',
    ],
  },
  {
    id: 'M5-core-loop-on-a-phone',
    criterion:
      'The core loop runs end to end on a phone-sized viewport in a plain browser: board → launch → watch → answer, with no drag used.',
    reference: 'ui IMPLEMENTATION §5, DESIGN §2.3',
    why: 'This is the milestone gate and it is a claim about a real phone: a real 390px viewport, a real thumb, and a real tailnet round trip.',
    automated:
      'web/src/board/BoardDnd.test.tsx (the two pointer-free launch paths), web/src/session/SessionView.test.tsx (watch, steer, stop, the awaiting-answer banner), web/src/questions/QuestionInbox.test.tsx (one-request inbox, all three kinds, the answer flow, the badge), web/e2e/answer.test.ts (the answer resolving a held tool call inline).',
    steps: [
      'On a phone over the tailnet (or Chrome at 390 × 844 with touch emulation), open the board.',
      'Launch: tap a project’s Launch an agent…, pick an agent, type one sentence, submit. No drag anywhere.',
      'Watch: the session view opens; the usage rail is under the header; tool blocks start collapsed; the steer field is reachable above the keyboard.',
      'Answer: make the agent ask something (an `ask` permission rule is the easy way). Tap the Questions tab — the badge shows 1 within a second — and answer with a full-width option button.',
      'Confirm the session continued without you touching it again, and that the session view names whether the answer landed inline or after a park.',
      'Confirm no horizontal page scroll at any point, and that every target you tapped was comfortable for a thumb.',
    ],
  },
  {
    id: 'M6-shell-runs-at-all',
    criterion:
      'The shell launches: built into app/electron and run with a locally installed Electron, it opens a window on the core.',
    reference: 'ui DESIGN §1.5, foundation §4.1 / §7',
    why: 'Electron is deliberately not a dependency of this repository — packaging is foundation §7’s explicitly deferred half — and it needs a downloaded binary plus a display.',
    automated:
      'electron/shell.test.ts drives the whole shell against the ElectronHost seam: startup, the single-instance lock, the tray rows, the folder picker, toasts, the badge, and Stop background service. electron/window.test.ts pins the webPreferences and the navigation policy; electron/preload.test.ts pins the five bridge keys and the three channels at the source.',
    steps: [
      'Build: npm run build && npm run build:web && npx tsc -p electron/tsconfig.json --outDir app --noEmit false',
      'Install Electron locally, uncommitted: npm install --no-save electron',
      'Run: npx electron app/electron/main.js',
      'A window opens on http://127.0.0.1:<port>. Check the address bar of devtools: it must not be file://.',
      'Confirm the tray icon carries Open / N questions waiting / Stop background service / Quit, in that order.',
    ],
  },
  {
    id: 'M6-core-outlives-the-window',
    criterion:
      'With no core running, launching the app starts one detached and connects; closing the window leaves the core running (process check, and a session still progressing).',
    reference: 'ui IMPLEMENTATION §6, foundation §4.1',
    why: 'A real detached process, a real window close, and a real session that keeps writing its transcript.',
    automated:
      'electron/discovery.test.ts — the spawn/connect decision, staleness, the readiness poll, the failure message, and a source assertion that nothing in the module can kill what it started. electron/shell.test.ts — closing the window makes no request and does not quit.',
    steps: [
      'Stop any running core and delete a stale <dataRoot>\\run\\core.port.',
      'Launch the shell. It connects after a splash; Get-Process node shows a new process.',
      'Start a long session from the board, then close the window.',
      'Confirm the node process is still there and the session still progresses (re-open, or curl /api/sessions/<id>).',
      'Launch again: it connects to the same core — no second process, and no "already running" line in core.log.',
      'Launch a third time with the window open: the existing window is focused and no second window appears.',
    ],
  },
  {
    id: 'M6-toast-and-badge',
    criterion:
      'A question raised while the window is unfocused produces a desktop toast; clicking it focuses the window on that card. The tray label and the taskbar badge match the inbox count.',
    reference: 'ui DESIGN §1.5 #6, IMPLEMENTATION §6',
    why: 'A real OS notification, a real taskbar and a real window focus state.',
    automated:
      'web/src/app/desktop.test.tsx — the renderer asks for a toast only when unfocused, with the card’s deep link, and pushes the count. electron/shell.test.ts — the toast is shown, the click focuses and navigates, and one number drives the tray label and the badge.',
    steps: [
      'With the shell running, click another application so the window loses focus.',
      'Make an agent ask something (an `ask` permission rule is the easy way).',
      'A Windows toast appears naming the question. Click it: the window comes forward on /questions/<id>.',
      'Check the taskbar badge and the tray tooltip read the same count as the Questions rail badge.',
      'Answer it and confirm all three clear together.',
    ],
  },
  {
    id: 'M6-external-links-and-stop',
    criterion:
      'An external URL is refused in-window and opens in the system browser; "Stop background service" stops the core and the window reports the disconnected state honestly.',
    reference: 'ui DESIGN §1.5 #3, #7',
    why: 'The system browser and a real process shutdown.',
    automated:
      'electron/window.test.ts (the decision, including the refused file: and javascript: schemes), electron/shell.test.ts (the wiring, and that Stop posts /api/service/shutdown without quitting the app).',
    steps: [
      'Open a session whose transcript contains an external link and click it: the default browser opens it and the window does not navigate.',
      'Tray → Stop background service. The indicator goes reconnecting, then offline, and the banner appears. The window stays open and says so plainly.',
      'Tray → Quit with the core running: the window closes and the node process survives.',
    ],
  },
  {
    id: 'M7-clone-a-real-repo',
    criterion:
      'Cloning a repo shows progress, survives dismissing the dialog, flips the card to active on completion, and on failure shows git’s own message and removes the row.',
    reference: 'ui IMPLEMENTATION §7',
    why: 'A real git clone over a real network, and a real credential failure on the unhappy path.',
    automated:
      'web/src/projects/clone.test.ts — the fold over project.clone.progress/completed/failed, that git’s stderr is kept verbatim, and that a completed clone drops the row so the project’s own status is the only claim. web/src/projects/QuickAddDialog.test.tsx — inspect → clone, the 202, and the dialog closing at once.',
    steps: [
      'Add project → Clone URL → paste a repository of a few hundred MB → Inspect → Clone.',
      'Dismiss the dialog immediately. The rail card shows provisioning with git’s phases and percentages moving.',
      'Wait for completion: the card flips to active and the progress row disappears.',
      'Repeat with a private repository you have no credentials for: git’s own message is shown verbatim and the row disappears.',
    ],
  },
  {
    id: 'M7-worktree-review',
    criterion:
      'A worktree with unmerged commits appears under Review needed with its branch and commit count; Clean up requires a confirmation naming the branch; a clean worktree never appears there.',
    reference: 'ui IMPLEMENTATION §7',
    why: 'Needs a real git worktree with real commits — the counts are computed by projects from git itself.',
    automated:
      'web/src/projects/ProjectPage.test.tsx — the region, the branch and count, the confirmation naming the branch, the cleanup call, and that a clean worktree is absent.',
    steps: [
      'Launch a write-capable agent on a git project so it takes a worktree, and let it commit something.',
      'Open the project page: the branch and commit count are under Review needed.',
      'Press Clean up: the confirmation names the branch. Cancel — nothing is removed.',
      'Confirm it, and check git worktree list no longer shows it.',
      'Repeat with a session that changed nothing: the worktree must not appear there at all.',
    ],
  },
  {
    id: 'M8-under-a-minute',
    criterion:
      'Under a minute from clicking New agent to a saved card on the board, with a one-sentence description and no edits.',
    reference: 'ui IMPLEMENTATION §8, DESIGN §7.1',
    why: 'A stopwatch on a person, plus a real drafting call whose latency is roster’s (§12.2 budgets ~8s p50).',
    automated:
      'web/src/agents/AgentWizard.test.tsx — the whole flow is describe → Draft → Save with no edits and exactly two requests. web/e2e/agent.test.ts — the saved definition read back byte-equal, persona.md byte-for-byte, and the accepted skill’s SKILL.md on disk.',
    steps: [
      'Start the stopwatch, click New agent, type one sentence, press Draft this agent.',
      'Edit nothing. Press Save when the review step appears.',
      'Stop when the new card is on the board. Record the total and how much of it was the drafting call.',
      'Any run over a minute is a milestone failure — say whether it was the model or the form.',
    ],
  },
];

const bold = (text) => `[1m${text}[0m`;
const dim = (text) => `[2m${text}[0m`;

console.log(bold('\nui M1–M8 — manual acceptance checks'));
console.log(
  dim(
    `${String(CHECKS.length)} criteria that need a real browser, a real process kill, a real phone, or a stopwatch.\n` +
      'Everything else in ui IMPLEMENTATION §1–§8 is covered by `npm test`.\n',
  ),
);

for (const check of CHECKS) {
  console.log(`${bold(`[ ] ${check.id}`)}  ${dim(check.reference)}`);
  console.log(`    ${check.criterion}`);
  console.log(`    ${dim(`Not automated: ${check.why}`)}`);
  console.log(`    ${dim(`Automated part: ${check.automated}`)}`);
  for (const [index, step] of check.steps.entries()) {
    console.log(`      ${String(index + 1)}. ${step}`);
  }
  console.log('');
}

console.log(dim('Record the outcome in the milestone’s completion note.\n'));
