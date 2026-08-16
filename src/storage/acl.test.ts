import { describe, expect, it } from 'vitest';

import { currentUserPrincipal, describeAclOutcome, tightenDirectoryAcl } from './acl.js';

describe('currentUserPrincipal', () => {
  it('qualifies the user with the domain, so icacls does not have to guess', () => {
    expect(currentUserPrincipal({ USERNAME: 'sam', USERDOMAIN: 'DESKTOP-1' })).toBe(
      'DESKTOP-1\\sam',
    );
  });

  it('falls back to the bare username when no domain is set', () => {
    expect(currentUserPrincipal({ USERNAME: 'sam' })).toBe('sam');
  });

  it('is undefined when the environment names no user', () => {
    expect(currentUserPrincipal({})).toBeUndefined();
    expect(currentUserPrincipal({ USERNAME: '   ' })).toBeUndefined();
  });
});

describe('tightenDirectoryAcl', () => {
  it('grants the current user before stripping inheritance', () => {
    const calls: string[][] = [];
    const outcome = tightenDirectoryAcl('C:\\data', {
      platform: 'win32',
      principal: 'DESKTOP-1\\sam',
      run: (args) => void calls.push([...args]),
    });

    expect(outcome).toEqual({ applied: true });
    expect(calls).toHaveLength(2);
    // Order matters: a directory reachable only through an inherited ACE would
    // otherwise be locked away from its own owner if the grant never landed.
    expect(calls[0]).toEqual(['C:\\data', '/grant:r', 'DESKTOP-1\\sam:(OI)(CI)F', '/Q']);
    expect(calls[1]).toEqual(['C:\\data', '/inheritance:r', '/Q']);
  });

  it('is a no-op off Windows', () => {
    let ran = false;
    const outcome = tightenDirectoryAcl('/tmp/data', {
      platform: 'linux',
      run: () => void (ran = true),
    });
    expect(outcome).toEqual({ applied: false, reason: 'not-windows' });
    expect(ran).toBe(false);
  });

  it('skips when the environment names no user', () => {
    const outcome = tightenDirectoryAcl('C:\\data', {
      platform: 'win32',
      env: {},
      run: () => {
        throw new Error('should not run');
      },
    });
    expect(outcome).toEqual({ applied: false, reason: 'no-principal' });
  });

  it('reports failure instead of throwing, so a boot is never lost to an ACL', () => {
    const outcome = tightenDirectoryAcl('C:\\data', {
      platform: 'win32',
      principal: 'DESKTOP-1\\sam',
      run: () => {
        throw new Error('icacls: Access is denied.');
      },
    });
    expect(outcome).toEqual({ applied: false, reason: 'failed' });
  });
});

describe('describeAclOutcome', () => {
  it('explains every outcome for the boot log', () => {
    expect(describeAclOutcome({ applied: true })).toMatch(/tightened/);
    expect(describeAclOutcome({ applied: false, reason: 'not-windows' })).toMatch(/Windows/);
    expect(describeAclOutcome({ applied: false, reason: 'no-principal' })).toMatch(/USERNAME/);
    expect(describeAclOutcome({ applied: false, reason: 'failed' })).toMatch(/icacls/);
  });
});
