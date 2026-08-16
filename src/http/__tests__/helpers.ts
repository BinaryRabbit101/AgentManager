/**
 * Test helpers for the HTTP surface.
 *
 * Everything here talks to a real listener over a real socket on an ephemeral
 * port. Nothing stubs the server: the acceptance criteria of M8 are about what a
 * client observes, and a test that asserts on a handler's return value would
 * prove nothing about the access log, the SPA fallback or an SSE stream.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findInstallRoot } from '../../config/index.js';

/** The repository root, which is also a valid install root (`config/defaults.json`). */
export const repoRoot = findInstallRoot(dirname(fileURLToPath(import.meta.url)));

export interface TempDir {
  readonly path: string;
  cleanup(): void;
}

export function makeTempDir(prefix = 'agentmanager-http-'): TempDir {
  const path = mkdtempSync(resolve(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true, maxRetries: 5 }) };
}

export interface HttpAnswer<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
  readonly text: string;
}

/** A request against a running listener, with the body parsed when it is JSON. */
export async function call<T = unknown>(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<HttpAnswer<T>> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: unknown = text;
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, headers: response.headers, body: body as T, text };
}

export interface SseFrame {
  readonly event: string | undefined;
  readonly id: string | undefined;
  /** The `data:` payload, parsed when it is JSON. */
  readonly data: unknown;
  readonly raw: string;
}

export interface SseHandle {
  readonly frames: readonly SseFrame[];
  /** Resolves once `count` frames of `event` (any, when omitted) have arrived. */
  waitFor(count: number, event?: string, timeoutMs?: number): Promise<readonly SseFrame[]>;
  close(): void;
  /** Resolves once the response headers are in — i.e. the server has subscribed. */
  readonly connected: Promise<void>;
}

/**
 * A minimal server-sent-events client.
 *
 * `connected` resolving is the moment the handler has run far enough to write
 * its headers, which is what lets a test emit *after* subscribing without
 * guessing at a delay.
 */
export function openStream(url: string, init: RequestInit = {}): SseHandle {
  const controller = new AbortController();
  const frames: SseFrame[] = [];
  const waiters: { count: number; event?: string; resolve: () => void }[] = [];
  let resolveConnected: () => void = () => {};
  let rejectConnected: (cause: unknown) => void = () => {};
  const connected = new Promise<void>((res, rej) => {
    resolveConnected = res;
    rejectConnected = rej;
  });

  const settle = (): void => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter === undefined) continue;
      const matching = frames.filter(
        (frame) => waiter.event === undefined || frame.event === waiter.event,
      );
      if (matching.length >= waiter.count) {
        waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  };

  void (async () => {
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      resolveConnected();
      const body = response.body;
      if (body === null) return;
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const frame = parseFrame(block);
          if (frame !== undefined) {
            frames.push(frame);
            settle();
          }
          split = buffer.indexOf('\n\n');
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) rejectConnected(cause);
    }
  })();

  return {
    frames,
    connected,
    close: () => controller.abort(),
    waitFor: (count, event, timeoutMs = 4000) =>
      new Promise((res, rej) => {
        const matching = frames.filter((frame) => event === undefined || frame.event === event);
        if (matching.length >= count) {
          res(matching);
          return;
        }
        const timer = setTimeout(() => {
          rej(
            new Error(
              `timed out waiting for ${String(count)} ${event ?? 'any'} frames; got ` +
                `${String(frames.length)}: ${frames.map((f) => f.event ?? '-').join(', ')}`,
            ),
          );
        }, timeoutMs);
        waiters.push({
          count,
          ...(event === undefined ? {} : { event }),
          resolve: () => {
            clearTimeout(timer);
            res(frames.filter((frame) => event === undefined || frame.event === event));
          },
        });
      }),
  };
}

function parseFrame(block: string): SseFrame | undefined {
  const lines = block.split('\n');
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('id: ')) id = line.slice(4);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  if (data.length === 0 && event === undefined) return undefined;
  const raw = data.join('\n');
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON; the raw text is the payload.
  }
  return { event, id, data: parsed, raw };
}
