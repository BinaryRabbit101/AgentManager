/**
 * The window, its security posture, and the navigation lock (DESIGN §1.5).
 *
 * > "**Security posture**: `contextIsolation: true`, `nodeIntegration: false`,
 * > `sandbox: true`, a preload exposing exactly
 * > `{ isElectron: true, coreUrl, pickFolder(), notify(), setBadge() }`, and
 * > navigation locked to the core's origin."
 *
 * All four are data, not behaviour, so they are stated once here and asserted
 * once in `window.test.ts`. The renderer is a **web page served over HTTP by the
 * core** — never `file://` (§1.5 #2) — which is what mechanically keeps the
 * Electron client and the tailnet client the same client: same origin model, same
 * relative paths, same bundle, one build (D3).
 */

import type { WindowSpec } from './host.js';

/** The exactly-five keys of the preload bridge. Longer is a security review. */
export const BRIDGE_KEYS = ['isElectron', 'coreUrl', 'pickFolder', 'notify', 'setBadge'] as const;
export type BridgeKey = (typeof BRIDGE_KEYS)[number];

/** The global the preload writes, and the only one the page may see. */
export const BRIDGE_GLOBAL = 'agentmanager';

/**
 * §1.5's posture, verbatim.
 *
 * `preload` is filled in by `main.ts`, which is the only file that knows where
 * the built preload script landed.
 */
export const WINDOW_WEB_PREFERENCES: Readonly<Record<string, unknown>> = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  // Belt and braces beside `nodeIntegration: false`: a worker inheriting Node
  // would reopen the hole the other two flags close.
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
});

export function windowSpec(preloadPath: string): WindowSpec {
  return {
    width: 1_280,
    height: 860,
    // Hidden until the core answers, so the first thing on screen is the splash
    // or the app — never an empty frame (§1.5 #1).
    show: false,
    webPreferences: { ...WINDOW_WEB_PREFERENCES, preload: preloadPath },
  };
}

export type NavigationDecision =
  /** Same origin as the core: an ordinary in-app navigation. */
  | { readonly kind: 'allow' }
  /** Anything else: refused in-window, handed to the system browser (§1.5 #7). */
  | { readonly kind: 'external'; readonly url: string }
  /** Not a URL the shell will hand to anything — `file:`, `javascript:`, junk. */
  | { readonly kind: 'refuse'; readonly reason: string };

/**
 * Where a navigation is allowed to go.
 *
 * Three outcomes rather than two, because "open it in the system browser" is only
 * safe for a scheme a browser will treat as a web page. `file:`, `javascript:`
 * and unparseable input are refused outright — handing them to `openExternal`
 * would turn a link in untrusted agent output into a local file read or worse.
 */
export function navigationDecision(coreOrigin: string, target: string): NavigationDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { kind: 'refuse', reason: 'not a URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'refuse', reason: `refused the ${url.protocol} scheme` };
  }
  if (url.origin === coreOrigin) return { kind: 'allow' };
  return { kind: 'external', url: url.href };
}
