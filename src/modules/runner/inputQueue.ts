/**
 * The `InputQueue` of runner DESIGN §4.2 — the async-iterable every session is
 * launched with, because §4.1 pins streaming input for every session and no
 * one-shot path.
 *
 * ```ts
 * class InputQueue implements AsyncIterable<SDKUserMessage> {
 *   push(text, opts?): void;
 *   close(): void;                 // ends the iterable → the SDK loop winds down
 *   get pending(): number;
 * }
 * ```
 *
 * Three properties from §4.2 and SDK-NOTES §2.2, all of them load-bearing:
 *
 * - **The initial prompt is pushed before `query()` is called**, so the first
 *   turn starts immediately.
 * - **It never throws.** SDK-NOTES §2.2: the wrapper pumps the iterable with
 *   `streamInput(prompt).catch(e => abortController.abort(e))`, so an error
 *   thrown out of the iterator does not surface as itself — it surfaces as
 *   "Claude Code process aborted by user", masking the real cause. Every
 *   internal error is therefore caught and turned into `close()`.
 * - **Closing it closes the child's stdin**, which is the documented way to wind
 *   a session down, and is one-way. When any bidirectional feature is in use —
 *   `canUseTool` always is, for runner — the pump waits for the first `result`
 *   before ending input, so closing mid-turn does not truncate that turn.
 *
 * M3 pushes one message and closes at the turn boundary; M6 adds steering on
 * top of the same object, which is why the queue owns the whole input lifetime
 * rather than the reader loop calling `Query.streamInput()` per turn.
 *
 * ## Two counters and a hold, all three added by M6
 *
 * §2.4 step 2 — "if the input queue holds an unsent steer message, keep going" —
 * cannot be read off `pending`, because SDK-NOTES §2.2 shows the wrapper pumping
 * the iterable **lazily but immediately**: a pushed message is handed to the
 * child on the next microtask, so `pending` is back to 0 long before the turn it
 * started ends. The honest question is "have more messages been pushed than
 * turns have completed", which is {@link SessionInputQueue.pushed} against the
 * reader loop's turn count.
 *
 * {@link SessionInputQueue.hold} covers the window §4.3 opens and `pushed`
 * cannot: `steer({interrupt:true})` calls `interrupt()`, waits for the turn to
 * wind down, and only *then* pushes. Between the interrupted turn's `result` and
 * that push the counters say "one push, one turn — close", which would end the
 * session the steer was meant to redirect. A hold taken for the whole verb keeps
 * the queue open across it.
 */
import { randomUUID } from 'node:crypto';

import type { SDKUserMessage } from './sdk.js';

/** A base64 image attachment (§4.2). The API accepts them; the UI may ship later. */
export interface ImageAttachment {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Base64, without a data-URL prefix. */
  readonly data: string;
}

export interface PushOptions {
  readonly attachments?: readonly ImageAttachment[];
}

export interface SessionInputQueue extends AsyncIterable<SDKUserMessage> {
  /**
   * Queues one user message and returns its `uuid`.
   *
   * The uuid is stamped by runner rather than left to the CLI because it is the
   * only handle on a message once it is inside the engine: SDK-NOTES **G4**'s
   * interrupt receipt lists `still_queued` **uuids**, and "only uuid-STAMPED
   * messages appear". An unstamped steer that survives an interrupt is invisible.
   */
  push(text: string, options?: PushOptions): string;
  /** Ends the iterable. Idempotent, and one-way. */
  close(): void;
  /** Messages pushed but not yet handed to the SDK. */
  readonly pending: number;
  /** Every message ever accepted — §2.4 step 2's real question (see the header). */
  readonly pushed: number;
  /** Outstanding {@link hold}s. The reader loop must not close while any is open. */
  readonly holds: number;
  /**
   * Keeps the queue open across a multi-step delivery (§4.3's interrupting
   * steer). Returns the release, which is idempotent.
   */
  hold(): () => void;
  readonly closed: boolean;
}

export interface InputQueueOptions {
  /** Where a swallowed internal error goes (§4.2: "caught, logged, and turned into `close()`"). */
  readonly onError?: (error: unknown) => void;
}

export function createInputQueue(options: InputQueueOptions = {}): SessionInputQueue {
  const buffer: SDKUserMessage[] = [];
  let waiter: (() => void) | undefined;
  let closed = false;
  let pushed = 0;
  let holds = 0;

  function wake(): void {
    const pending = waiter;
    waiter = undefined;
    pending?.();
  }

  function fail(error: unknown): void {
    // The §4.2 rule in three lines: never throw out of the iterator, report the
    // real error where a human will see it, and end the stream cleanly.
    options.onError?.(error);
    closed = true;
    wake();
  }

  return {
    get pending(): number {
      return buffer.length;
    },
    get pushed(): number {
      return pushed;
    },
    get holds(): number {
      return holds;
    },
    get closed(): boolean {
      return closed;
    },

    hold() {
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
      };
    },

    push(text, pushOptions = {}) {
      // The uuid is minted before anything can throw, so the caller always gets
      // the handle it will need to reconcile a G4 receipt against — even for a
      // push the queue swallowed because it was already closed.
      const uuid = randomUUID();
      try {
        if (closed) return uuid;
        buffer.push(userMessage(uuid, text, pushOptions.attachments ?? []));
        pushed += 1;
        wake();
      } catch (error) {
        fail(error);
      }
      return uuid;
    },

    close() {
      closed = true;
      wake();
    },

    async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      try {
        for (;;) {
          const next = buffer.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (closed) return;
          await new Promise<void>((settle) => {
            waiter = settle;
          });
        }
      } catch (error) {
        fail(error);
      }
    },
  };
}

/**
 * §4.2's message shape, from SDK-NOTES §2.3.
 *
 * `session_id` and `uuid` are optional on input — the SDK's own one-shot path
 * writes `session_id: ""` — so runner need not know the id before `init`, which
 * is what lets the initial prompt be queued before `query()` is called.
 */
function userMessage(
  uuid: string,
  text: string,
  attachments: readonly ImageAttachment[],
): SDKUserMessage {
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  > = [{ type: 'text', text }];

  for (const attachment of attachments) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data },
    });
  }

  return {
    type: 'user',
    message: { role: 'user', content } as SDKUserMessage['message'],
    parent_tool_use_id: null,
    uuid: uuid as NonNullable<SDKUserMessage['uuid']>,
  };
}
