/**
 * DESIGN §3.2: a `Secret` leaks nothing through any accidental stringification.
 *
 * These are the "only `.reveal()` returns plaintext" acceptance tests, and they
 * check the three routes a value actually escapes by in practice — a JSON API
 * response, a template literal in a log message, and a bare `console.log` of an
 * object someone was debugging.
 */
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import { isSecret, previewOf, REDACTED, Secret } from './secret.js';

const PLAINTEXT = 'sk-ant-oat01-supersecret-value-1234';

describe('Secret', () => {
  it('yields "[redacted]" from JSON.stringify, directly and nested in a payload', () => {
    const secret = new Secret(PLAINTEXT);

    expect(JSON.stringify(secret)).toBe(`"${REDACTED}"`);
    expect(JSON.stringify({ token: secret, note: 'ok' })).toBe(
      `{"token":"${REDACTED}","note":"ok"}`,
    );
    expect(JSON.stringify(secret)).not.toContain('supersecret');
  });

  it('yields "[redacted]" from template interpolation and every string coercion', () => {
    const secret = new Secret(PLAINTEXT);

    // The coercions a careless caller performs are the subject of the test, so
    // the lint rules that exist to stop them in production code are stood down
    // here rather than the test being weakened to satisfy them.
    /* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/restrict-plus-operands */
    expect(`token=${secret}`).toBe(`token=${REDACTED}`);
    expect(String(secret)).toBe(REDACTED);
    expect(secret + '').toBe(REDACTED);
    /* eslint-enable @typescript-eslint/restrict-template-expressions, @typescript-eslint/restrict-plus-operands */
    expect([secret].join(',')).toBe(REDACTED);
  });

  it('yields "[redacted]" from console.log and util.inspect', () => {
    const secret = new Secret(PLAINTEXT);
    const written: string[] = [];
    // A real `Console` over a capture stream, rather than the global one: this
    // is the same implementation and the same formatting, but the test runner's
    // own console interception cannot swallow the bytes being asserted on.
    const sink = new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        done();
      },
    });
    const capturing = new Console({ stdout: sink });

    capturing.log(secret);
    capturing.log({ nested: { token: secret } });
    capturing.log('token is %s', secret);

    const output = written.join('');
    expect(output).toContain(REDACTED);
    expect(output).not.toContain('supersecret');
    expect(inspect(secret)).toBe(REDACTED);
    expect(inspect({ token: secret })).toContain(REDACTED);
  });

  it('exposes the plaintext only through reveal()', () => {
    const secret = new Secret(PLAINTEXT);

    expect(secret.reveal()).toBe(PLAINTEXT);
    // The value is a #private field, so it is not an own property either.
    expect(Object.keys(secret)).toEqual([]);
    expect(JSON.stringify({ ...secret })).toBe('{}');
  });

  it('previews the last four characters only', () => {
    expect(new Secret(PLAINTEXT).preview()).toBe('1234');
    expect(previewOf('abcdefgh')).toBe('efgh');
    expect(previewOf('ab')).toBe('ab');
    expect(previewOf('')).toBe('');
  });

  it('identifies itself without exposing the class to duck-typing', () => {
    expect(isSecret(new Secret('x'))).toBe(true);
    expect(isSecret({ reveal: () => 'x' })).toBe(false);
    expect(Object.prototype.toString.call(new Secret('x'))).toBe('[object Secret]');
  });
});
