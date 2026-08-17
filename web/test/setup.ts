/**
 * jsdom setup for the web suite.
 *
 * jsdom implements neither `URL.createObjectURL` nor the streaming halves of
 * `fetch`, and both are load-bearing here — the avatar rule of §3.1 and the SSE
 * reader of §3.3. They are stubbed with the smallest honest implementations
 * rather than mocked away, so a test that gets the contract wrong still fails.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

import { useAppStore } from '../src/state/store';

/**
 * `localStorage`.
 *
 * Node 25 defines its own experimental `globalThis.localStorage`, whose getter
 * throws unless the process was started with `--localstorage-file`. It is
 * non-overridable by jsdom's, so the app's storage calls would throw a
 * `SecurityError` in every test rather than behave like a browser's. An
 * in-memory `Storage` is installed over it — small enough to be obviously
 * correct, and it makes the watermark and theme tests mean what they say.
 */
class MemoryStorage implements Storage {
  #entries = new Map<string, string>();

  get length(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#entries.set(key, String(value));
  }
}

const storage = new MemoryStorage();
for (const target of new Set<object>([globalThis, window])) {
  Object.defineProperty(target, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });
}

let objectUrlCounter = 0;
const objectUrls = new Map<string, Blob>();

if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = (blob: Blob): string => {
    objectUrlCounter += 1;
    const url = `blob:agentmanager/${String(objectUrlCounter)}`;
    objectUrls.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url: string): void => {
    objectUrls.delete(url);
  };
}

/** The object URLs still outstanding — how a test proves one was revoked. */
export function liveObjectUrls(): readonly string[] {
  return [...objectUrls.keys()];
}

beforeEach(() => {
  objectUrls.clear();
  window.localStorage.clear();
  // The client store is a module-level singleton in production, which is the
  // right shape there and a leak between tests here: a filter chip clicked in
  // one test would still be pressed in the next.
  useAppStore.getState().reset();
  useAppStore.getState().setTheme('system');
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  cleanup();
});
