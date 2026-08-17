#!/usr/bin/env node
/**
 * The ui M1/M2 acceptance criteria that cannot be automated in this repository,
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
];

const bold = (text) => `[1m${text}[0m`;
const dim = (text) => `[2m${text}[0m`;

console.log(bold('\nui M1 + M2 — manual acceptance checks'));
console.log(
  dim(
    `${String(CHECKS.length)} criteria that need a real browser, a real process kill, or a stopwatch.\n` +
      'Everything else in ui IMPLEMENTATION §1 and §2 is covered by `npm test`.\n',
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
