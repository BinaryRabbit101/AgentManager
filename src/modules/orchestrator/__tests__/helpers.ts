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
import { createConversationReader, type ConversationView } from '../conversation.js';
import { createPatternEngine, type PatternEngine } from '../engine.js';
import { createMailboxRepository, type MailboxRepository } from '../messages.js';
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
import { createToolsetFactory, type ToolsetFactory } from '../toolset.js';
import { createTurnRepository, type TurnRepository } from '../turns.js';
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
  /** Every `continueFrom` call, for the M5 criterion about a seat's second turn. */
  readonly continued: { previousSessionId: string; prompt: string; sessionId: string }[];
}

/**
 * A runner that records what it was asked to do.
 *
 * `launchable: false` produces the shape a build *before* runner M3 has: a
 * `RunnerService` with neither `startSession` nor `stop`, which is what
 * `hasLauncher` probes for. `continuable: true` produces the shape runner M9
 * *will* have — `continueFrom` on the service — which this build does not yet
 * ship (see `ports.ts`), so both sides of that probe are exercisable.
 */
export function fakeRunner(
  options: {
    readonly launchable?: boolean;
    readonly continuable?: boolean;
    readonly onStart?: (request: StartSessionRequest) => { sessionId: string };
  } = {},
): FakeRunner {
  const started: StartSessionRequest[] = [];
  const stopped: { sessionId: string; reason: string }[] = [];
  const continued: { previousSessionId: string; prompt: string; sessionId: string }[] = [];
  if (options.launchable === false) return { started, stopped, continued };
  let counter = 0;
  return {
    started,
    stopped,
    continued,
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
    ...(options.continuable === true
      ? {
          continueFrom: (previousSessionId: string, prompt: string) => {
            counter += 1;
            const sessionId = `session-${String(counter)}`;
            continued.push({ previousSessionId, prompt, sessionId });
            return Promise.resolve({ sessionId });
          },
        }
      : {}),
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
  /** M5's `assignment_turns` repository. */
  readonly turns: TurnRepository;
  /** M5/M6's mailbox. */
  readonly mailbox: MailboxRepository;
  /** M5's pattern engine, wired to the same bus, runner and inbox as the module. */
  readonly engine: PatternEngine;
  /** §4.1's per-launch toolset factory. */
  readonly toolset: ToolsetFactory;
  readonly conversation: (assignmentId: string) => ConversationView;
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
  readonly continuable?: boolean;
  readonly moduleEnabled?: boolean;
  readonly config?: Partial<OrchestratorConfig>;
  readonly runner?: FakeRunner;
  /** `runner.question.expireHours` — read from runner's config, never copied (§12). */
  readonly expireHours?: number;
  /** `runner.question.holdMs`, likewise. Short by default so a test never waits. */
  readonly holdMs?: number;
  /** The workspace the artifact hash of §3.3 is read from, when a test uses one. */
  readonly workspaceCwd?: string;
  /** Attaches the engine's bus subscriptions, exactly as `module.ts` does. */
  readonly attachEngine?: boolean;
}

export const PROJECT_ID = 'proj-1';

/**
 * Lets every queued microtask and timer-0 callback run.
 *
 * The engine's loop is event-driven and its handlers are `void`-ed promises
 * (`engine.ts`), which is the correct shape for a bus subscriber and an awkward
 * one for a test. Rather than reaching inside the engine for a promise it does
 * not hand out, a test emits the event and then drains the queue — which is what
 * the process itself does between two ticks.
 */
export async function flush(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Emits the `session.ended` runner would emit, and waits for the engine to have
 * finished reacting.
 */
export async function endSession(
  harness: Harness,
  sessionId: string,
  payload: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  harness.bus.emit({
    type: 'session.ended',
    ids: { sessionId },
    persist: false,
    payload: { status: 'done', exitReason: 'completed', ...payload },
  });
  await flush();
}

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

  const turns = createTurnRepository({ db: storage.db, clock });
  const mailbox = createMailboxRepository({
    db: storage.db,
    messages: storage.store.messages,
    clock,
  });

  const baseProjects = fakeProjects({
    projects: new Map([
      [PROJECT_ID, { id: PROJECT_ID, status: options.projectStatus ?? 'active' }],
    ]),
    ...(options.workItems === undefined ? {} : { workItems: options.workItems }),
  });
  const cwd = options.workspaceCwd;
  const projects: FakeProjects =
    cwd === undefined
      ? baseProjects
      : { ...baseProjects, getEffectiveLaunchContext: () => Promise.resolve({ cwd }) };
  const runner =
    options.runner ??
    fakeRunner({
      launchable: options.launchable ?? true,
      ...(options.continuable === undefined ? {} : { continuable: options.continuable }),
    });

  const config: OrchestratorConfig = { ...ORCHESTRATOR_CONFIG_DEFAULTS, ...options.config };

  const built: { inbox?: QuestionInbox; toolset?: ToolsetFactory } = {};
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
    toolset: () => built.toolset,
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

  const toolset = createToolsetFactory({
    assignments: repository,
    turns,
    mailbox,
    bus,
    clock,
    config,
    inbox: () => built.inbox,
    // Short by default: §4.4's hold is 15 minutes in production, and a test that
    // waited for it would be a test nobody runs.
    holdMs: options.holdMs ?? 5,
    expireHours: options.expireHours ?? 24,
  });
  built.toolset = toolset;

  const engine = createPatternEngine({
    repository,
    turns,
    mailbox,
    sessions: storage.store.sessions,
    service: () => service,
    inbox: () => built.inbox,
    runner: () => runner,
    projects: () => projects,
    bus,
    clock,
    config,
    expireHours: options.expireHours ?? 24,
  });
  const detach = options.attachEngine === false ? () => {} : engine.attach();

  const conversation = createConversationReader({
    repository,
    turns,
    mailbox,
    inbox: () => built.inbox,
    config,
  });

  return {
    storage,
    repository,
    service,
    inbox,
    turns,
    mailbox,
    engine,
    toolset,
    conversation,
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
      detach();
      storage.close();
      dir.cleanup();
    },
  };
}
