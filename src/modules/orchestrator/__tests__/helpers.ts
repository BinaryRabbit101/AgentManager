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
import { Secret, type SecretResolver } from '../../../secrets/index.js';
import { openStorage, type Storage } from '../../../storage/index.js';
import { createEventBus } from '../../bus.js';
import type { AppEvent, EventBus } from '../../types.js';
import {
  applyBudgetCardPolicy,
  createBudgetPolicy,
  BUDGET_RAISE_GATE,
  type BudgetPolicy,
} from '../budgets.js';
import { raiseCard, GATE_OPTIONS } from '../cards.js';
import { ORCHESTRATOR_CONFIG_DEFAULTS, type OrchestratorConfig } from '../config.js';
import { createConversationReader, type ConversationView } from '../conversation.js';
import { createPatternEngine, type PatternEngine } from '../engine.js';
import { createMailboxRepository, type MailboxRepository } from '../messages.js';
import { createNotifier, type Notifier, type NotifyTimers } from '../notify.js';
import { createFleetStatusReader, type FleetStatus } from '../status.js';
import { createWidgetFeedReader, type WidgetFeed } from '../widget.js';
import type {
  GateLiableToolPort,
  IntegrationStatePort,
  ProjectsPort,
  ResolvedAgentPort,
  RosterPort,
  RunnerPort,
  StartSessionRequest,
  TaskTemplatePort,
} from '../ports.js';
import { createQuestionInbox, type QuestionInbox } from '../questions.js';
import { createAssignmentRepository, type AssignmentRepository } from '../repository.js';
import { createAssignmentService, type AssignmentServiceOptions } from '../service.js';
import { createToolsetFactory, type ToolsetFactory } from '../toolset.js';
import { createTriggerRepository, type TriggerRepository } from '../triggers.js';
import { createTriggerService, type TriggerService } from '../triggerScheduler.js';
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
  /** Roster §11's projection fields, for `list_roster`'s filters. */
  readonly specialty?: string;
  readonly tagline?: string;
  readonly tags?: readonly string[];
}

/**
 * The WO4/WO5/WO6 projections §2.8's preflight reads, as a test can state them.
 *
 * Everything defaults to green, because "green" is the case every suite that is
 * not about preflight wants and stating it in each of them would be noise.
 */
export interface FakePreflight {
  /** The templates `getTemplate` answers with, by id. Absent ids throw, as roster does. */
  readonly templates?: readonly TaskTemplatePort[];
  /** WO4's dry-run, per agent id; the default is "no tool would ask". */
  readonly gateLiable?: Readonly<Record<string, readonly GateLiableToolPort[]>>;
  /** WO6's projection, per agent id; the default is "nothing declared, nothing missing". */
  readonly integrations?: Readonly<Record<string, readonly IntegrationStatePort[]>>;
}

/** A task template, with §2.8's fields defaulted to the shape a solo trigger uses. */
export function aTemplate(overrides: Partial<TaskTemplatePort> = {}): TaskTemplatePort {
  return {
    id: 'todo-ticket-replies',
    name: 'Reply to todo tickets',
    pattern: 'solo',
    goalTemplate: 'If the source has no open items, report done immediately.\n\nWork {{source}}.',
    ...overrides,
  };
}

/** A roster whose registry answers from a table. */
export function fakeRoster(
  agents: readonly FakeAgent[],
  preflight: FakePreflight = {},
): RosterPort {
  const resolve_ = (agent: FakeAgent): ResolvedAgentPort => ({
    definition: {
      id: agent.id,
      name: agent.name ?? agent.id,
      capabilities: { overseer: agent.overseer ?? false, roles: agent.roles ?? ['implementer'] },
    },
    archivedAt: agent.archived === true ? '2026-08-01T00:00:00.000Z' : null,
  });
  const live = agents.filter((a) => a.archived !== true);
  const liveById = new Map(live.map((a) => [a.id, resolve_(a)]));
  const archived = new Map(
    agents.filter((a) => a.archived === true).map((a) => [a.id, resolve_(a)]),
  );
  return {
    registry: {
      get: (id) => liveById.get(id),
      getArchived: (id) => archived.get(id),
    },
    // Roster §11's projection, structurally — the shape `list_roster` consumes,
    // credential-free by construction because there is nothing else to leak.
    overseerRoster: () =>
      live.map((agent) => ({
        id: agent.id,
        name: agent.name ?? agent.id,
        specialty: agent.specialty ?? 'general',
        tagline: agent.tagline ?? null,
        tags: agent.tags ?? [],
        capabilities: {
          overseer: agent.overseer ?? false,
          roles: agent.roles ?? ['implementer'],
        },
      })),
    // §2.8's three probes. Present always, because a build whose roster has them
    // is the build every trigger test is about — `hasUnattendedPreflight` is
    // exercised by omitting them explicitly, not by them being absent here.
    getTemplate: (id: string) => {
      const found = (preflight.templates ?? [aTemplate()]).find((one) => one.id === id);
      // Roster throws a typed 404 rather than answering `undefined`, and §2.8's
      // `template-missing` block depends on the throw being caught.
      if (found === undefined) throw new Error(`no template ${id}`);
      return { template: found };
    },
    validate: (agentId: string) =>
      Promise.resolve({ gateLiable: preflight.gateLiable?.[agentId] ?? [] }),
    integrations: (agentId: string) => Promise.resolve(preflight.integrations?.[agentId] ?? []),
  };
}

/** A secret store that answers from a table — foundation's `SecretResolver`. */
export function fakeSecrets(values: Record<string, string>): SecretResolver {
  return {
    get: (key) => Promise.resolve(key in values ? new Secret(values[key] ?? '') : undefined),
  };
}

/**
 * Timers a test drives by hand.
 *
 * `run()` fires everything armed so far, which is what makes §10's 60-second
 * delay, M7-5's sweep and §3.1's 30-second re-advance after a failed launch
 * testable without any of them happening.
 */
export interface FakeTimers extends NotifyTimers {
  /** Fires every armed callback, oldest first, and awaits each. */
  run(): Promise<void>;
  pending(): number;
}

export function fakeTimers(): FakeTimers {
  let next = 0;
  const armed = new Map<number, () => void | Promise<void>>();
  return {
    after(_ms, fn) {
      const id = (next += 1);
      armed.set(id, fn);
      return () => {
        armed.delete(id);
      };
    },
    async run() {
      const due = [...armed.entries()];
      armed.clear();
      for (const [, fn] of due) await fn();
    },
    pending: () => armed.size,
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
  /** §11.3's fleet view (M9). */
  readonly fleetStatus: () => FleetStatus;
  /** §11.5's glanceable projection, over the same fleet reader the module wires. */
  readonly widgetFeed: () => WidgetFeed;
  /** §7.3's policy (M3). */
  readonly budgets: BudgetPolicy;
  /** §10's channel (M8), wired to {@link Harness.timers} and a fake `fetch`. */
  readonly notifier: Notifier;
  /** §2.8's background triggers (WO8), over the same repository and bus. */
  readonly triggers: TriggerService;
  /** The trigger rows themselves, for the arrange half of a scheduler test. */
  readonly triggerRows: TriggerRepository;
  /** Every ntfy POST the notifier attempted, in order. */
  readonly posts: { url: string; body: string; headers: Record<string, string> }[];
  /** Shared by the notifier's delay and the engine's post-launch-failure retry. */
  readonly timers: FakeTimers;
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
  /** The secrets a test's notifier can resolve. Defaults to a working topic. */
  readonly secrets?: Record<string, string>;
  /** Makes every ntfy POST fail, for M8's degraded-channel acceptance. */
  readonly notifyFails?: boolean;
  /** Attaches the notifier's bus subscriptions, as `module.ts` does. */
  readonly attachNotifier?: boolean;
  /** §2.8's preflight data: templates, gate-liable tools, connector states. */
  readonly preflight?: FakePreflight;
  /** Drops §2.8's three roster probes, for the "roster too old" refusal. */
  readonly withoutPreflight?: boolean;
}

/** The topic URL the harness's fake secret store answers with. */
export const NTFY_TOPIC = 'https://ntfy.example/agentmanager-test';

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

  const fullRoster = fakeRoster(
    options.agents ?? [{ id: 'ada', roles: ['implementer'] }],
    options.preflight ?? {},
  );
  const roster: RosterPort =
    options.withoutPreflight === true
      ? {
          registry: fullRoster.registry,
          ...(fullRoster.overseerRoster === undefined
            ? {}
            : { overseerRoster: fullRoster.overseerRoster }),
        }
      : fullRoster;
  const built: { inbox?: QuestionInbox; toolset?: ToolsetFactory; engine?: PatternEngine } = {};
  const serviceOptions: AssignmentServiceOptions = {
    repository,
    sessions: storage.store.sessions,
    questions: storage.store.questions,
    bus,
    config,
    moduleEnabled: options.moduleEnabled ?? true,
    clock,
    expireHours: options.expireHours ?? 24,
    roster: () => roster,
    projects: () => projects,
    runner: () => runner,
    inbox: () => built.inbox,
    toolset: () => built.toolset,
    // The read model sums the denial total off these rows (WO4 addendum §5).
    turns,
  };
  const service = createAssignmentService(serviceOptions);

  const gates: { assignmentId: string; tokens: number }[] = [];
  const budgets = createBudgetPolicy({
    repository,
    service: () => service,
    bus,
    config,
    raiseGate: (row, requested) => {
      gates.push({ assignmentId: row.id, tokens: requested });
      void raiseCard({ inbox: built.inbox, clock, expireHours: options.expireHours ?? 24 }, row, {
        kind: 'approval_gate',
        prompt: `Raise this assignment's budget to ${String(requested)} tokens?`,
        options: GATE_OPTIONS,
        marker: BUDGET_RAISE_GATE,
        toolInput: { assignmentId: row.id, tokens: requested },
      });
      return '';
    },
  });

  // Built after the service, exactly as `module.ts` builds it, because §6.5's
  // expiry consequences call back into `closeAssignment`.
  const inbox = createQuestionInbox({
    questions: storage.store.questions,
    assignments: repository,
    bus,
    clock,
    joinWindowMs: config.questions.joinWindowMs,
    expireHours: options.expireHours ?? 24,
    cardPolicy: applyBudgetCardPolicy,
    onAnswered: (card) => {
      budgets.onAnswered(card);
    },
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
    service: () => service,
    roster: () => roster,
    onCapExceeded: (launch) => {
      void built.engine?.tripToolFlood(launch.assignmentId, launch.sessionId);
    },
    // Short by default: §4.4's hold is 15 minutes in production, and a test that
    // waited for it would be a test nobody runs.
    holdMs: options.holdMs ?? 5,
    expireHours: options.expireHours ?? 24,
  });
  built.toolset = toolset;

  // Armed before the engine as well as the notifier: §3.1's post-launch-failure
  // re-advance is a timer, and a test that had to wait 30 seconds for it is a
  // test nobody runs.
  const timers = fakeTimers();
  const engine = createPatternEngine({
    repository,
    turns,
    mailbox,
    sessions: storage.store.sessions,
    service: () => service,
    inbox: () => built.inbox,
    runner: () => runner,
    projects: () => projects,
    roster: () => roster,
    bus,
    clock,
    config,
    expireHours: options.expireHours ?? 24,
    timers,
  });
  built.engine = engine;
  const detach = options.attachEngine === false ? () => {} : engine.attach();

  const conversation = createConversationReader({
    repository,
    turns,
    mailbox,
    inbox: () => built.inbox,
    config,
  });

  const fleetStatus = createFleetStatusReader({
    repository,
    turns,
    sessions: storage.store.sessions,
    inbox: () => built.inbox,
    roster: () => roster,
  });

  const widgetFeed = createWidgetFeedReader({
    fleetStatus,
    inbox: () => built.inbox,
    sessions: storage.store.sessions,
    members: (assignmentId) => repository.listMembers(assignmentId),
    roster: () => roster,
    clock,
    config: config.widget,
  });

  const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
  const notifier = createNotifier({
    config,
    inbox: () => built.inbox,
    secrets: fakeSecrets(options.secrets ?? { 'notify.ntfy.topicUrl': NTFY_TOPIC }),
    bus,
    clock,
    baseUrl: () => 'https://box.tailnet.ts.net',
    timers,
    fetch: (input, init) => {
      const body = init?.body;
      posts.push({
        url: input instanceof URL ? input.href : typeof input === 'string' ? input : input.url,
        body: typeof body === 'string' ? body : '',
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return Promise.resolve(
        new Response(null, { status: options.notifyFails === true ? 502 : 200 }),
      );
    },
  });
  const detachNotifier = options.attachNotifier === false ? () => {} : notifier.attach();

  // §2.8, wired exactly as `module.ts` wires it — same repository, same bus,
  // same clock, same notifier.
  const triggerRows = createTriggerRepository({ db: storage.db, clock });
  const triggers = createTriggerService({
    triggers: triggerRows,
    assignments: repository,
    service: () => service,
    bus,
    clock,
    config,
    roster: () => roster,
    projects: () => projects,
    notifier: () => notifier,
  });
  const detachTriggers = triggers.attach();

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
    fleetStatus,
    widgetFeed,
    budgets,
    notifier,
    triggers,
    triggerRows,
    posts,
    timers,
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
      detachNotifier();
      detachTriggers();
      storage.close();
      dir.cleanup();
    },
  };
}
