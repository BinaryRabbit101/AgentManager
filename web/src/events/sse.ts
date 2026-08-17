/**
 * A minimal SSE reader over `fetch`, and the reason it is not `EventSource`.
 *
 * `EventSource` cannot set a request header, cannot see a `:` comment, and owns
 * its own reconnect policy. All three matter here:
 *
 * - **Header.** The bearer of §3.1 is a header. Remote §3.4's ticket dance
 *   exists precisely because `EventSource` cannot send one; reading the stream
 *   with `fetch` means the ticket is an option rather than a requirement, and
 *   {@link SseTransport} keeps the seam so remote can substitute it later
 *   without any screen learning that it happened.
 * - **Comments.** Foundation's stream heartbeats with `: keep-alive` every 15s
 *   (`http/sse.ts`). A client that cannot observe it cannot tell a quiet feed
 *   from a dead socket, which is the difference between `live` and `offline`.
 * - **Reconnect.** §3.3 wants replay from a watermark with the *same* `types=`
 *   subset and an explicit backoff, not the browser's three-second retry.
 *
 * This file does the wire format and nothing else: no reconnect, no state, no
 * cache. {@link EventStream} owns those.
 */

/** One parsed SSE frame. `comment` is a heartbeat and carries no fields. */
export interface SseFrame {
  readonly kind: 'event' | 'comment';
  readonly event?: string;
  readonly id?: string;
  readonly data?: string;
}

/**
 * Feeds raw text in and gets whole frames out.
 *
 * Stateful because a chunk boundary lands anywhere, including inside a field
 * name; the tail is held until the blank line that terminates a frame arrives.
 */
export class SseParser {
  #buffer = '';

  push(chunk: string): SseFrame[] {
    // Normalise line endings first: the spec allows CRLF, LF and bare CR.
    this.#buffer += chunk.replace(/\r\n?/gu, '\n');
    const frames: SseFrame[] = [];
    for (;;) {
      const end = this.#buffer.indexOf('\n\n');
      if (end === -1) break;
      const block = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      const frame = parseBlock(block);
      if (frame !== undefined) frames.push(frame);
    }
    return frames;
  }
}

function parseBlock(block: string): SseFrame | undefined {
  const lines = block.split('\n').filter((line) => line !== '');
  if (lines.length === 0) return undefined;
  // A block of nothing but comments is a heartbeat.
  if (lines.every((line) => line.startsWith(':'))) return { kind: 'comment' };

  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // "If value starts with a space, remove it" — the one spec quirk that bites.
    const rest = colon === -1 ? '' : line.slice(colon + 1);
    const value = rest.startsWith(' ') ? rest.slice(1) : rest;
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  return {
    kind: 'event',
    ...(event === undefined ? {} : { event }),
    ...(id === undefined ? {} : { id }),
    data: data.join('\n'),
  };
}

export interface SseConnection {
  /** Resolves when the server closes the stream; rejects when it breaks. */
  readonly done: Promise<void>;
  close(): void;
}

export interface SseHandlers {
  onFrame(frame: SseFrame): void;
  /** Any byte at all, heartbeat included — what the staleness watchdog resets on. */
  onActivity(): void;
  onOpen(): void;
}

/**
 * How a stream is opened. The default reads it with `fetch`; remote substitutes
 * the ticket flavour here and nothing else in the app changes (§3.3).
 */
export type SseTransport = (
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  handlers: SseHandlers,
) => SseConnection;

export const fetchTransport =
  (fetchImpl: typeof globalThis.fetch): SseTransport =>
  (url, headers, signal, handlers) => {
    const controller = new AbortController();
    signal.addEventListener('abort', () => controller.abort(), { once: true });

    const done = (async () => {
      const response = await fetchImpl(url, {
        headers: { ...headers, accept: 'text/event-stream' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`The event stream answered ${String(response.status)}.`);
      }
      const body = response.body;
      if (body === null) throw new Error('The event stream carried no body.');

      handlers.onOpen();
      const reader = body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = new SseParser();
      try {
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) return;
          handlers.onActivity();
          for (const frame of parser.push(value)) handlers.onFrame(frame);
        }
      } finally {
        reader.cancel().catch(() => {
          // The stream is already going away; a cancel that fails is not news.
        });
      }
    })();

    return {
      done,
      close: () => controller.abort(),
    };
  };
