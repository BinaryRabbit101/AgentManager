#!/usr/bin/env node
/**
 * The ui M1–M5 acceptance criteria that cannot be automated in this repository,
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
 * - Two are wall-clock measurements of a **human** doing something. A test can
 *   prove the flow is four interactions and that the machine half takes
 *   milliseconds (it does), but "under a minute" is a claim about a person.
 * - One is Electron, which arrives in M6.
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
    why: 'The Electron shell is M6. There is nothing to load it from yet.',
    automated:
      'vite.config.ts has no mode switch, no `define`, and one `base`; web/test/bundle.test.ts asserts every asset reference is relative and same-origin, which is what makes one artifact serve both.',
    steps: [
      'Defer to M6. When the shell lands: load the same app/web from the Electron window and from Chrome and diff the rendered board.',
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
];

const bold = (text) => `[1m${text}[0m`;
const dim = (text) => `[2m${text}[0m`;

console.log(bold('\nui M1–M5 — manual acceptance checks'));
console.log(
  dim(
    `${String(CHECKS.length)} criteria that need a real browser, a real process kill, a real phone, or a stopwatch.\n` +
      'Everything else in ui IMPLEMENTATION §1–§5 is covered by `npm test`.\n',
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
