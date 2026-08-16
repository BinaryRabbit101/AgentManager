import { existsSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DATABASE_FILENAME,
  dataRootPaths,
  defaultMigrationsDir,
  managedDirectories,
} from './paths.js';

const root = resolve(sep, 'tmp', 'AgentManager');

describe('dataRootPaths', () => {
  it('lays out the §1.2 tree under the data root', () => {
    const paths = dataRootPaths(root);

    expect(paths.config).toBe(resolve(root, 'config'));
    expect(paths.library).toBe(resolve(root, 'library'));
    expect(paths.state).toBe(resolve(root, 'state'));
    expect(paths.database).toBe(resolve(root, 'state', DATABASE_FILENAME));
    expect(paths.backups).toBe(resolve(root, 'state', 'backups'));
    expect(paths.transcripts).toBe(resolve(root, 'state', 'transcripts'));
    expect(paths.logs).toBe(resolve(root, 'state', 'logs'));
    expect(paths.secrets).toBe(resolve(root, 'state', 'secrets'));
    expect(paths.worktrees).toBe(resolve(root, 'worktrees'));
    expect(paths.run).toBe(resolve(root, 'run'));
    expect(paths.cache).toBe(resolve(root, 'cache'));
  });

  it('honours a relocated library root (§1.2 allows it outside the data root)', () => {
    const elsewhere = resolve(sep, 'tmp', 'Documents', 'AgentManager-Library');
    const paths = dataRootPaths(root, { libraryRoot: elsewhere });
    expect(paths.library).toBe(elsewhere);
    expect(paths.dataRoot).toBe(root);
  });

  it('honours a relocated worktrees root (config `projects.worktreesRoot`)', () => {
    const elsewhere = resolve(sep, 'tmp', 'worktrees');
    expect(dataRootPaths(root, { worktreesRoot: elsewhere }).worktrees).toBe(elsewhere);
  });

  it('refuses a relative data root, rather than resolving it against cwd', () => {
    expect(() => dataRootPaths('AgentManager')).toThrow(TypeError);
  });

  it('refuses a relative override', () => {
    expect(() => dataRootPaths(root, { libraryRoot: './library' })).toThrow(TypeError);
  });

  it('touches no disk', () => {
    const paths = dataRootPaths(resolve(sep, 'tmp', 'definitely-not-created-by-a-test'));
    expect(existsSync(paths.dataRoot)).toBe(false);
  });
});

describe('managedDirectories', () => {
  it('lists every directory the bootstrap owns, parents before children', () => {
    const paths = dataRootPaths(root);
    const directories = managedDirectories(paths);

    expect(directories).toContain(paths.dataRoot);
    expect(directories).toContain(paths.backups);
    expect(directories.indexOf(paths.state)).toBeLessThan(directories.indexOf(paths.backups));
    // Directories only: the database file is not created by the bootstrap.
    expect(directories).not.toContain(paths.database);
  });
});

describe('defaultMigrationsDir', () => {
  it('resolves to the packaged migrations directory containing 0001_init.sql', () => {
    const dir = defaultMigrationsDir();
    expect(isAbsolute(dir)).toBe(true);
    expect(existsSync(resolve(dir, '0001_init.sql'))).toBe(true);
  });
});
