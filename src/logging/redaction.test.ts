import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_QUERY_PARAMS,
  REDACTED,
  isSecretKey,
  redactLogArguments,
  redactRecord,
  redactValue,
  scrubText,
} from './redaction.js';

const OAUTH_TOKEN = 'sk-ant-oat01-AbCdEf0123456789_deadbeef-XYZ';
const BEARER_VALUE = 'Zm9vYmFyYmF6cXV1eDEyMzQ1Njc4OTA';

describe('scrubText', () => {
  it('removes Anthropic keys anywhere in the string', () => {
    const scrubbed = scrubText(`using ${OAUTH_TOKEN} now`);
    expect(scrubbed).toBe(`using ${REDACTED} now`);
    expect(scrubbed).not.toContain(OAUTH_TOKEN);
  });

  it('removes the credential from a Bearer header but keeps the scheme', () => {
    const scrubbed = scrubText(`Bearer ${BEARER_VALUE}`);
    expect(scrubbed).toBe(`Bearer ${REDACTED}`);
  });

  it('leaves a short non-credential Bearer-like string alone', () => {
    expect(scrubText('Bearer short')).toBe('Bearer short');
  });

  it('redacts credential query parameters while keeping the parameter name', () => {
    const scrubbed = scrubText('/api/logs/stream?ticket=abc123&level=info');
    expect(scrubbed).toBe(`/api/logs/stream?ticket=${REDACTED}&level=info`);
  });

  it('covers every v1 credential-bearing parameter', () => {
    for (const param of CREDENTIAL_QUERY_PARAMS) {
      expect(scrubText(`/x?${param}=secretvalue`)).toBe(`/x?${param}=${REDACTED}`);
    }
  });

  it('leaves ordinary query strings untouched', () => {
    expect(scrubText('/api/logs?component=runner&limit=50')).toBe(
      '/api/logs?component=runner&limit=50',
    );
  });
});

describe('isSecretKey', () => {
  it('matches known secret fields regardless of separator or case', () => {
    for (const key of [
      'token',
      'access_token',
      'accessToken',
      'Authorization',
      'apiKey',
      'ANTHROPIC_API_KEY',
      'claude.oauthToken',
      'password',
      'clientSecret',
      'cookie',
      'ticket',
      'notify.ntfy.topicUrl',
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('leaves the deliberately logged token metadata and counts readable', () => {
    for (const key of [
      'tokenId',
      'token_prefix',
      'tokenHash',
      'tokenBudget',
      'tokensUsed',
      'inputTokens',
      'output_tokens',
      'secretRef',
      'key',
      'localPathKey',
      'monkey',
      'requestId',
    ]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe('redactValue', () => {
  it('redacts by key path at any depth', () => {
    const redacted = redactValue({
      env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN, PATH: 'C:/bin' },
      list: [{ apiKey: 'plain-value' }],
    });
    expect(redacted).toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: REDACTED, PATH: 'C:/bin' },
      list: [{ apiKey: REDACTED }],
    });
  });

  it('scrubs credentials that appear under innocuous key names', () => {
    expect(redactValue({ note: `key is ${OAUTH_TOKEN}` })).toEqual({ note: `key is ${REDACTED}` });
  });

  it('does not mutate its input', () => {
    const input = { token: 'plain' };
    redactValue(input);
    expect(input.token).toBe('plain');
  });

  it('survives circular references', () => {
    const input: Record<string, unknown> = { token: 'plain' };
    input['self'] = input;
    expect(redactValue(input)).toEqual({ token: REDACTED, self: '[circular]' });
  });

  it('redacts an Error into the standard serializer shape', () => {
    const error = Object.assign(new Error(`failed with ${OAUTH_TOKEN}`), { apiKey: 'plain' });
    const redacted = redactValue(error) as Record<string, unknown>;
    expect(redacted['type']).toBe('Error');
    expect(redacted['message']).toBe(`failed with ${REDACTED}`);
    expect(redacted['apiKey']).toBe(REDACTED);
    expect(JSON.stringify(redacted)).not.toContain(OAUTH_TOKEN);
  });

  it('redacts through a toJSON wrapper rather than walking its internals', () => {
    const secret = { toJSON: () => REDACTED, reveal: () => 'plain' };
    expect(redactValue({ value: secret })).toEqual({ value: REDACTED });
  });

  it('elides beyond the depth cap instead of recursing forever', () => {
    let deep: Record<string, unknown> = { token: 'plain' };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redactValue(deep))).toContain('[truncated]');
  });
});

describe('redactRecord', () => {
  it('redacts top-level secret fields of the merged record', () => {
    expect(
      redactRecord({ authorization: `Bearer ${BEARER_VALUE}`, path: '/x?ticket=t0ken' }),
    ).toEqual({ authorization: REDACTED, path: `/x?ticket=${REDACTED}` });
  });
});

describe('redactLogArguments', () => {
  it('scrubs the message string', () => {
    expect(redactLogArguments([`token ${OAUTH_TOKEN}`])).toEqual([`token ${REDACTED}`]);
  });

  it('rewraps a leading Error so the derived message is scrubbed too', () => {
    const [first, message] = redactLogArguments([new Error(`boom ${OAUTH_TOKEN}`)]);
    expect(message).toBe(`boom ${REDACTED}`);
    expect(JSON.stringify(first)).not.toContain(OAUTH_TOKEN);
  });

  it('keeps an explicit message when one accompanies the Error', () => {
    const args = redactLogArguments([new Error('boom'), 'session failed']);
    expect(args[1]).toBe('session failed');
  });

  it('leaves a leading object for the formatter and scrubs interpolation args', () => {
    const payload = { token: 'plain' };
    const args = redactLogArguments([payload, 'saw %s', `x ${OAUTH_TOKEN}`]);
    expect(args[0]).toBe(payload);
    expect(args[2]).toBe(`x ${REDACTED}`);
  });

  it('returns an empty list unchanged', () => {
    expect(redactLogArguments([])).toEqual([]);
  });
});
