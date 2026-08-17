/**
 * Test helpers for the orchestrator element.
 *
 * Every directory these create lives under the OS temp dir — never the
 * developer's real data root and never inside the repository (foundation §1.2).
 *
 * The three ports of `ports.ts` are supplied here as plain objects rather than
 * by booting roster, projects and runner. That is not a shortcut: `ports.ts`
 * declares the *narrowest* shapes orchestrator consumes precisely so a test can
 * state the facts a rule depends on directly, and so this suite still runs
 * against a build where runner's `startSession` has not landed yet.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findInstallRoot } from '../../../config/index.js';
import { openStorage, type Storage } from '../../../storage/index.js';
import { createEventBus } from '../../bus.js';
import type { AppEvent, EventBus } from '../../types.js';
import { ORCHESTRATOR_CONFIG_DEFAULTS, type OrchestratorConfig } from '../config.js';
import type {
  ProjectsPort,
  ResolvedAgentPort,
  RosterPort,
  RunnerPort,
  StartSessionRequest,
} from '../ports.js';
import { createQuestionInbox, type QuestionInbox } from '../questions.js';
import { createAssignmentRepository, type AssignmentRepository } from '../repository.js';
import { createAssignmentService, type AssignmentServiceOptions } from '../service.js';
import type { AssignmentRole, AssignmentService } from '../types.js';

/** The repository root, which also holds the shipped `migrations/` tree. */
export const repoRoot = findInstallRoot(dirname(fileURLToPath(import.meta.url)));
export const migrationsDir = resolve(repoRoot, 'migrations');
/** This element's set, exactly as `moduleMigrationsFor` would compute it. */
export const orchestratorMigrationsDir = resolve(migrationsDir, 'orchestrator');

export interface TempDir {
  readonly path: string;
  cleanup(): void;
}

export function makeTempDir(prefix = 'agentmanager-orchestrator-'): TempDir {
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
    moduleMigrations: [{ moduleId: 'orchestrator', dir: orchestratorMigrationsDir }],
    tightenAcl: false,
  });
}

// ---------------------------------------------------------------------------
// Port fakes
// ---------------------------------------------------------------------------

export interface FakeAgent {
  readonly id: string;
  readonly name?: string;
  readonly roles?: readonly AssignmentRole[];
  readonly overseer?: boolean;
  readonly archived?: boolean;
}

/** A roster whose registry answers from a table. */
export function fakeRoster(agents: readonly FakeAgent[]): RosterPort {
  const resolve_ = (agent: FakeAgent): ResolvedAgentPort => ({
    definition: {
      id: agent.id,
      name: agent.name ?? agent.id,
      capabilities: { overseer: agent.overseer ?? false, roles: agent.roles ?? ['implementer'] },
    },
    archivedAt: agent.archived === true ? '2026-08-01T00:00:00.000Z' : null,
  });
  const live = new Map(agents.filter((a) => a.archived !== true).map((a) => [a.id, resolve_(a)]));
  const archived = new Map(
    agents.filter((a) => a.archived === true).map((a) => [a.id, resolve_(a)]),
  );
  return {
    registry: {
      get: (id) => live.get(id),
      getArchived: (id) => archived.get(id),
    },
  };
}

export interface FakeProjectsOptions {
  /** Mutable, so a test can archive a project the way projects would. */
  readonly projects: Map<string, { id: string; status: string }>;
  /** Omit to simulate a build before projects M8 (R4). */
  readonly workItems?: ReadonlyMap<string, { id: string; projectId: string }>;
}

export interface FakeProjects extends ProjectsPort {
  readonly linked: Map<string, readonly string[]>;
  readonly unlinked: string[];
  /** Stands in for projects archiving a project while the core was down. */
  setStatus(projectId: string, status: string): void;
  /** Stands in for projects being unable to answer about a project at all. */
  forget(projectId: string): void;
}

export function fakeProjects(options: FakeProjectsOptions): FakeProjects {
  const linked = new Map<string, readonly string[]>();
  const unlinked: string[] = [];
  const base = {
    get: (id: string) => {
      const project = options.projects.get(id);
      if (project === undefined) throw new Error(`no project ${id}`);
      return project;
    },
    linked,
    unlinked,
    setStatus: (projectId: string, status: string) => {
      options.projects.set(projectId, { id: projectId, status });
    },
    forget: (projectId: string) => {
      options.projects.delete(projectId);
    },
  };
  if (options.workItems === undefined) return base;
  return {
    ...base,
    linkWorkItems: (assignmentId: string, ids: readonly string[]) => {
      linked.set(assignmentId, ids);
    },
    unlinkWorkItems: (assignmentId: string) => {
      unlinked.push(assignmentId);
    },
    getWorkItem: (id: string) => options.workItems?.get(id),
  };
}

export interface FakeRunner extends RunnerPort {
  readonly started: StartSessionRequest[];
  readonly stopped: { sessionId: string; reason: string }[];
}

/**
 * A runner that records what it was asked to do.
 *
 * `launchable: false` produces the shape a build *before* runner M3 has: a
 * `RunnerService` with neither `startSession` nor `stop`, which is what
 * `hasLauncher` probes for.
 */
export function fakeRunner(
  options: {
    readonly launchable?: boolean;
    readonly onStart?: (request: StartSessionRequest) => { sessionId: string };
  } = {},
): FakeRunner {
  const started: StartSessionRequest[] = [];
  const stopped: { sessionId: string; reason: string }[] = [];
  if (options.launchable === false) return { started, stopped };
  let counter = 0;
  return {
    started,
    stopped,
    startSession: (request) => {
      started.push(request);
      counter += 1;
      return Promise.resolve(
        options.onStart?.(request) ?? { sessionId: `session-${String(counter)}` },
      );
    },
    stop: (sessionId, reason) => {
      stopped.push({ sessionId, reason });
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// A wired service over real storage
// ---------------------------------------------------------------------------

export interface Harness {
  readonly storage: Storage;
  readonly repository: AssignmentRepository;
  readonly service: AssignmentService;
  /** M2's inbox and `QuestionBridge`, wired to the same service and bus. */
  readonly inbox: QuestionInbox;
  readonly bus: EventBus;
  readonly events: AppEvent[];
  readonly runner: FakeRunner;
  readonly projects: FakeProjects;
  readonly config: OrchestratorConfig;
  /** The clock the harness reads; advanceable for the join window and expiry. */
  now(): Date;
  advance(ms: number): void;
  cleanup(): void;
}

export interface HarnessOptions {
  readonly agents?: readonly FakeAgent[];
  readonly projectStatus?: string;
  readonly workItems?: ReadonlyMap<string, { id: string; projectId: string }>;
  readonly launchable?: boolean;
  readonly moduleEnabled?: boolean;
  readonly config?: Partial<OrchestratorConfig>;
  readonly runner?: FakeRunner;
  /** `runner.question.expireHours` — read from runner's config, never copied (§12). */
  readonly expireHours?: number;
}

export const PROJECT_ID = 'proj-1';

export function makeHarness(options: HarnessOptions = {}): Harness {
  const dir = makeTempDir();
  const storage = openTestStorage(dir.path);
  const events: AppEvent[] = [];
  const bus = createEventBus({ events: storage.store.events });
  bus.subscribe((event) => void events.push(event));

  storage.store.projects.create({
    id: PROJECT_ID,
    slug: 'proj',
    name: 'Proj',
    status: options.projectStatus ?? 'active',
  });

  // An advanceable clock: §6.3's join window and §6.5's expiry are both
  // statements about elapsed time, and a test that slept for them would be a
  // test nobody runs.
  let now = new Date('2026-08-16T10:00:00.000Z');
  const clock = (): Date => now;

  const repository = createAssignmentRepository({
    db: storage.db,
    assignments: storage.store.assignments,
    clock,
  });

  const projects = fakeProjects({
    projects: new Map([
      [PROJECT_ID, { id: PROJECT_ID, status: options.projectStatus ?? 'active' }],
    ]),
    ...(options.workItems === undefined ? {} : { workItems: options.workItems }),
  });
  const runner = options.runner ?? fakeRunner({ launchable: options.launchable ?? true });

  const config: OrchestratorConfig = { ...ORCHESTRATOR_CONFIG_DEFAULTS, ...options.config };

  const built: { inbox?: QuestionInbox } = {};
  const serviceOptions: AssignmentServiceOptions = {
    repository,
    sessions: storage.store.sessions,
    questions: storage.store.questions,
    bus,
    config,
    moduleEnabled: options.moduleEnabled ?? true,
    clock,
    roster: () => fakeRoster(options.agents ?? [{ id: 'ada', roles: ['implementer'] }]),
    projects: () => projects,
    runner: () => runner,
    inbox: () => built.inbox,
  };
  const service = createAssignmentService(serviceOptions);

  // Built after the service, exactly as `module.ts` builds it, because §6.5's
  // expiry consequences call back into `closeAssignment`.
  const inbox = createQuestionInbox({
    questions: storage.store.questions,
    assignments: repository,
    bus,
    clock,
    joinWindowMs: config.questions.joinWindowMs,
    expireHours: options.expireHours ?? 24,
    onExpiredGate: (assignmentId, reason) => {
      void service.closeAssignment(assignmentId, reason);
    },
    onExpiredBudget: (assignmentId) => {
      void service.closeAssignment(assignmentId, 'budget_exhausted');
    },
  });
  built.inbox = inbox;

  return {
    storage,
    repository,
    service,
    inbox,
    bus,
    events,
    runner,
    projects,
    config,
    now: () => now,
    advance: (ms) => {
      now = new Date(now.getTime() + ms);
    },
    cleanup: () => {
      storage.close();
      dir.cleanup();
    },
  };
}
