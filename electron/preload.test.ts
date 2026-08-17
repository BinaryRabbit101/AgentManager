/**
 * The preload, pinned at the source (ui IMPLEMENTATION §6, criterion 4).
 *
 * `preload.cts` is CommonJS and stands alone — a preload running under
 * `sandbox: true` cannot import the rest of `electron/`, which is ESM — so its
 * channel names and its key list are literals. That duplication is the only one
 * in the shell, and this file is what stops it drifting: the literals in the file
 * are compared against the exported constants they duplicate.
 *
 * The prohibitions are asserted the same way, because they are absences: there
 * is no `exposeInMainWorld('ipcRenderer', …)` to observe at runtime, only its
 * absence to check for.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NOTIFY_CHANNEL, PICK_FOLDER_CHANNEL, SET_BADGE_CHANNEL } from './channels.js';
import { BRIDGE_GLOBAL, BRIDGE_KEYS } from './window.js';

const source = readFileSync(resolve(process.cwd(), 'electron', 'preload.cts'), 'utf8');
const code = source
  .split('\n')
  .filter((line) => !/^\s*(?:\/\/|\/\*|\*\/|\*)/u.test(line))
  .join('\n');

describe('the preload exposes exactly the five keys of §1.5', () => {
  it('names every one of them', () => {
    for (const key of BRIDGE_KEYS) expect(code).toContain(`${key}:`);
  });

  it('exposes them under the one declared global', () => {
    expect(code).toContain(`exposeInMainWorld('${BRIDGE_GLOBAL}'`);
    // One call, so there is exactly one thing on `window` to review.
    expect(code.match(/contextBridge\.exposeInMainWorld/gu)).toHaveLength(1);
  });

  it('adds nothing beyond the five', () => {
    // The object literal's own keys, read back out of the source.
    const body = /exposeInMainWorld\('[^']+',\s*\{([\s\S]*?)\n\}\);/u.exec(code)?.[1] ?? '';
    const keys = [...body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gmu)].map((match) => match[1]);
    expect(keys).toEqual([...BRIDGE_KEYS]);
  });
});

describe('nothing privileged crosses the bridge', () => {
  it('never hands the page ipcRenderer, require, process or a generic invoke', () => {
    // A bridge with a generic escape hatch is `nodeIntegration: true` spelled at
    // length. `ipcRenderer.invoke` appears inside the three closures; what must
    // not appear is `ipcRenderer` itself as a *value* on the exposed object.
    expect(code).not.toMatch(/ipcRenderer\s*,/u);
    expect(code).not.toMatch(/\bprocess\b/u);
    expect(code).not.toMatch(/invoke:\s/u);
    expect(code).not.toMatch(/\brequire:/u);
  });

  it('uses the three declared channels and no others', () => {
    const channels = [...code.matchAll(/invoke\('([^']+)'/gu)].map((match) => match[1]);
    expect(channels).toEqual([PICK_FOLDER_CHANNEL, NOTIFY_CHANNEL, SET_BADGE_CHANNEL]);
  });
});
