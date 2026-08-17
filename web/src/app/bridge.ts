/**
 * The renderer's view of the Electron preload bridge (DESIGN §1.5).
 *
 * > "The web build ships a stub with `isElectron: false`; every consumer
 * > feature-detects (`if (bridge.pickFolder)`) rather than branching on delivery
 * > mode."
 *
 * That sentence is the entire contract, and it is why every capability here is
 * **optional**: there is one call site per capability and it asks whether the
 * function is there, never which delivery mode it is in. A branch on
 * `isElectron` would be the beginning of two UIs (D3 says there is one), so
 * `isElectron` exists for presentation — an about screen naming the shell — and
 * is not consulted by any behaviour in the app.
 *
 * Nothing in the bundle imports Electron, and nothing here is polyfilled: in a
 * browser the global is simply absent and every optional call is skipped.
 */

/** What a toast asks for. `route` is an app path — the shell owns the origin. */
export interface DesktopNotification {
  readonly title: string;
  readonly body: string;
  readonly route: string;
}

/**
 * The five keys of §1.5, as the page may see them.
 *
 * Four are optional because in a browser there is no bridge at all; `isElectron`
 * is not, because the stub states it.
 */
export interface DesktopBridge {
  readonly isElectron: boolean;
  readonly coreUrl?: string | undefined;
  /** The native folder picker (§1.5 #5). `null` when the user cancelled. */
  pickFolder?: (() => Promise<string | null>) | undefined;
  /** A desktop toast; resolves when the user clicks it (§1.5 #6). */
  notify?: ((request: DesktopNotification) => Promise<boolean>) | undefined;
  /** The taskbar badge and the tray label, which are the same number (§1.5 #6). */
  setBadge?: ((count: number) => Promise<boolean>) | undefined;
}

/** The browser build's bridge: honest about being one, and offering nothing. */
export const BROWSER_BRIDGE: DesktopBridge = Object.freeze({ isElectron: false });

/** The global the preload writes. One name, stated in both codebases. */
export const BRIDGE_GLOBAL = 'agentmanager';

/**
 * Reads the bridge off the window, defensively.
 *
 * Defensively because the value comes from outside the bundle: a partial or
 * malformed bridge must degrade to the browser stub rather than throw at the
 * first `pickFolder()`. Each key is adopted only if it is the right *kind* of
 * thing, so a half-upgraded shell loses one capability instead of the app.
 */
export function readDesktopBridge(scope: unknown = globalThis): DesktopBridge {
  const raw = (scope as Record<string, unknown> | null | undefined)?.[BRIDGE_GLOBAL];
  if (typeof raw !== 'object' || raw === null) return BROWSER_BRIDGE;
  const candidate = raw as Record<string, unknown>;
  if (candidate['isElectron'] !== true) return BROWSER_BRIDGE;
  return {
    isElectron: true,
    ...(typeof candidate['coreUrl'] === 'string' ? { coreUrl: candidate['coreUrl'] } : {}),
    ...(typeof candidate['pickFolder'] === 'function'
      ? { pickFolder: candidate['pickFolder'] as DesktopBridge['pickFolder'] }
      : {}),
    ...(typeof candidate['notify'] === 'function'
      ? { notify: candidate['notify'] as DesktopBridge['notify'] }
      : {}),
    ...(typeof candidate['setBadge'] === 'function'
      ? { setBadge: candidate['setBadge'] as DesktopBridge['setBadge'] }
      : {}),
  };
}
