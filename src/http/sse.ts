/**
 * Server-sent events — the transport for `/api/logs/stream` and `/api/events`
 * (DESIGN §5.3, §6.5).
 *
 * SSE rather than WebSockets for these two: both are one-way server→client
 * pushes over plain HTTP, so they inherit the route table, the access log, the
 * per-route remote policy and the bearer middleware unchanged. A WebSocket
 * upgrade would need its own copy of all four, which is exactly the "second
 * implementation to keep in sync" §6.4 exists to avoid.
 */
import type { ServerResponse } from 'node:http';

import type { ResponseInit, SseMessage, SseStream } from './types.js';

/** Keep-alive comment interval. Well inside the 60 s idle timeout proxies default to. */
export const SSE_HEARTBEAT_MS = 15_000;

export interface SseOptions extends ResponseInit {
  /** `0` disables the heartbeat (tests with fake timers). */
  readonly heartbeatMs?: number;
}

/** Escapes a payload into `data:` lines — an SSE frame cannot carry a bare newline. */
function encode(message: SseMessage): string {
  const payload = typeof message.data === 'string' ? message.data : JSON.stringify(message.data);
  const lines: string[] = [];
  if (message.event !== undefined) lines.push(`event: ${message.event}`);
  if (message.id !== undefined) lines.push(`id: ${message.id}`);
  if (message.retry !== undefined) lines.push(`retry: ${String(message.retry)}`);
  for (const line of (payload ?? 'null').split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

/**
 * Takes over `response` and returns the stream handle the handler writes to.
 *
 * Headers go out immediately (and are flushed), so a client that connects knows
 * it is connected before the first event exists — which is what makes
 * "subscribe, then emit, then receive within a second" a reliable sequence
 * rather than a race.
 */
export function openSse(response: ServerResponse, options: SseOptions = {}): SseStream {
  const listeners: (() => void)[] = [];
  let closed = false;

  response.statusCode = options.status ?? 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache, no-transform');
  response.setHeader('connection', 'keep-alive');
  // Defeats proxy buffering, which otherwise holds events until a buffer fills.
  response.setHeader('x-accel-buffering', 'no');
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    response.setHeader(key.toLowerCase(), value);
  }
  response.flushHeaders();
  response.write(': open\n\n');

  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  let heartbeat: NodeJS.Timeout | undefined;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A close listener that throws must not stop the others unsubscribing.
      }
    }
    if (!response.writableEnded) response.end();
  };

  response.on('close', finish);
  response.on('error', finish);

  const stream: SseStream = {
    send(message) {
      if (closed || response.writableEnded) return;
      response.write(encode(message));
    },
    comment(commentText) {
      if (closed || response.writableEnded) return;
      response.write(`: ${commentText}\n\n`);
    },
    onClose(listener) {
      if (closed) {
        listener();
        return;
      }
      listeners.push(listener);
    },
    close: finish,
    get closed() {
      return closed;
    },
  };

  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => stream.comment('keep-alive'), heartbeatMs);
    // A heartbeat must never be the reason the process cannot exit.
    heartbeat.unref();
  }

  return stream;
}
