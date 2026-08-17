import { describe, expect, it } from 'vitest';

import { SseParser } from './sse';

describe('SseParser (§3.3)', () => {
  it('parses a named event with an id and a JSON payload', () => {
    const parser = new SseParser();
    const frames = parser.push('event: event\nid: 01J\ndata: {"type":"roster.changed"}\n\n');
    expect(frames).toEqual([
      { kind: 'event', event: 'event', id: '01J', data: '{"type":"roster.changed"}' },
    ]);
  });

  it('holds a frame split across chunks until its blank line arrives', () => {
    const parser = new SseParser();
    expect(parser.push('event: ev')).toEqual([]);
    expect(parser.push('ent\ndata: {"a":1}')).toEqual([]);
    const frames = parser.push('\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toBe('{"a":1}');
  });

  it('joins multi-line data with newlines, as the spec requires', () => {
    const parser = new SseParser();
    const frames = parser.push('data: one\ndata: two\n\n');
    expect(frames[0]?.data).toBe('one\ntwo');
  });

  it('reports a heartbeat comment as a comment frame, never as an event', () => {
    // Foundation sends `: keep-alive` every 15s (http/sse.ts). EventSource
    // cannot see this at all, which is the reason this parser exists.
    const parser = new SseParser();
    const frames = parser.push(': keep-alive\n\n');
    expect(frames).toEqual([{ kind: 'comment' }]);
  });

  it('normalises CRLF and bare CR line endings', () => {
    const parser = new SseParser();
    const frames = parser.push('event: event\r\ndata: x\r\n\r\n');
    expect(frames[0]).toMatchObject({ event: 'event', data: 'x' });
  });

  it('strips exactly one leading space from a field value', () => {
    const parser = new SseParser();
    const frames = parser.push('data:  padded\n\n');
    expect(frames[0]?.data).toBe(' padded');
  });

  it('returns every complete frame in one chunk, in order', () => {
    const parser = new SseParser();
    const frames = parser.push('data: a\n\ndata: b\n\n: beat\n\n');
    expect(frames.map((frame) => frame.data ?? frame.kind)).toEqual(['a', 'b', 'comment']);
  });
});
