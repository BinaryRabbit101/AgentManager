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
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findInstallRoot } from '../../../config/index.js';
import { openStorage, type EventsRepository, type Storage } from '../../../storage/index.js';
import { createEventBus } from '../../bus.js';
import type { AppEvent, EventBus } from '../../types.js';
import { createProjectsService, type ProjectsService } from '../service.js';
import { createProjectRepository, type ProjectRepository } from '../repository.js';
import { createGitRunner, type GitResult, type GitRunner } from '../git.js';
import { createWorkspaceLeaseRepository, type WorkspaceLeaseRepository } from '../leases.js';
import { createKeyedMutex } from '../mutex.js';
import { createWorkspaceService, type WorkspaceService } from '../workspaces.js';
import type { CommandResult, CommandRunner } from '../worktree.js';
import { BUILT_IN_RETENTION_DEFAULTS, type RetentionDefaults } from '../types.js';
import { createCloneService, type CloneService, type GitCloneRunner } from '../clone.js';
import { createWorkItemRepository, type WorkItemRepository } from '../workItems.js';

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
  readonly leases: WorkspaceLeaseRepository;
  readonly workspaces: WorkspaceService;
  readonly workItems: WorkItemRepository;
  readonly clone: CloneService;
  readonly service: ProjectsService;
  readonly bus: EventBus;
  readonly events: AppEvent[];
  readonly dataRoot: string;
  readonly worktreesRoot: string;
  readonly projectsRoot: string;
}

/**
 * A clone runner that answers from a script instead of running git.
 *
 * The M3 tests that need a *real* clone use a real bare repository behind a
 * `file://` URL and the real runner; this one exists for the failure paths —
 * an authentication rejection cannot be provoked from a local fixture, and
 * inventing a credential prompt to fail would be a test of the invention.
 */
export function scriptedCloneRunner(
  answer: (args: readonly string[]) => { ok: boolean; stdout?: string; stderr?: string },
  progressLines: readonly string[] = [],
): GitCloneRunner {
  return (args, onStderrLine) => {
    for (const line of progressLines) onStderrLine(line);
    const result = answer(args);
    return Promise.resolve({
      ok: result.ok,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    });
  };
}

/** A command runner that records what it was asked to run and always succeeds. */
export function recordingCommandRunner(
  answer: (command: string) => CommandResult = () => ({ ok: true, stdout: '', stderr: '' }),
): CommandRunner & {
  readonly calls: { command: string; cwd: string; env: Record<string, string> }[];
} {
  const calls: { command: string; cwd: string; env: Record<string, string> }[] = [];
  const runner = (
    command: string,
    cwd: string,
    env: Readonly<Record<string, string>>,
  ): Promise<CommandResult> => {
    calls.push({ command, cwd, env: { ...env } });
    return Promise.resolve(answer(command));
  };
  return Object.assign(runner, { calls });
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
  /** Defaults to `<dataRoot>\worktrees`, which is where foundation puts it. */
  readonly worktreesRoot?: string;
  readonly runCommand?: CommandRunner;
  readonly longPaths?: () => boolean | undefined;
  readonly allowPermissionElevation?: boolean;
  /** §1.2's lazy drop; absent means "the roster knows every id". */
  readonly knownAgent?: (agentId: string) => boolean;
  readonly readInstructions?: (absolutePath: string) => string | undefined;
  /** Receives what the module would log — the one-time long-path warning included. */
  readonly onLog?: (level: 'info' | 'warn', message: string) => void;
  /** §2.2's clone job. Defaults to a runner that refuses, so nothing hits a network. */
  readonly cloneRunner?: GitCloneRunner;
  /** `<dataRoot>-projects` unless a test wants somewhere specific. */
  readonly projectsRoot?: string;
  readonly retentionDefaults?: RetentionDefaults;
  /** Frozen by default, so timestamps are assertable; a retention test moves it. */
  readonly clock?: () => Date;
}): TestHarness {
  const storage = openTestStorage(options.dataRoot);
  const clock = options.clock ?? ((): Date => new Date('2026-08-16T10:00:00.000Z'));
  const retentionDefaults = options.retentionDefaults ?? BUILT_IN_RETENTION_DEFAULTS;
  const repository = createProjectRepository({
    db: storage.db,
    projects: storage.store.projects,
    retentionDefaults,
    clock,
    ...(options.knownAgent === undefined ? {} : { knownAgent: options.knownAgent }),
  });
  const { bus, emitted } = recordingBus(storage.store.events);
  const git = options.git ?? createGitRunner();
  const worktreesRoot = options.worktreesRoot ?? storage.paths.worktrees;
  const leases = createWorkspaceLeaseRepository(storage.db, clock);
  const workspaces = createWorkspaceService({
    projects: repository,
    leases,
    mutex: createKeyedMutex(),
    bus,
    clock,
    worktreesRoot,
    git,
    runCommand: options.runCommand ?? recordingCommandRunner(),
    // Tests never ask the real registry: the answer would differ per machine.
    longPaths: options.longPaths ?? ((): boolean | undefined => true),
    // Backoff is real behaviour, but a test must not spend seconds proving it.
    removeDirectory: { attempts: 3, initialDelayMs: 1 },
    ...(options.onLog === undefined
      ? {}
      : {
          log: (level: 'info' | 'warn', message: string): void => {
            options.onLog?.(level, message);
          },
        }),
  });
  const workItems = createWorkItemRepository(storage.db, clock);
  const projectsRoot = options.projectsRoot ?? resolve(options.dataRoot, '..', 'projects-root');
  const clone = createCloneService({
    repository,
    bus,
    projectsRoot,
    dataRoot: options.dataRoot,
    registered: () =>
      repository.list({ includeArchived: true }).map((project) => ({
        id: project.id,
        name: project.name,
        localPath: project.localPath,
        localPathKey: project.localPathKey,
      })),
    git,
    clone:
      options.cloneRunner ??
      scriptedCloneRunner(() => ({ ok: false, stderr: 'fake clone: no runner was configured' })),
    removeDirectory: { attempts: 3, initialDelayMs: 1 },
  });

  const service = createProjectsService({
    repository,
    workspaces,
    workItems,
    clone,
    bus,
    dataRoot: options.dataRoot,
    sessions: storage.store.sessions,
    assignments: storage.store.assignments,
    usage: storage.store.usage,
    transcripts: storage.store.transcripts,
    retentionDefaults,
    git,
    clock,
    ...(options.allowPermissionElevation === undefined
      ? {}
      : { allowPermissionElevation: options.allowPermissionElevation }),
    ...(options.probeWritable === undefined ? {} : { probeWritable: options.probeWritable }),
    ...(options.readInstructions === undefined
      ? {}
      : { readInstructions: options.readInstructions }),
  });
  return {
    storage,
    repository,
    leases,
    workspaces,
    workItems,
    clone,
    service,
    bus,
    events: emitted,
    dataRoot: options.dataRoot,
    worktreesRoot,
    projectsRoot,
  };
}

/** A real `git` runner, for the M6 tests that need an actual repository. */
export function realGit(): GitRunner {
  return createGitRunner();
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

/**
 * Runs `act` and returns the {@link ProjectsError} it threw.
 *
 * `expect(fn).toThrowError(expect.objectContaining({ code }))` reads better but
 * types the matcher as `any`, which the lint rules refuse. Catching the refusal
 * and asserting on its `code` is the same assertion with a name on it.
 */
export function refusalFrom(act: () => unknown): { code?: string; message?: string } {
  try {
    act();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('expected the call to be refused, but it returned');
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

/**
 * A bare clone of `source`, to serve as a **local** clone origin (M3).
 *
 * M3's acceptance says "cloning a small public repo", and a test that reaches
 * github.com is a test of the network. A bare repository behind a `file://` URL
 * exercises the same code path — git's transport, `--progress` on stderr, a real
 * working checkout at the end — without one.
 */
export function makeBareRepo(source: string, target: string): string {
  execFileSync('git', ['clone', '--bare', source, target], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return target;
}

/** `C:\Temp\fixture.git` → `file:///C:/Temp/fixture.git`. */
export function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}
