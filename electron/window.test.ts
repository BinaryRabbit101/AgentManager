/**
 * ui IMPLEMENTATION §6, criterion 4 — the main-process half.
 *
 * > "The renderer has no Node access: `require`, `process` and `window.electron`
 * > beyond the declared five keys are undefined; navigating to an external URL is
 * > refused and opens in the system browser."
 *
 * The renderer half lives in `web/` (`web/src/app/bridge.test.ts` for the five
 * keys and the browser stub, `web/test/sourceScan.test.ts` for "no `require` and
 * no `process` anywhere in the bundle"). This file owns the two facts that live
 * on this side: the `webPreferences` the window is created with, and where a
 * navigation is allowed to go.
 */
import { describe, expect, it } from 'vitest';

import {
  BRIDGE_GLOBAL,
  BRIDGE_KEYS,
  WINDOW_WEB_PREFERENCES,
  navigationDecision,
  windowSpec,
} from './window.js';

describe('the security posture of §1.5', () => {
  it('sets contextIsolation, nodeIntegration and sandbox exactly as the design states', () => {
    expect(WINDOW_WEB_PREFERENCES['contextIsolation']).toBe(true);
    expect(WINDOW_WEB_PREFERENCES['nodeIntegration']).toBe(false);
    expect(WINDOW_WEB_PREFERENCES['sandbox']).toBe(true);
  });

  it('closes the two side doors beside nodeIntegration', () => {
    // A worker or a subframe inheriting Node would reopen the hole the flag
    // above closes, and neither is covered by it.
    expect(WINDOW_WEB_PREFERENCES['nodeIntegrationInWorker']).toBe(false);
    expect(WINDOW_WEB_PREFERENCES['nodeIntegrationInSubFrames']).toBe(false);
    expect(WINDOW_WEB_PREFERENCES['webSecurity']).toBe(true);
  });

  it('carries the preload the caller names, and nothing else new', () => {
    const spec = windowSpec('C:\\app\\electron\\preload.cjs');
    expect(spec.webPreferences['preload']).toBe('C:\\app\\electron\\preload.cjs');
    expect(Object.keys(spec.webPreferences).sort()).toEqual(
      [...Object.keys(WINDOW_WEB_PREFERENCES), 'preload'].sort(),
    );
    // Hidden until the core answers: the first thing on screen is the splash or
    // the app, never an empty frame.
    expect(spec.show).toBe(false);
  });

  it('exposes exactly the five bridge keys, under one global', () => {
    expect([...BRIDGE_KEYS]).toEqual(['isElectron', 'coreUrl', 'pickFolder', 'notify', 'setBadge']);
    expect(BRIDGE_GLOBAL).toBe('agentmanager');
  });
});

describe('navigation is locked to the core’s origin (§1.5 #7)', () => {
  const core = 'http://127.0.0.1:7477';

  it('allows the core’s own routes', () => {
    expect(navigationDecision(core, `${core}/questions/abc`)).toEqual({ kind: 'allow' });
    expect(navigationDecision(core, `${core}/`)).toEqual({ kind: 'allow' });
  });

  it('sends any other http(s) origin to the system browser', () => {
    expect(navigationDecision(core, 'https://github.com/anthropics')).toEqual({
      kind: 'external',
      url: 'https://github.com/anthropics',
    });
    // A different port is a different origin, even on loopback — the core is
    // identified by its origin, not by its host.
    expect(navigationDecision(core, 'http://127.0.0.1:7999/').kind).toBe('external');
  });

  it('refuses schemes a browser must not be handed', () => {
    // Agent output is untrusted text (§1.4) and a link in it reaches this
    // function. Handing `file:` or `javascript:` to `openExternal` would turn a
    // rendered transcript into a local file read.
    expect(navigationDecision(core, 'file:///C:/Windows/System32/drivers/etc/hosts')).toEqual({
      kind: 'refuse',
      reason: 'refused the file: scheme',
    });
    expect(navigationDecision(core, 'javascript:alert(1)').kind).toBe('refuse');
    expect(navigationDecision(core, 'not a url').kind).toBe('refuse');
  });
});
