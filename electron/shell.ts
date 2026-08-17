/**
 * The Electron shell (DESIGN §1.5) — seven responsibilities and nothing else.
 *
 * 1. discover or start the core;  2. create the window and load it over HTTP;
 * 3. the tray;  4. the single-instance lock;  5. the native folder picker;
 * 6. desktop toasts and the taskbar badge;  7. external links.
 *
 * "That is the complete list. The shell owns **no** UI beyond the window chrome
 * and the tray menu, **no** business logic, **no** filesystem access on behalf of
 * the page beyond the folder picker, and **no** database or transcript access."
 *
 * The rule that shapes the code more than any other is foundation §4.1's: the
 * core is an independent process and **Electron never owns it**. So there is no
 * child handle held anywhere in this file, `closed` does nothing to the core, and
 * quitting the app does nothing to the core. The one code path that stops it is
 * the tray's "Stop background service", which asks the core to stop *itself*
 * through `POST /api/service/shutdown` — the same endpoint the settings screen
 * uses, because there is no second way to stop a service.
 */

import {
  NOTIFY_CHANNEL,
  PICK_FOLDER_CHANNEL,
  SET_BADGE_CHANNEL,
  readBadgeCount,
  readNotifyRequest,
} from './channels.js';
import { discoverCore, type DiscoveryDeps, type DiscoveryResult } from './discovery.js';
import type { ElectronHost, WindowLike } from './host.js';
import { trayMenu, trayTooltip } from './tray.js';
import { navigationDecision, windowSpec } from './window.js';

export interface ShellDeps {
  readonly host: ElectronHost;
  readonly discovery: DiscoveryDeps;
  /** Where the built preload script landed; `main.ts` is the only file that knows. */
  readonly preloadPath: string;
  /** Used for exactly one request: `POST /api/service/shutdown`. */
  readonly fetch: typeof globalThis.fetch;
  /** The splash / failure screen, as a `data:` URL or a served path. */
  showStartupFailure?(message: string, logPath: string): void;
}

export interface RunningShell {
  readonly coreUrl: string;
  readonly window: WindowLike;
  /** Open questions as the renderer last reported them (§2.2's badge, mirrored). */
  openQuestions(): number | null;
}

export type ShellOutcome =
  | { readonly kind: 'running'; readonly shell: RunningShell }
  /** Another instance already holds the lock; this one focused it and quit (§1.5 #4). */
  | { readonly kind: 'second-instance' }
  | { readonly kind: 'failed'; readonly message: string; readonly logPath: string };

export async function runShell(deps: ShellDeps): Promise<ShellOutcome> {
  const { host } = deps;

  // §1.5 #4, and it must come before anything expensive: a second launch should
  // cost a lock attempt and an exit, not a window and a core probe.
  if (!host.app.requestSingleInstanceLock()) {
    host.app.quit();
    return { kind: 'second-instance' };
  }

  await host.app.whenReady();

  const discovered: DiscoveryResult = await discoverCore(deps.discovery);
  if (discovered.kind === 'failed') {
    deps.showStartupFailure?.(discovered.message, discovered.logPath);
    return { kind: 'failed', message: discovered.message, logPath: discovered.logPath };
  }

  const coreUrl = discovered.url;
  const window = host.createWindow(windowSpec(deps.preloadPath));

  // §1.5 #7: external links leave the window. Both routes out of the page are
  // covered — `window.open`/`target=_blank`, and an in-page navigation.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = navigationDecision(coreUrl, url);
    if (decision.kind === 'external') void host.openExternal(decision.url);
    // Never `allow`: a second Electron window is post-v1 (§1.5's deferred list),
    // and a same-origin popup would be one.
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const decision = navigationDecision(coreUrl, url);
    if (decision.kind === 'allow') return;
    event.preventDefault();
    if (decision.kind === 'external') void host.openExternal(decision.url);
  });

  // Foundation §4.1: "Closing the Electron window … never stops the core."
  // Stated as code rather than as an absence, because an absence is not
  // reviewable — this handler is the whole of what closing does.
  window.on('closed', () => {
    /* nothing: the core is not ours to stop */
  });

  let openQuestions: number | null = null;
  const tray = host.createTray();

  const focusWindow = (): void => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  const navigate = (route: string): void => {
    void window.loadURL(`${coreUrl}${route}`);
    focusWindow();
  };

  const refreshTray = (): void => {
    tray.setToolTip(trayTooltip(openQuestions));
    tray.setContextMenu(
      trayMenu(openQuestions, {
        openApp: focusWindow,
        openQuestions: () => navigate('/questions'),
        stopBackgroundService: () => void stopCore(deps.fetch, coreUrl),
        // Quits the *app*. The core keeps running — that is the difference
        // between this row and the one above it.
        quit: () => host.app.quit(),
      }),
    );
  };
  refreshTray();

  // §1.5 #4's other half: a second launch focuses this window rather than
  // opening a new one.
  host.app.on('second-instance', focusWindow);

  // §1.5 #5 — the only privileged capability the page gets. It returns a path
  // and nothing else: no listing, no read, no write. The browser build has no
  // bridge at all and falls back to `GET /api/fs/browse` at the same call site.
  host.ipc.handle(PICK_FOLDER_CHANNEL, () => host.showOpenDialog());

  // §1.5 #6. The renderer decides *whether* to ask (it is the only side that
  // knows the window is unfocused and that a card just arrived); the shell owns
  // the toast and what clicking it does.
  host.ipc.handle(NOTIFY_CHANNEL, async (payload) => {
    const request = readNotifyRequest(payload);
    if (request === undefined) return false;
    await host.notify({ title: request.title, body: request.body, route: request.route });
    navigate(request.route);
    return true;
  });

  host.ipc.handle(SET_BADGE_CHANNEL, (payload) => {
    const count = readBadgeCount(payload);
    if (count === undefined) return false;
    openQuestions = count;
    host.app.setBadgeCount(count);
    // The tray label and the taskbar badge are the same number by construction,
    // which is what the acceptance means by "match the inbox count".
    refreshTray();
    return true;
  });

  await window.loadURL(coreUrl);
  focusWindow();

  return {
    kind: 'running',
    shell: { coreUrl, window, openQuestions: () => openQuestions },
  };
}

/**
 * "Stop background service" (§1.5 #3).
 *
 * Deliberately fire-and-forget and deliberately silent on failure: the core
 * answers this request and *then* stops, so a dropped connection is the expected
 * outcome rather than an error. The window notices through its own event stream
 * and reports `offline` — which is the honest report, and is the renderer's job
 * rather than the shell's.
 */
async function stopCore(request: typeof globalThis.fetch, coreUrl: string): Promise<void> {
  try {
    await request(`${coreUrl}/api/service/shutdown`, { method: 'POST' });
  } catch {
    /* the core stopping mid-response is the success case */
  }
}
