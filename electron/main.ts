/**
 * The shell's entry point: the only file that touches the real Electron module.
 *
 * Everything interesting lives in `shell.ts`, `discovery.ts`, `window.ts` and
 * `tray.ts`, all of which are driven through injected seams so they can be unit-
 * tested here (Electron needs a downloaded binary and a display; this repository
 * has neither). This file is the adapter that fills those seams in with the real
 * thing — and it is deliberately shallow, because it is the one part of the shell
 * that no test in this repository executes.
 *
 * **`electron` is resolved at runtime, not imported.** Packaging the shell is
 * foundation §7's explicitly deferred half; adding a ~200 MB devDependency so a
 * type import resolves would be paying for packaging early and would make
 * `npm ci` on the core's own machine slower for no gain. `createRequire` gives
 * the module when it is there and a clear failure when it is not.
 *
 * The discovery half reuses foundation's **own** `readPortFile` / `probeCore`
 * (`src/lifecycle/portFile.ts`), which document themselves as "*the* discovery
 * procedure, not private helpers". One implementation of "is a core listening",
 * not two.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findInstallRoot, loadConfig } from '../src/config/index.js';
import { PORT_FILENAME, probeCore, readPortFile } from '../src/lifecycle/portFile.js';
import { dataRootPaths } from '../src/storage/index.js';

import type { DiscoveryDeps } from './discovery.js';
import type { ElectronHost, MenuItemSpec, WindowLike, WindowSpec } from './host.js';
import { runShell } from './shell.js';

const here = dirname(fileURLToPath(import.meta.url));
const installRoot = findInstallRoot(here);
// The same resolution the core performs, so the shell reads the same
// `run/core.port` the core writes — including a `--data-root` or an environment
// override. Guessing the platform default would find the wrong core on a machine
// whose data root was moved.
const paths = dataRootPaths(loadConfig({ installRoot, argv: [] }).paths.dataRoot);

/**
 * `<install>\app\main.js` — the core, started exactly as the scheduled task
 * starts it (foundation §4.3), and **detached** so it outlives this process.
 */
function spawnCore(): void {
  const child = spawn(process.execPath, [join(installRoot, 'dist', 'main.js')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // No handle is kept: foundation §4.1 says the shell never owns the core, and a
  // reference is how "never owns" quietly becomes "kills on exit".
  child.unref();
}

const discovery: DiscoveryDeps = {
  readPortFile: () => readPortFile(join(paths.run, PORT_FILENAME)),
  probe: (port) => probeCore(port),
  spawnCore,
  sleep: (ms) => new Promise((settle) => setTimeout(settle, ms)),
  now: () => Date.now(),
  logPath: join(paths.logs, 'core.log'),
};

interface ElectronModule {
  readonly app: Record<string, (...args: unknown[]) => unknown>;
  readonly BrowserWindow: new (spec: unknown) => WindowLike;
  readonly Tray: new (icon: string) => {
    setToolTip(text: string): void;
    setContextMenu(menu: unknown): void;
  };
  readonly Menu: { buildFromTemplate(template: unknown): unknown };
  readonly Notification: new (spec: unknown) => {
    on(event: 'click', listener: () => void): void;
    show(): void;
  };
  readonly ipcMain: { handle(channel: string, listener: (...args: never[]) => unknown): void };
  readonly dialog: {
    showOpenDialog(options: unknown): Promise<{ canceled: boolean; filePaths: string[] }>;
  };
  readonly shell: { openExternal(url: string): Promise<void> };
}

function hostFrom(electron: ElectronModule): ElectronHost {
  const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, dialog, shell } = electron;
  return {
    app: {
      whenReady: () => app['whenReady']?.() as Promise<void>,
      requestSingleInstanceLock: () => app['requestSingleInstanceLock']?.() === true,
      on: (event, listener) => void app['on']?.(event, listener),
      quit: () => void app['quit']?.(),
      setBadgeCount: (count) => app['setBadgeCount']?.(count) === true,
    },
    ipc: {
      // Electron hands the handler `(event, ...args)`; the shell only ever wants
      // the payload, and never the sender.
      handle: (channel, listener) =>
        ipcMain.handle(channel, (_event: never, payload: never) => listener(payload)),
    },
    createWindow: (spec: WindowSpec) => new BrowserWindow(spec),
    createTray: () => {
      const tray = new Tray(resolve(installRoot, 'app', 'web', 'favicon.ico'));
      return {
        setToolTip: (text) => tray.setToolTip(text),
        setContextMenu: (template: readonly MenuItemSpec[]) =>
          tray.setContextMenu(Menu.buildFromTemplate([...template])),
      };
    },
    notify: (spec) =>
      new Promise<void>((settle) => {
        const toast = new Notification({ title: spec.title, body: spec.body });
        toast.on('click', () => settle());
        toast.show();
      }),
    openExternal: (url) => shell.openExternal(url),
    showOpenDialog: async () => {
      const answer = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return answer.canceled ? null : (answer.filePaths[0] ?? null);
    },
  };
}

export async function main(): Promise<void> {
  const electron = createRequire(import.meta.url)('electron') as ElectronModule;
  const outcome = await runShell({
    host: hostFrom(electron),
    discovery,
    preloadPath: join(here, 'preload.cjs'),
    fetch: globalThis.fetch,
    showStartupFailure: (message, logPath) => {
      // Deliberately the console and not a dialog: a dialog here would be the
      // eighth responsibility, and the splash/failure screen is a window-level
      // check on the manual list rather than something this file invents.
      console.error(`${message}\n${logPath}`);
    },
  });
  if (outcome.kind === 'failed') process.exitCode = 1;
}

await main();
