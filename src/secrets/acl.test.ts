/**
 * DESIGN §3.1: the secrets directory and the keyfile are "written with an ACL
 * granting the current user only and inheritance disabled".
 *
 * The last two tests run real `icacls` against a real temporary directory and
 * are Windows-only. They are the acceptance criterion — asserting the arguments
 * we pass proves we asked for the right thing, but only reading the resulting
 * ACL back proves Windows agreed.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { currentUserPrincipal, tightenFileAcl, tightenSecretsDirectoryAcl } from './acl.js';
import { ensureSecretsDir } from './envelope.js';
import { MASTER_KEY_FILENAME } from './keyfile.js';
import { createSecretStore } from './store.js';
import { fakeIcacls, makeTempDir, onWindows, type TempDir } from './__tests__/helpers.js';

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir();
});
afterEach(() => {
  temp.cleanup();
});

/** The access-control entries `icacls` reports for a path, as `PRINCIPAL:(flags)` strings. */
function readAces(path: string): string[] {
  const output = execFileSync('icacls', [path], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  return (
    output
      .split(/\r?\n/)
      .map((line) => (line.startsWith(path) ? line.slice(path.length) : line).trim())
      // Summary lines ("Successfully processed 1 files…") carry no `PRINCIPAL:(flags)` pair.
      .filter((line) => /^.+:\([^)]*\)/.test(line))
  );
}

function principalOf(ace: string): string {
  return (ace.split(':(')[0] ?? '').toLowerCase();
}

describe('acl arguments', () => {
  it('grants a file to the current user before stripping inheritance, with no directory flags', () => {
    const run = fakeIcacls();
    expect(
      tightenFileAcl('C:\\data\\master.key', {
        platform: 'win32',
        principal: 'TESTDOMAIN\\tester',
        run,
      }),
    ).toEqual({ applied: true });

    expect(run.calls).toEqual([
      ['C:\\data\\master.key', '/grant:r', 'TESTDOMAIN\\tester:F', '/Q'],
      ['C:\\data\\master.key', '/inheritance:r', '/Q'],
    ]);
  });

  it('forwards the directory form to the shared helper, keeping (OI)(CI)', () => {
    const run = fakeIcacls();
    tightenSecretsDirectoryAcl('C:\\data\\secrets', {
      platform: 'win32',
      principal: 'TESTDOMAIN\\tester',
      run,
    });
    expect(run.calls[0]).toEqual([
      'C:\\data\\secrets',
      '/grant:r',
      'TESTDOMAIN\\tester:(OI)(CI)F',
      '/Q',
    ]);
  });

  it('reports rather than throws when icacls fails or the host is not Windows', () => {
    expect(tightenFileAcl('/tmp/key', { platform: 'linux' })).toEqual({
      applied: false,
      reason: 'not-windows',
    });
    expect(tightenFileAcl('C:\\key', { platform: 'win32', env: {} })).toEqual({
      applied: false,
      reason: 'no-principal',
    });
    expect(
      tightenFileAcl('C:\\key', {
        platform: 'win32',
        principal: 'TESTDOMAIN\\tester',
        run: () => {
          throw new Error('Access is denied.');
        },
      }),
    ).toEqual({ applied: false, reason: 'failed' });
  });
});

describe.skipIf(!onWindows)('real ACLs on Windows', () => {
  it('leaves state/secrets granting the current user only, with inheritance disabled', async () => {
    await ensureSecretsDir(temp.secretsDir);
    const inheritedBefore = readAces(temp.secretsDir);
    // A directory under %TEMP% starts out with inherited ACEs; if it did not,
    // the assertion below would pass without the tightening having done anything.
    expect(inheritedBefore.some((ace) => ace.includes('(I)'))).toBe(true);

    expect(tightenSecretsDirectoryAcl(temp.secretsDir, { env: process.env })).toEqual({
      applied: true,
    });

    const aces = readAces(temp.secretsDir);
    const me = (currentUserPrincipal(process.env) ?? '').toLowerCase();
    expect(me).not.toBe('');
    expect(aces).toHaveLength(1);
    expect(principalOf(aces[0] ?? '')).toBe(me);
    expect(aces.some((ace) => ace.includes('(I)'))).toBe(false);
  });

  it('leaves master.key granting the current user only, with inheritance disabled', async () => {
    // Through the real store, so what is asserted is what a boot actually produces.
    await createSecretStore({
      secretsDir: temp.secretsDir,
      provider: 'keyfile',
      env: process.env,
    });

    const aces = readAces(resolve(temp.secretsDir, MASTER_KEY_FILENAME));
    const me = (currentUserPrincipal(process.env) ?? '').toLowerCase();
    expect(aces).toHaveLength(1);
    expect(principalOf(aces[0] ?? '')).toBe(me);
    expect(aces.some((ace) => ace.includes('(I)'))).toBe(false);
  });
});
