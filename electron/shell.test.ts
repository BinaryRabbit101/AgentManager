/**
 * The shell wired together (ui IMPLEMENTATION §6).
 *
 * Criteria covered here, each as a named test:
 *
 * - **closing the window leaves the core running** — nothing in the shell stops
 *   it, asserted by driving `closed` and checking no shutdown request was made;
 * - **a second app launch focuses the existing window** — the single-instance
 *   lock, both halves;
 * - **an external URL is refused and opens in the system browser**;
 * - **the folder picker** is reachable from the page and returns a path;
 * - **a toast focuses the window on that card**, and **the tray label and the
 *   taskbar badge match the inbox count** — one number driving both;
 * - **"Stop background service" stops the core** through `POST
 *   /api/service/shutdown` and does not quit the app.
 *
 * The Electron API is a fake built to `host.ts`, which is the whole reason that
 * interface exists: Electron needs a downloaded binary and a display, neither of
 * which this repository has. What genuinely needs a window — the splash, the
 * first paint, a real process outliving a real window — is on the manual
 * checklist (`npm run checks:ui`).
 */
import { describe, expect, it } from 'vitest';

import {
  NOTIFY_CHANNEL,
  PICK_FOLDER_CHANNEL,
  SET_BADGE_CHANNEL,
  isAppRoute,
  readBadgeCount,
  readNotifyRequest,
} from './channels.js';
import type { DiscoveryDeps, PortRecord } from './discovery.js';
import type {
  ElectronHost,
  MenuItemSpec,
  NotificationSpec,
  PreventableEvent,
  WindowLike,
  WindowSpec,
} from './host.js';
import { runShell, type ShellOutcome } from './shell.js';

const RECORD: PortRecord = {
  port: 7477,
  pid: 1,
  startedAt: '2026-08-17T09:00:00.000Z',
  edition: 'home',
};

interface Fake {
  readonly host: ElectronHost;
  readonly requests: { url: string; method: string | undefined }[];
  readonly loaded: string[];
  readonly opened: string[];
  readonly toasts: NotificationSpec[];
  readonly badges: number[];
  readonly quits: number[];
  readonly spawns: number[];
  menu: readonly MenuItemSpec[];
  tooltip: string;
  focuses: number;
  closedListener: (() => void) | undefined;
  secondInstance: (() => void) | undefined;
  navigate(url: string): 'allowed' | 'prevented';
  openPopup(url: string): 'deny' | 'allow';
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  pickedFolder: string | null;
  /** Resolves the pending toast, as the user clicking it does. */
  clickToast: (() => void) | undefined;
}

function fake(options: { readonly lock?: boolean } = {}): Fake {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  let willNavigate: ((event: PreventableEvent, url: string) => void) | undefined;
  let openHandler: ((details: { url: string }) => { action: 'deny' | 'allow' }) | undefined;

  const state: Fake = {
    requests: [],
    loaded: [],
    opened: [],
    toasts: [],
    badges: [],
    quits: [],
    spawns: [],
    menu: [],
    tooltip: '',
    focuses: 0,
    closedListener: undefined,
    secondInstance: undefined,
    pickedFolder: 'C:\\Code\\littlepocketmuseum',
    clickToast: undefined,
    navigate: (url) => {
      let prevented = false;
      willNavigate?.({ preventDefault: () => (prevented = true) }, url);
      return prevented ? 'prevented' : 'allowed';
    },
    openPopup: (url) => openHandler?.({ url }).action ?? 'allow',
    // `Promise.resolve` rather than `async`, because that is what
    // `ipcRenderer.invoke` does: it resolves whatever the handler returned,
    // promise or plain value, and the badge handler returns a plain value.
    invoke: (channel, payload) => Promise.resolve(handlers.get(channel)?.(payload)),
    host: {
      app: {
        whenReady: () => Promise.resolve(),
        requestSingleInstanceLock: () => options.lock !== false,
        on: (_event, listener) => {
          state.secondInstance = listener;
        },
        quit: () => state.quits.push(1),
        setBadgeCount: (count) => {
          state.badges.push(count);
          return true;
        },
      },
      ipc: {
        handle: (channel, listener) => handlers.set(channel, listener),
      },
      createWindow: (_spec: WindowSpec): WindowLike => ({
        loadURL: (url) => {
          state.loaded.push(url);
          return Promise.resolve();
        },
        show: () => undefined,
        focus: () => {
          state.focuses += 1;
        },
        isMinimized: () => false,
        restore: () => undefined,
        isDestroyed: () => false,
        webContents: {
          setWindowOpenHandler: (handler) => {
            openHandler = handler;
          },
          on: (_event, listener) => {
            willNavigate = listener;
          },
        },
        on: (_event, listener) => {
          state.closedListener = listener;
        },
      }),
      createTray: () => ({
        setToolTip: (text) => {
          state.tooltip = text;
        },
        setContextMenu: (template) => {
          state.menu = template;
        },
      }),
      notify: (spec) =>
        new Promise<void>((settle) => {
          state.toasts.push(spec);
          state.clickToast = settle;
        }),
      openExternal: (url) => {
        state.opened.push(url);
        return Promise.resolve();
      },
      showOpenDialog: () => Promise.resolve(state.pickedFolder),
    },
  };
  return state;
}

function discovery(state: Fake): DiscoveryDeps {
  return {
    readPortFile: () => RECORD,
    probe: () => Promise.resolve({ status: 'ok' }),
    spawnCore: () => state.spawns.push(1),
    sleep: () => Promise.resolve(),
    now: () => 0,
    logPath: 'C:\\Data\\state\\logs\\core.log',
  };
}

async function start(state: Fake): Promise<ShellOutcome> {
  return runShell({
    host: state.host,
    discovery: discovery(state),
    preloadPath: 'C:\\app\\electron\\preload.cjs',
    fetch: ((url: string, init?: RequestInit) => {
      state.requests.push({ url, method: init?.method });
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof globalThis.fetch,
  });
}

describe('startup', () => {
  it('connects to a running core and loads it over HTTP', async () => {
    const state = fake();
    const outcome = await start(state);

    expect(outcome.kind).toBe('running');
    expect(state.spawns).toEqual([]);
    expect(state.loaded).toEqual(['http://127.0.0.1:7477']);
  });

  it('a second launch focuses the existing window and quits, without a window', async () => {
    // §1.5 #4, first half: the lock attempt is the *first* thing the shell does,
    // so a second launch costs a lock and an exit — not a window and a probe.
    const state = fake({ lock: false });

    const outcome = await start(state);

    expect(outcome).toEqual({ kind: 'second-instance' });
    expect(state.quits).toHaveLength(1);
    expect(state.loaded).toEqual([]);
  });

  it('the running instance focuses its window when a second one launches', async () => {
    const state = fake();
    await start(state);
    const before = state.focuses;

    state.secondInstance?.();

    expect(state.focuses).toBe(before + 1);
  });
});

describe('closing the window never stops the core (foundation §4.1)', () => {
  it('does nothing at all on close — no shutdown request, no quit', async () => {
    const state = fake();
    await start(state);

    state.closedListener?.();

    expect(state.requests).toEqual([]);
    expect(state.quits).toEqual([]);
  });

  it('quitting the app is separate from stopping the service', async () => {
    const state = fake();
    await start(state);

    state.menu.find((row) => row.id === 'quit')?.click?.();

    expect(state.quits).toHaveLength(1);
    // Quit is the app leaving. The core keeps running, which is the whole point
    // of a headless core: a session started before bed is still going in the
    // morning whether or not the window was open.
    expect(state.requests).toEqual([]);
  });
});

describe('external links (§1.5 #7)', () => {
  it('refuses an in-page navigation off the core’s origin and opens the browser', async () => {
    const state = fake();
    await start(state);

    expect(state.navigate('https://github.com/anthropics')).toBe('prevented');
    expect(state.opened).toEqual(['https://github.com/anthropics']);
  });

  it('lets the app navigate itself', async () => {
    const state = fake();
    await start(state);

    expect(state.navigate('http://127.0.0.1:7477/questions/abc')).toBe('allowed');
    expect(state.opened).toEqual([]);
  });

  it('never opens a second Electron window, even same-origin', async () => {
    // Multi-window is on §1.5's deferred list; a same-origin popup would be one.
    const state = fake();
    await start(state);

    expect(state.openPopup('http://127.0.0.1:7477/usage')).toBe('deny');
    expect(state.openPopup('https://example.com/')).toBe('deny');
    expect(state.opened).toEqual(['https://example.com/']);
  });

  it('refuses a file: URL without handing it to the system browser', async () => {
    const state = fake();
    await start(state);

    expect(state.navigate('file:///C:/Windows/win.ini')).toBe('prevented');
    expect(state.opened).toEqual([]);
  });
});

describe('the folder picker (§1.5 #5)', () => {
  it('returns the chosen path to the page and nothing else', async () => {
    const state = fake();
    await start(state);

    await expect(state.invoke(PICK_FOLDER_CHANNEL)).resolves.toBe('C:\\Code\\littlepocketmuseum');
  });

  it('returns null when the dialog is cancelled', async () => {
    const state = fake();
    state.pickedFolder = null;
    await start(state);

    await expect(state.invoke(PICK_FOLDER_CHANNEL)).resolves.toBeNull();
  });
});

describe('toasts and the badge (§1.5 #6)', () => {
  it('shows a toast and focuses the window on that card when it is clicked', async () => {
    const state = fake();
    await start(state);
    const focusesBefore = state.focuses;

    const pending = state.invoke(NOTIFY_CHANNEL, {
      title: 'Priya is asking',
      body: 'Store transcripts in the DB or on disk?',
      route: '/questions/q-1',
    });
    expect(state.toasts).toEqual([
      {
        title: 'Priya is asking',
        body: 'Store transcripts in the DB or on disk?',
        route: '/questions/q-1',
      },
    ]);

    state.clickToast?.();
    await expect(pending).resolves.toBe(true);

    expect(state.loaded.at(-1)).toBe('http://127.0.0.1:7477/questions/q-1');
    expect(state.focuses).toBeGreaterThan(focusesBefore);
  });

  it('refuses a route the renderer made up', async () => {
    // The renderer is the least trusted input the main process has — it renders
    // untrusted agent output, and `route` becomes a navigation.
    const state = fake();
    await start(state);

    await expect(
      state.invoke(NOTIFY_CHANNEL, { title: 'x', body: 'y', route: 'https://evil.example/' }),
    ).resolves.toBe(false);
    expect(state.toasts).toEqual([]);
    expect(isAppRoute('//evil.example/')).toBe(false);
    expect(isAppRoute('/questions/abc')).toBe(true);
    expect(readNotifyRequest({ title: 'x', body: 'y' })).toBeUndefined();
  });

  it('drives the tray label and the taskbar badge from the same number', async () => {
    const state = fake();
    await start(state);

    await state.invoke(SET_BADGE_CHANNEL, 3);

    expect(state.badges).toEqual([3]);
    expect(state.menu.find((row) => row.id === 'questions')?.label).toBe('3 questions waiting');
    expect(state.tooltip).toBe('AgentManager — 3 questions waiting');
  });

  it('clamps a nonsense count rather than passing it on', async () => {
    const state = fake();
    await start(state);

    await state.invoke(SET_BADGE_CHANNEL, -2);
    expect(state.badges).toEqual([0]);
    await expect(state.invoke(SET_BADGE_CHANNEL, 'lots')).resolves.toBe(false);
    expect(readBadgeCount(2.7)).toBe(2);
  });
});

describe('Stop background service (§1.5 #3)', () => {
  it('asks the core to stop itself, and leaves the window to report it', async () => {
    const state = fake();
    const outcome = await start(state);

    state.menu.find((row) => row.id === 'stop-core')?.click?.();
    await Promise.resolve();

    expect(state.requests).toEqual([
      { url: 'http://127.0.0.1:7477/api/service/shutdown', method: 'POST' },
    ]);
    // The app stays up: the window notices through its own event stream and
    // reports `offline`, which is the honest report and is the renderer's job.
    expect(state.quits).toEqual([]);
    expect(outcome.kind).toBe('running');
  });
});
