/**
 * Library bootstrap (roster DESIGN §2.1, IMPLEMENTATION M2).
 *
 * The headline acceptance, verbatim: "Pointed at an empty, existing library
 * directory (what the installer leaves behind), first run produces
 * `roster.json`, `.gitignore`, `agents/`, and an initialised git repo with
 * **zero commits**; a second run changes nothing."
 *
 * The zero-commit half is checked twice — once against a fake `git` (so the
 * suite runs on a machine without one) and once against the real executable
 * when it is on `PATH`, because "we never commit" is a claim about a real
 * repository and a fake cannot fail to keep it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LIBRARY_GITIGNORE,
  bootstrapLibrary,
  createGitCommand,
  isEmptyDirectory,
  libraryCommitCount,
} from './bootstrap.js';
import { fakeGit, makeSpacedTempDir, makeTempDir, type TempDir } from './__tests__/helpers.js';

let temp: TempDir;

/** True when a real `git` executable is on PATH. */
function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  temp = makeTempDir('agentmanager-roster-bootstrap-');
});

afterEach(() => {
  temp.cleanup();
});

describe('first run against an empty, existing directory (§4.4)', () => {
  it('writes roster.json, .gitignore and agents/, and initialises git', () => {
    const library = join(temp.path, 'library');
    mkdirSync(library, { recursive: true });
    expect(isEmptyDirectory(library)).toBe(true);

    const { git, calls } = fakeGit();
    const result = bootstrapLibrary({ root: library, git });

    expect(existsSync(join(library, 'roster.json'))).toBe(true);
    expect(existsSync(join(library, '.gitignore'))).toBe(true);
    expect(statSync(join(library, 'agents')).isDirectory()).toBe(true);
    // §2.4's `templates/` is created alongside `agents/` (WO5).
    expect(statSync(join(library, 'templates')).isDirectory()).toBe(true);
    expect(result.created).toHaveLength(4);
    expect(result.gitInitialised).toBe(true);
    expect(result.diagnostics).toEqual([]);

    // `git init` and nothing else: no `add`, no `commit`, ever (§2.1).
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('init');
    expect(calls.some((call) => call.includes('commit') || call.includes('add'))).toBe(false);
  });

  it('records schemaVersion and an unseeded roster.json', () => {
    const library = join(temp.path, 'library');
    mkdirSync(library, { recursive: true });
    const { git } = fakeGit();
    bootstrapLibrary({ root: library, git });

    expect(JSON.parse(readFileSync(join(library, 'roster.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      // Seeding is M10's; a bootstrap that claimed otherwise would make the
      // seeding milestone a no-op on an already-bootstrapped library.
      seededAt: null,
      // WO5's second stamp, unset for the same reason and on its own schedule.
      templatesSeededAt: null,
    });
  });

  it('ignores in-flight atomic writes and the archive, and mentions no secrets', () => {
    const library = join(temp.path, 'library');
    const { git } = fakeGit();
    bootstrapLibrary({ root: library, git });

    const ignore = readFileSync(join(library, '.gitignore'), 'utf8');
    expect(ignore).toBe(LIBRARY_GITIGNORE);
    expect(ignore).toContain('*.tmp-*');
    expect(ignore).toContain('.archive/');

    // Secrets never enter the library at all (§10), so no *rule* excludes one;
    // the header comment says so in prose, which is why only the rules are
    // examined here.
    const rules = ignore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(rules).toEqual(['*.tmp-*', '.archive/', 'Thumbs.db', '.DS_Store']);
    expect(rules.some((rule) => /\.env|secret|token|key/i.test(rule))).toBe(false);
  });

  it('creates the root itself when the installer has not', () => {
    const library = join(temp.path, 'not', 'created', 'yet');
    const { git } = fakeGit();
    const result = bootstrapLibrary({ root: library, git });

    expect(statSync(library).isDirectory()).toBe(true);
    expect(result.created).toContain(result.paths.root);
  });
});

describe('a second run', () => {
  it('changes nothing', () => {
    const library = join(temp.path, 'library');
    mkdirSync(library, { recursive: true });
    const first = fakeGit();
    bootstrapLibrary({ root: library, git: first.git });
    // Pretend git left its directory behind, which the fake cannot.
    mkdirSync(join(library, '.git'), { recursive: true });

    const before = snapshot(library);
    const second = fakeGit();
    const result = bootstrapLibrary({ root: library, git: second.git });

    expect(result.created).toEqual([]);
    expect(result.gitInitialised).toBe(false);
    expect(second.calls).toEqual([]);
    expect(snapshot(library)).toEqual(before);
  });

  it('repairs a library whose agents/ was deleted', () => {
    const library = join(temp.path, 'library');
    const { git } = fakeGit();
    bootstrapLibrary({ root: library, git });
    rmSync(join(library, 'agents'), { recursive: true, force: true });

    const result = bootstrapLibrary({ root: library, git });
    expect(result.created).toEqual([join(library, 'agents')]);
  });
});

describe('when git cannot run', () => {
  it('warns and leaves a perfectly usable library', () => {
    const library = join(temp.path, 'library');
    const { git } = fakeGit({ init: { ok: false } });
    const result = bootstrapLibrary({ root: library, git });

    expect(result.gitInitialised).toBe(false);
    expect(result.isGitRepository).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.level).toBe('warn');
    expect(result.diagnostics[0]?.code).toBe('roster.git-unavailable');
    expect(existsSync(join(library, 'agents'))).toBe(true);
  });

  it('skips git entirely when asked to', () => {
    const library = join(temp.path, 'library');
    const { git, calls } = fakeGit();
    const result = bootstrapLibrary({ root: library, git, initGit: false });

    expect(calls).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(existsSync(join(library, 'roster.json'))).toBe(true);
  });
});

describe.runIf(hasGit())('against the real git executable', () => {
  it('leaves an initialised repository with zero commits', () => {
    const library = join(temp.path, 'library');
    mkdirSync(library, { recursive: true });
    const git = createGitCommand();

    const result = bootstrapLibrary({ root: library, git });

    expect(result.gitInitialised).toBe(true);
    expect(result.isGitRepository).toBe(true);
    expect(libraryCommitCount(library, git)).toBe(0);
    // `git status` sees the two bootstrap files as untracked, which is the
    // owner's decision to make, not the service's.
    const status = git(['-C', library, 'status', '--porcelain']);
    expect(status.stdout).toContain('roster.json');
  });

  it('works when the library path contains a space', () => {
    const spaced = makeSpacedTempDir('agentmanager roster git ');
    try {
      const library = join(spaced.path, 'the library');
      mkdirSync(library, { recursive: true });
      const git = createGitCommand();

      const result = bootstrapLibrary({ root: library, git });
      expect(result.gitInitialised).toBe(true);
      expect(existsSync(join(library, '.git'))).toBe(true);
      expect(libraryCommitCount(library, git)).toBe(0);
    } finally {
      spaced.cleanup();
    }
  });
});

/** Names and byte lengths of everything in the library, for "changed nothing". */
function snapshot(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    out[path] = entry.isFile() ? statSync(path).size : -1;
  }
  return out;
}
