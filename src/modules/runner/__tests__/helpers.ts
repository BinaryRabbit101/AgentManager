/**
 * Test helpers for the runner element.
 *
 * Every directory these create lives under the OS temp dir — never the
 * developer's real data root and never inside the repository (foundation §1.2).
 *
 * Two things every runner test needs and neither foundation nor projects
 * provides:
 *
 * - **A real assignment.** `sessions.assignment_id` is `NOT NULL` with a
 *   `RESTRICT` foreign key, so there is no such thing as a session without one,
 *   and a fixture that faked it would prove nothing about the real insert.
 *   {@link seed} creates the project and the assignment through foundation's own
 *   repositories, which is also the only path runner is allowed to use for them.
 * - **Storage with *both* migration sets**, in the order the module graph puts
 *   them: foundation's numbered set, then `migrations/runner/`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findInstallRoot } from '../../../config/index.js';
import { openStorage, type Storage } from '../../../storage/index.js';
import { RUNNER_CONFIG_DEFAULTS, type RunnerConfig } from '../config.js';
import { createSessionRepository, type SessionRepository } from '../repository.js';
import { createRunnerService, type RunnerService } from '../service.js';
import { createTranscriptFactory, type TranscriptFactory } from '../transcript.js';
import {
  createTranscriptReader,
  nodeFileIo,
  type FileIo,
  type TranscriptReader,
} from '../transcriptReader.js';

/** The repository root, which also holds the shipped `migrations/` tree. */
export const repoRoot = findInstallRoot(dirname(fileURLToPath(import.meta.url)));

export const migrationsDir = resolve(repoRoot, 'migrations');

/** This element's set, exactly as `moduleMigrationsFor` would compute it. */
export const runnerMigrationsDir = resolve(migrationsDir, 'runner');

export interface TempDir {
  readonly path: string;
  cleanup(): void;
}

export function makeTempDir(prefix = 'agentmanager-runner-'): TempDir {
  const path = mkdtempSync(resolve(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true, maxRetries: 5 }) };
}

/** Real storage with foundation's set and runner's, in module-graph order. */
export function openTestStorage(dataRoot: string): Storage {
  return openStorage({
    dataRoot,
    migrationsDir,
    moduleMigrations: [{ moduleId: 'runner', dir: runnerMigrationsDir }],
    tightenAcl: false,
  });
}

/** A fixed instant, so nothing under test is time-dependent (foundation §6.1). */
export const FIXED_NOW = new Date('2026-08-16T10:00:00.000Z');

/** Counts what the transcript reader asks of the filesystem. */
export interface CountingIo extends FileIo {
  readonly stats: { reads: number; opens: number; bytes: number };
}

export function countingIo(inner: FileIo = nodeFileIo): CountingIo {
  const stats = { reads: 0, opens: 0, bytes: 0 };
  return {
    stats,
    open(path) {
      stats.opens += 1;
      return inner.open(path);
    },
    read(fd, buffer, length, position) {
      stats.reads += 1;
      const read = inner.read(fd, buffer, length, position);
      stats.bytes += read;
      return read;
    },
    close: (fd) => inner.close(fd),
    size: (path) => inner.size(path),
  };
}

export interface RunnerHarness {
  readonly storage: Storage;
  readonly sessions: SessionRepository;
  readonly transcripts: TranscriptFactory;
  readonly reader: TranscriptReader;
  readonly service: RunnerService;
  readonly config: RunnerConfig;
  /** Creates a project and an open assignment, returning both ids. */
  seed(options?: { agentId?: string }): {
    projectId: string;
    assignmentId: string;
    agentId: string;
  };
  close(): void;
}

export interface HarnessOptions {
  readonly dataRoot: string;
  readonly config?: Partial<RunnerConfig>;
  readonly io?: FileIo;
  readonly now?: () => Date;
}

/** Storage plus the four pieces the module wires, wired the same way. */
export function makeHarness(options: HarnessOptions): RunnerHarness {
  const storage = openTestStorage(options.dataRoot);
  const clock = options.now ?? ((): Date => FIXED_NOW);
  const config: RunnerConfig = {
    ...RUNNER_CONFIG_DEFAULTS,
    ...options.config,
    transcript: { ...RUNNER_CONFIG_DEFAULTS.transcript, ...options.config?.transcript },
  };

  const sessions = createSessionRepository({ db: storage.db, store: storage.store, clock });
  const transcripts = createTranscriptFactory({
    transcripts: storage.store.transcripts,
    sessions: storage.store.sessions,
    clock,
  });
  const reader = createTranscriptReader({
    transcripts: storage.store.transcripts,
    sessions: storage.store.sessions,
    maxTailBytes: config.transcript.maxTailBytes,
    ...(options.io === undefined ? {} : { io: options.io }),
  });
  const service = createRunnerService({ sessions, transcripts: reader });

  let seeded = 0;
  return {
    storage,
    sessions,
    transcripts,
    reader,
    service,
    config,
    seed(seedOptions = {}) {
      seeded += 1;
      const project = storage.store.projects.create({
        slug: `fixture-${String(seeded)}`,
        name: `Fixture ${String(seeded)}`,
        localPath: resolve(options.dataRoot, '..', `fixture-${String(seeded)}`),
      });
      const agentId = seedOptions.agentId ?? `agent-${String(seeded)}`;
      const assignment = storage.store.assignments.create({
        projectId: project.id,
        pattern: 'solo',
        goal: 'a fixture assignment',
      });
      return { projectId: project.id, assignmentId: assignment.id, agentId };
    },
    close: () => storage.close(),
  };
}

/** The one call every session-creating test makes. */
export function enqueue(
  harness: RunnerHarness,
  seed: { projectId: string; assignmentId: string; agentId: string },
  overrides: Partial<Parameters<SessionRepository['enqueue']>[0]> = {},
): ReturnType<SessionRepository['enqueue']> {
  return harness.sessions.enqueue({
    assignmentId: seed.assignmentId,
    agentId: seed.agentId,
    projectId: seed.projectId,
    prompt: 'Explain the launch chain.',
    ...overrides,
  });
}
