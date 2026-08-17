/**
 * The renderer half of ui IMPLEMENTATION §6, criterion 4:
 *
 * > "The renderer has no Node access: `require`, `process` and `window.electron`
 * > beyond the declared five keys are undefined."
 *
 * The `require`/`process` half is `web/test/sourceScan.test.ts`, which scans
 * everything that reaches the bundle. This file owns the third clause: what the
 * page may see on the bridge, and what happens when it sees something else.
 *
 * The other criterion here is the design's own rule — "every consumer
 * feature-detects (`if (bridge.pickFolder)`) rather than branching on delivery
 * mode" — which is why every capability is optional and why the browser stub is a
 * well-formed object rather than `undefined`.
 */
import { describe, expect, it } from 'vitest';

import { BRIDGE_GLOBAL, BROWSER_BRIDGE, readDesktopBridge } from './bridge';

describe('the browser build', () => {
  it('ships a stub that says so and offers nothing', () => {
    expect(BROWSER_BRIDGE.isElectron).toBe(false);
    expect(BROWSER_BRIDGE.pickFolder).toBeUndefined();
    expect(BROWSER_BRIDGE.notify).toBeUndefined();
    expect(BROWSER_BRIDGE.setBadge).toBeUndefined();
  });

  it('is what a window with no bridge on it reads as', () => {
    expect(readDesktopBridge({})).toEqual(BROWSER_BRIDGE);
    expect(readDesktopBridge(undefined)).toEqual(BROWSER_BRIDGE);
  });
});

describe('the Electron build', () => {
  const full = {
    [BRIDGE_GLOBAL]: {
      isElectron: true,
      coreUrl: 'http://127.0.0.1:7477',
      pickFolder: () => Promise.resolve('C:\\Code\\app'),
      notify: () => Promise.resolve(true),
      setBadge: () => Promise.resolve(true),
    },
  };

  it('adopts exactly the five declared keys', () => {
    const bridge = readDesktopBridge(full);
    expect(Object.keys(bridge).sort()).toEqual(
      ['coreUrl', 'isElectron', 'notify', 'pickFolder', 'setBadge'].sort(),
    );
  });

  it('never adopts a sixth key the preload was not supposed to expose', () => {
    const bridge = readDesktopBridge({
      [BRIDGE_GLOBAL]: { ...full[BRIDGE_GLOBAL], ipcRenderer: {}, require: () => undefined },
    });
    expect(Object.keys(bridge)).not.toContain('ipcRenderer');
    expect(Object.keys(bridge)).not.toContain('require');
  });
});

describe('a malformed bridge degrades rather than throwing', () => {
  it('falls back to the browser stub when isElectron is not true', () => {
    // The value comes from outside the bundle. A page that trusts it and calls
    // `pickFolder()` on a half-upgraded shell throws on the first Browse click.
    expect(readDesktopBridge({ [BRIDGE_GLOBAL]: { pickFolder: () => undefined } })).toEqual(
      BROWSER_BRIDGE,
    );
    expect(readDesktopBridge({ [BRIDGE_GLOBAL]: 'yes' })).toEqual(BROWSER_BRIDGE);
  });

  it('loses one capability rather than the app when a key is the wrong kind', () => {
    const bridge = readDesktopBridge({
      [BRIDGE_GLOBAL]: {
        isElectron: true,
        pickFolder: 'not a function',
        setBadge: () => undefined,
      },
    });
    expect(bridge.isElectron).toBe(true);
    expect(bridge.pickFolder).toBeUndefined();
    expect(bridge.setBadge).toBeDefined();
  });
});
