/**
 * Test helpers for the projects element.
 *
 * Every directory these create lives under the OS temp dir — never the
 * developer's real data root and never inside the repository (foundation §1.2).
 * The project folders under test are created as *siblings* of the temp data
 * root rather than inside it, because "inside the data root" is itself one of
 * the refusals under test (DESIGN §1.1) and a fixture that trips it would prove
 * the wrong thing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findInstallRoot } from '../../../config/index.js';
import { openStorage, type EventsRepository, type Storage } from '../../../storage/index.js';
import { createEventBus } from '../../bus.js';
import type { AppEvent, EventBus } from '../../types.js';
import { createProjectsService, type ProjectsService } from '../service.js';
import { createProjectRepository, type ProjectRepository } from '../repository.js';
import type { GitResult, GitRunner } from '../git.js';
import { BUILT_IN_RETENTION_DEFAULTS } from '../types.js';

/** The repository root, which also holds the shipped `migrations/` tree. */
export const repoRoot = findInstallRoot(dirname(fileURLToPath(import.meta.url)));

/** Foundation's numbered set. */
export const migrationsDir = resolve(repoRoot, 'migrations');

/** This element's set, exactly as `moduleMigrationsFor` would compute it. */
export const projectsMigrationsDir = resolve(migrationsDir, 'projects');

export interface TempDir {
  readonly path: string;
  cleanup(): void;
}

export function makeTempDir(prefix = 'agentmanager-projects-'): TempDir {
  const path = mkdtempSync(resolve(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true, maxRetries: 5 }) };
}

/**
 * Opens real storage against `dataRoot` with this element's migration set
 * appended — the same two sets, in the same order, the composition root builds
 * from the module graph.
 */
export function openTestStorage(dataRoot: string): Storage {
  return openStorage({
    dataRoot,
    migrationsDir,
    moduleMigrations: [{ moduleId: 'projects', dir: projectsMigrationsDir }],
    tightenAcl: false,
  });
}

/** A git runner that answers from a table, so a test needs neither git nor a repo. */
export function fakeGit(answers: Readonly<Record<string, GitResult>>): GitRunner {
  return (args) => {
    const key = args
      .filter((arg) => arg !== '-C')
      .slice(1)
      .join(' ');
    return Promise.resolve(
      answers[key] ?? { ok: false, stdout: '', stderr: `fake git: no answer for "${key}"` },
    );
  };
}

/**
 * Collects everything the bus emits, so a test can assert on `project.created`.
 *
 * Wired to the real `events` repository when one is given, so `persist: true`
 * writes the row it claims to — the difference between asserting that an event
 * was emitted and asserting that it survives a restart.
 */
export function recordingBus(events?: EventsRepository): { bus: EventBus; emitted: AppEvent[] } {
  const emitted: AppEvent[] = [];
  const bus = createEventBus({
    clock: () => new Date('2026-08-16T10:00:00.000Z'),
    ...(events === undefined ? {} : { events }),
  });
  bus.subscribe((event) => void emitted.push(event));
  return { bus, emitted };
}

export interface TestHarness {
  readonly storage: Storage;
  readonly repository: ProjectRepository;
  readonly service: ProjectsService;
  readonly events: AppEvent[];
  readonly dataRoot: string;
}

/**
 * Storage plus a repository plus a service, all wired the way the module wires
 * them — so a test that exercises the service is exercising the production path
 * with only the two filesystem seams substituted.
 */
export function makeHarness(options: {
  readonly dataRoot: string;
  readonly git?: GitRunner;
  readonly probeWritable?: (directory: string) => string | undefined;
}): TestHarness {
  const storage = openTestStorage(options.dataRoot);
  const repository = createProjectRepository({
    db: storage.db,
    projects: storage.store.projects,
    retentionDefaults: BUILT_IN_RETENTION_DEFAULTS,
    clock: () => new Date('2026-08-16T10:00:00.000Z'),
  });
  const { bus, emitted } = recordingBus(storage.store.events);
  const service = createProjectsService({
    repository,
    bus,
    dataRoot: options.dataRoot,
    ...(options.git === undefined ? {} : { git: options.git }),
    ...(options.probeWritable === undefined ? {} : { probeWritable: options.probeWritable }),
  });
  return { storage, repository, service, events: emitted, dataRoot: options.dataRoot };
}

/** Creates a directory, parents included, and returns it. */
export function makeDir(...segments: string[]): string {
  const path = resolve(...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Writes `count` files into `directory`, for the "no full tree walk" timing test. */
export function fillWithFiles(directory: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    writeFileSync(resolve(directory, `file-${String(i).padStart(5, '0')}.txt`), 'x', 'utf8');
  }
}

/** True when a real `git` executable is on PATH. */
export function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds a real git repository with one commit, an `origin` remote and a known
 * default branch.
 *
 * Identity and `commit.gpgsign` are set on the repository rather than read from
 * the developer's global config, so the fixture is the same on every machine.
 */
export function makeGitRepo(directory: string, options: { remote?: string } = {}): void {
  const run = (...args: string[]): void => {
    execFileSync('git', ['-C', directory, ...args], { stdio: 'ignore', windowsHide: true });
  };
  mkdirSync(directory, { recursive: true });
  execFileSync('git', ['-C', directory, 'init', '--initial-branch=main'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'AgentManager Test');
  run('config', 'commit.gpgsign', 'false');
  writeFileSync(resolve(directory, 'README.md'), '# fixture\n', 'utf8');
  run('add', 'README.md');
  run('commit', '-m', 'initial');
  if (options.remote !== undefined) run('remote', 'add', 'origin', options.remote);
}
