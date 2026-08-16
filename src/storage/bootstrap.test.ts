import { readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrapDataRoot } from './bootstrap.js';
import { managedDirectories } from './paths.js';
import { makeTempRoot, recordingLog, type TempRoot } from './__tests__/helpers.js';

let temp: TempRoot;

beforeEach(() => {
  temp = makeTempRoot();
});

afterEach(() => {
  temp.cleanup();
});

/** `makeTempRoot` creates the directory; a *fresh* root is one level below it. */
function freshRoot(name = 'AgentManager'): string {
  return resolve(temp.path, name);
}

describe('bootstrapDataRoot', () => {
  it('creates every §1.2 directory', () => {
    const result = bootstrapDataRoot({ dataRoot: freshRoot(), tightenAcl: false });

    for (const directory of managedDirectories(result.paths)) {
      expect(statSync(directory).isDirectory(), `${directory} should exist`).toBe(true);
    }
    expect(result.created).toBe(true);
    expect(result.createdDirectories).toEqual(managedDirectories(result.paths));
  });

  it('creates directories only — the library contents belong to roster (§4.4)', () => {
    const result = bootstrapDataRoot({ dataRoot: freshRoot(), tightenAcl: false });

    expect(readdirSync(result.paths.library)).toEqual([]);
    expect(readdirSync(result.paths.config)).toEqual([]);
    // No database file either: creating it is the engine's job, not the tree's.
    expect(readdirSync(result.paths.state).sort()).toEqual([
      'backups',
      'logs',
      'secrets',
      'transcripts',
    ]);
  });

  it('is idempotent: a second call creates nothing', () => {
    const dataRoot = freshRoot();
    bootstrapDataRoot({ dataRoot, tightenAcl: false });
    const second = bootstrapDataRoot({ dataRoot, tightenAcl: false });

    expect(second.created).toBe(false);
    expect(second.createdDirectories).toEqual([]);
  });

  it('recreates run/ and cache/ when they have been deleted (§1.2)', () => {
    const dataRoot = freshRoot();
    const first = bootstrapDataRoot({ dataRoot, tightenAcl: false });
    rmSync(first.paths.run, { recursive: true, force: true });
    rmSync(first.paths.cache, { recursive: true, force: true });

    const second = bootstrapDataRoot({ dataRoot, tightenAcl: false });
    expect(second.createdDirectories).toEqual([first.paths.run, first.paths.cache]);
    expect(statSync(first.paths.run).isDirectory()).toBe(true);
  });

  it('creates a relocated library root outside the data root', () => {
    const libraryRoot = resolve(temp.path, 'Documents', 'AgentManager-Library');
    const result = bootstrapDataRoot({
      dataRoot: freshRoot(),
      libraryRoot,
      tightenAcl: false,
    });

    expect(result.paths.library).toBe(libraryRoot);
    expect(statSync(libraryRoot).isDirectory()).toBe(true);
  });

  it('tightens the ACL when it creates the data root, and reports the outcome', () => {
    const calls: string[][] = [];
    const log = recordingLog();
    const result = bootstrapDataRoot({
      dataRoot: freshRoot(),
      log,
      acl: { platform: 'win32', principal: 'DESKTOP-1\\sam', run: (a) => void calls.push([...a]) },
    });

    expect(result.acl).toEqual({ applied: true });
    expect(calls.map((c) => c[0])).toEqual([result.paths.dataRoot, result.paths.dataRoot]);
    expect(log.records.some((r) => r.msg.includes('ACL'))).toBe(true);
  });

  it('does not re-ACL a data root that already existed', () => {
    const dataRoot = freshRoot();
    bootstrapDataRoot({ dataRoot, tightenAcl: false });

    const second = bootstrapDataRoot({
      dataRoot,
      acl: {
        platform: 'win32',
        principal: 'DESKTOP-1\\sam',
        run: () => {
          throw new Error('should not run on an existing root');
        },
      },
    });
    expect(second.acl).toBeUndefined();
  });

  it('still returns a usable tree when the ACL step fails (best-effort, §3.1 spirit)', () => {
    const log = recordingLog();
    const result = bootstrapDataRoot({
      dataRoot: freshRoot(),
      log,
      acl: {
        platform: 'win32',
        principal: 'DESKTOP-1\\sam',
        run: () => {
          throw new Error('icacls: Access is denied.');
        },
      },
    });

    expect(result.acl).toEqual({ applied: false, reason: 'failed' });
    expect(statSync(result.paths.dataRoot).isDirectory()).toBe(true);
    expect(log.records.some((r) => r.level === 'warn')).toBe(true);
  });
});
