/**
 * The `InputQueue` of §4.2 — streaming input's whole cost.
 */
import { describe, expect, it } from 'vitest';

import { createInputQueue } from './inputQueue.js';
import type { SDKUserMessage } from './sdk.js';

async function drain(iterable: AsyncIterable<SDKUserMessage>): Promise<SDKUserMessage[]> {
  const seen: SDKUserMessage[] = [];
  for await (const message of iterable) seen.push(message);
  return seen;
}

describe('createInputQueue', () => {
  it('yields pushed messages in order and ends when closed', async () => {
    const queue = createInputQueue();
    queue.push('first');
    queue.push('second');
    queue.close();

    const messages = await drain(queue);
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages[0]?.message.content)).toContain('first');
    expect(messages[0]?.parent_tool_use_id).toBeNull();
    // SDK-NOTES §2.3: `session_id` is optional on input, so the initial prompt
    // can be queued before `init` tells us the id.
    expect(messages[0]?.session_id).toBeUndefined();
  });

  it('delivers a message pushed while the consumer is waiting', async () => {
    const queue = createInputQueue();
    const drained = drain(queue);
    // The consumer is parked on the waiter at this point.
    await Promise.resolve();
    queue.push('late arrival');
    queue.close();

    const messages = await drained;
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0])).toContain('late arrival');
  });

  it('compiles attachments to base64 image blocks (§4.2)', async () => {
    const queue = createInputQueue();
    queue.push('look at this', {
      attachments: [{ mediaType: 'image/png', data: 'aGVsbG8=' }],
    });
    queue.close();

    const [message] = await drain(queue);
    const content = message?.message.content;
    expect(Array.isArray(content)).toBe(true);
    expect(JSON.stringify(content)).toContain('"type":"image"');
    expect(JSON.stringify(content)).toContain('aGVsbG8=');
  });

  it('never throws: an internal failure closes it and is reported instead', async () => {
    const errors: unknown[] = [];
    const queue = createInputQueue({ onError: (error) => errors.push(error) });
    queue.push('fine');

    // A value that cannot be serialised is the closest stand-in for "something
    // inside went wrong"; whatever the cause, §4.2's rule is the same — the
    // iterator must not throw, because the SDK would report the failure as
    // "Claude Code process aborted by user".
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    queue.push(circular as unknown as string);
    queue.close();

    await expect(drain(queue)).resolves.toBeDefined();
  });

  it('reports pending and closed, and ignores a push after close', async () => {
    const queue = createInputQueue();
    queue.push('one');
    expect(queue.pending).toBe(1);
    queue.close();
    expect(queue.closed).toBe(true);
    queue.push('ignored');
    expect(queue.pending).toBe(1);

    const messages = await drain(queue);
    expect(messages).toHaveLength(1);
  });
});
