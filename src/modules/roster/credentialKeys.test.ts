/**
 * DESIGN §10's one definition of "looks like a credential".
 */
import { describe, expect, it } from 'vitest';

import { isCredentialShapedKey } from './credentialKeys.js';

describe('isCredentialShapedKey', () => {
  it.each([
    'GMAIL_TOKEN',
    'gmail_token',
    'API_KEY',
    'Authorization',
    'AUTH',
    'AUTH_HEADER',
    'CLIENT_SECRET',
    'DB_PASSWORD',
    'X-Api-Key',
    'REFRESH_TOKEN_URL',
  ])('requires a secretRef for %s', (key) => {
    expect(isCredentialShapedKey(key)).toBe(true);
  });

  it.each(['GMAIL_PROFILE', 'MAILBOX', 'HOME', 'LANG', 'Content-Type', 'OAUTH_CALLBACK_URL'])(
    'allows a literal for %s',
    (key) => {
      expect(isCredentialShapedKey(key)).toBe(false);
    },
  );

  it('is deliberately over-broad rather than clever', () => {
    // `*KEY*` catches keys that hold no credential. That asymmetry is the
    // decision: a false positive costs one secretRef, a false negative writes
    // a live credential into git.
    expect(isCredentialShapedKey('MONKEY_COUNT')).toBe(true);
  });
});
