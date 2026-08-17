/**
 * The preload bridge (DESIGN §1.5).
 *
 * > "a preload exposing exactly
 * > `{ isElectron: true, coreUrl, pickFolder(), notify(), setBadge() }`"
 *
 * Five keys. Nothing else crosses the boundary — not `ipcRenderer`, not
 * `require`, not `process`, not a generic `invoke`. A bridge with a generic
 * escape hatch is not a bridge, it is `nodeIntegration: true` spelled at length.
 *
 * **Why this file is CommonJS (`.cts`) and stands alone.** A preload running
 * under `sandbox: true` is loaded as CommonJS and may `require` only Electron's
 * sandboxed subset, so it cannot import the rest of `electron/`, which is ESM.
 * The channel names and the key list are therefore literals here — and
 * `preload.test.ts` pins those literals against `channels.ts` and `window.ts` by
 * reading this file, so the duplication cannot drift silently.
 *
 * `coreUrl` is the origin the window was loaded from. The page already knows it
 * (`location.origin`); it is on the bridge because §1.5 lists it, and because a
 * renderer that wants to be sure it is talking to the core it was launched
 * against should not have to trust its own address bar.
 */

// A sandboxed preload is CommonJS and may only `require` Electron's own subset;
// an `import` here is not loadable by Electron at all.
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron') as {
  contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  ipcRenderer: { invoke(channel: string, payload?: unknown): Promise<unknown> };
};

// A preload runs in the renderer's context, so `location` is there — but this
// project has no DOM lib (it is the core's tsconfig, and the core is a server).
declare const location: { readonly origin: string };

contextBridge.exposeInMainWorld('agentmanager', {
  isElectron: true,
  coreUrl: location.origin,
  pickFolder: (): Promise<unknown> => ipcRenderer.invoke('agentmanager:pickFolder'),
  notify: (request: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agentmanager:notify', request),
  setBadge: (count: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agentmanager:setBadge', count),
});
