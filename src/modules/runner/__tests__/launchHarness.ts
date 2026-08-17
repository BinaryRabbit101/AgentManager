/**
 * The launch-chain harness: real storage, real repositories, real transcripts,
 * and **fake providers** for the three services runner consumes off the
 * registry (§11.3).
 *
 * The fakes are deliberate, not a shortcut. Feature modules never import each
 * other (foundation §6.1), so a runner test that reached into roster or
 * projects would be asserting something runner is not allowed to depend on;
 * what runner *does* depend on is the shape in `contracts.ts`, and that is what
 * these implement. The compiled options the fake roster returns are the shape
 * roster's own compiler produces (roster §13) — `allowedTools`, `disallowedTools`,
 * `permissionMode`, `settings`, `cwd`, `env`, `maxTurns`, `maxBudgetUsd` — so
 * §3.3's immutability assertion has something real to be immutable about.
 */
import { resolve } from 'node:path';

import type { Logger } from 'pino';

import { bytes, empty, error, json, text } from '../../../http/response.js';
import type { HttpResult, RequestContext, ResponseTools } from '../../../http/types.js';
import { Secret, type SecretResolver } from '../../../secrets/index.js';
import { createEventBus } from '../../bus.js';
import type { AppEvent, EventBus } from '../../types.js';
import { createAssignmentContextStub } from '../assignmentContext.js';
import { RUNNER_CONFIG_DEFAULTS, type RunnerConfig } from '../config.js';
import type {
  AcquireWorkspaceResultView,
  AssignmentContextProvider,
  CompileSessionRequest,
  CompiledSession,
  LaunchContextView,
  ProjectsProvider,
  QuestionBridgeProvider,
  QuestionBridgeView,
  RosterProvider,
  SdkOptions,
  WorkspaceLeaseView,
} from '../contracts.js';
import {
  createQuestionBridgeClient,
  createQuestionSessions,
  type QuestionBridgeClient,
  type QuestionSessions,
} from '../questionBridge.js';
import { createLaunchChain, type LaunchChain, type LaunchChainDeps } from '../launch.js';
import { createLeaseBook } from '../leases.js';
import { createSessionRepository, type SessionRepository } from '../repository.js';
import type { QueryFn } from '../sdk.js';
import { createRunnerRoutes } from '../routes.js';
import { createRunnerService, type RunnerService } from '../service.js';
import { createTranscriptFactory, type TranscriptFactory } from '../transcript.js';
import { createTranscriptReader } from '../transcriptReader.js';
import { createUsageRepository, type UsageRepository } from '../usage.js';
import { openTestStorage } from './helpers.js';
import { successScript, scriptedQuery } from './fakeQuery.js';
import type { Storage } from '../../../storage/index.js';

export const FIXED_NOW = new Date('2026-08-16T10:00:00.000Z');

/** The helpers the real server hands a handler, minus the `sse` no route opens. */
const responseTools: ResponseTools = {
  json,
  text,
  bytes,
  empty,
  error,
  sse: () => {
    throw new Error('no runner route opens an SSE stream before M10');
  },
};

/** What the fake roster's `compileSession` returns, before per-test overrides. */
export function fakeCompiledOptions(cwd: string): SdkOptions {
  return {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are a fixture agent.' },
    allowedTools: ['Read', 'Glob'],
    disallowedTools: ['Bash(rm *)'],
    permissionMode: 'default',
    settings: { permissions: { deny: ['Bash(rm *)'], ask: ['Write'] } },
    settingSources: ['project'],
    skills: [],
    additionalDirectories: [],
    cwd,
    model: 'claude-sonnet-4-5',
    maxTurns: 60,
    maxBudgetUsd: 2.5,
    env: { PATH: process.env['PATH'] ?? '', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
  };
}

export interface FakeRosterOptions {
  readonly diagnostics?: CompiledSession['diagnostics'];
  readonly humanMayApprove?: boolean;
  readonly compile?: (input: CompileSessionRequest, base: CompiledSession) => CompiledSession;
  readonly throws?: unknown;
  /** `false` publishes a roster service with no compiler, as an early build would. */
  readonly withCompiler?: boolean;
  readonly knownAgents?: readonly string[];
  /** roster's `defaults.concurrencyWeight` per agent, for §6.1's weighted cap. */
  readonly weights?: Readonly<Record<string, number>>;
}

export interface FakeRoster extends RosterProvider {
  readonly inputs: CompileSessionRequest[];
  /**
   * Exactly what the compiler returned, object identity included — which is
   * what §3.3's assertion needs: recompiling would produce fresh arrays and
   * make every key look changed.
   */
  readonly outputs: CompiledSession[];
}

export function fakeRoster(options: FakeRosterOptions = {}): FakeRoster {
  const inputs: CompileSessionRequest[] = [];
  const outputs: CompiledSession[] = [];
  const known = options.knownAgents;

  const provider: FakeRoster = {
    inputs,
    outputs,
    registry: {
      get: (agentId) => {
        if (known !== undefined && !known.includes(agentId)) return undefined;
        const weight = options.weights?.[agentId];
        return {
          definition: {
            id: agentId,
            name: agentId,
            ...(weight === undefined ? {} : { defaults: { concurrencyWeight: weight } }),
          },
          archivedAt: null,
        };
      },
    },
    ...(options.withCompiler === false
      ? {}
      : {
          compileSession: (input: CompileSessionRequest): Promise<CompiledSession> => {
            inputs.push(input);
            if (options.throws !== undefined) {
              // A compiler failure is whatever roster threw — Error or not.
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              return Promise.reject(options.throws);
            }
            const base: CompiledSession = {
              options: fakeCompiledOptions(input.project?.cwd ?? 'C:\\workspace'),
              effective: {
                mode: 'default',
                allow: ['Read', 'Glob'],
                deny: ['Bash(rm *)'],
                ask: ['Write'],
                elevation: null,
              },
              policy: {
                default: 'deny',
                humanMayApprove: options.humanMayApprove ?? true,
                ask: ['Write'],
                denyMessage: 'Denied by AgentManager: not in the effective allow set.',
              },
              diagnostics: options.diagnostics ?? [],
            };
            const compiled = options.compile?.(input, base) ?? base;
            outputs.push(compiled);
            return Promise.resolve(compiled);
          },
        }),
  };
  return provider;
}

export interface FakeProjectsOptions {
  readonly workspacePath?: string;
  readonly refusal?: {
    readonly code: string;
    readonly reason: string;
    readonly retryable: boolean;
  };
  readonly launchContext?: Partial<LaunchContextView>;
  readonly onAcquire?: (projectId: string, assignmentId: string) => void;
}

export interface FakeProjects extends ProjectsProvider {
  readonly acquisitions: { projectId: string; assignmentId: string; write: boolean }[];
  readonly releases: string[];
  /** Flips a refusing fake into a granting one, for the blocked-entry test. */
  clearRefusal(): void;
}

export function fakeProjects(options: FakeProjectsOptions = {}): FakeProjects {
  const acquisitions: { projectId: string; assignmentId: string; write: boolean }[] = [];
  const releases: string[] = [];
  let refusal = options.refusal;
  let leaseSeq = 0;
  const path = options.workspacePath ?? resolve(process.cwd(), 'fixture-workspace');

  function leaseFor(projectId: string, assignmentId: string, write: boolean): WorkspaceLeaseView {
    leaseSeq += 1;
    return {
      id: `lease-${String(leaseSeq)}`,
      projectId,
      assignmentId,
      kind: 'primary',
      path,
      branch: null,
      write,
    };
  }

  let lease: WorkspaceLeaseView | undefined;

  return {
    acquisitions,
    releases,
    clearRefusal() {
      refusal = undefined;
    },
    acquireWorkspace(projectId, assignmentId, acquire): Promise<AcquireWorkspaceResultView> {
      acquisitions.push({ projectId, assignmentId, write: acquire.write });
      options.onAcquire?.(projectId, assignmentId);
      if (refusal !== undefined) {
        return Promise.resolve({
          refused: true,
          code: refusal.code,
          reason: refusal.reason,
          retryable: refusal.retryable,
        });
      }
      lease = leaseFor(projectId, assignmentId, acquire.write);
      return Promise.resolve(lease);
    },
    releaseWorkspace(leaseId): Promise<unknown> {
      releases.push(leaseId);
      return Promise.resolve({ released: true });
    },
    getEffectiveLaunchContext(projectId, assignmentId): Promise<LaunchContextView> {
      const workspace = lease ?? leaseFor(projectId, assignmentId, true);
      return Promise.resolve({
        cwd: workspace.path,
        env: [{ name: 'PROJECT_FLAG', value: '1' }],
        workspace,
        ...options.launchContext,
      });
    },
  };
}

/** A resolver that answers with whatever secrets a test stored. */
export function fakeSecrets(values: Record<string, string>): SecretResolver {
  return {
    get: (key) => Promise.resolve(key in values ? new Secret(values[key] ?? '') : undefined),
  };
}

export interface RecordedEvent {
  readonly type: string;
  readonly ids: AppEvent['ids'];
  readonly payload: unknown;
  readonly persist: boolean;
}

export interface RecordedLog {
  readonly level: string;
  readonly message: string;
  readonly detail: Record<string, unknown>;
}

export interface LaunchHarness {
  readonly storage: Storage;
  readonly sessions: SessionRepository;
  readonly usage: UsageRepository;
  readonly transcripts: TranscriptFactory;
  readonly service: RunnerService;
  readonly launch: LaunchChain;
  readonly roster: FakeRoster;
  readonly projects: FakeProjects;
  readonly events: RecordedEvent[];
  readonly logs: RecordedLog[];
  readonly config: RunnerConfig;
  /** The real bus, so a test can play the part of whoever answers a question. */
  readonly bus: EventBus;
  /** M7's bridge client — orchestrator's when one was supplied, else the fallback. */
  readonly questionBridge: QuestionBridgeClient;
  /** M7's parked-session machinery (§5.4 stage 3, §9.2). Not subscribed by default. */
  readonly questionSessions: QuestionSessions;
  /** Publishes the events the module wires; returns the unsubscribe. */
  subscribeQuestions(): () => void;
  /** Creates a project, an agent index row and an open assignment. */
  seed(options?: { readonly agentId?: string; readonly projectStatus?: string }): {
    projectId: string;
    assignmentId: string;
    agentId: string;
  };
  /**
   * Calls one of runner's routes against the handler contract — no socket,
   * because `RouteHandler` was defined so a handler is testable without one
   * (foundation §6.4).
   */
  call(
    method: string,
    path: string,
    options?: { body?: unknown; params?: Record<string, string>; query?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Reads a transcript back as parsed lines. */
  transcriptLines(sessionId: string): Record<string, unknown>[];
  close(): void;
}

export interface LaunchHarnessOptions {
  readonly dataRoot: string;
  readonly query?: QueryFn;
  /**
   * An orchestrator-shaped provider for M7's bridge.
   *
   * Omitted, the harness wires the **degraded fallback** of §5.2 — which is the
   * shape a build with `modules.orchestrator.enabled: false` really has, so the
   * default is the case the design says must keep working rather than the happy
   * one.
   */
  readonly orchestrator?: QuestionBridgeProvider | undefined;
  /** Replaces the bridge outright, for the callback-level tests. */
  readonly questionBridge?: QuestionBridgeView | undefined;
  /** A meter that fails, for M4's "neither side applied" transaction test. */
  readonly usage?: UsageRepository;
  readonly roster?: FakeRoster;
  readonly projects?: FakeProjects;
  readonly assignmentContext?: AssignmentContextProvider;
  readonly secrets?: SecretResolver;
  readonly auth?: LaunchChainDeps['auth'];
  readonly config?: Partial<RunnerConfig>;
  readonly agentEnv?: Record<string, string | null>;
  /** An advanceable clock, for the deadlines M5 measures in minutes. */
  readonly clock?: () => Date;
}

export function makeLaunchHarness(options: LaunchHarnessOptions): LaunchHarness {
  const storage = openTestStorage(options.dataRoot);
  const clock = options.clock ?? ((): Date => FIXED_NOW);
  const config: RunnerConfig = {
    ...RUNNER_CONFIG_DEFAULTS,
    ...options.config,
    transcript: { ...RUNNER_CONFIG_DEFAULTS.transcript, ...options.config?.transcript },
  };

  const sessions = createSessionRepository({ db: storage.db, store: storage.store, clock });
  const usage =
    options.usage ??
    createUsageRepository({ db: storage.db, assignments: storage.store.assignments, clock });
  const transcripts = createTranscriptFactory({
    transcripts: storage.store.transcripts,
    sessions: storage.store.sessions,
    clock,
  });
  const reader = createTranscriptReader({
    transcripts: storage.store.transcripts,
    sessions: storage.store.sessions,
    maxTailBytes: config.transcript.maxTailBytes,
  });

  const roster = options.roster ?? fakeRoster();
  const projects = options.projects ?? fakeProjects();
  const events: RecordedEvent[] = [];
  const logs: RecordedLog[] = [];

  // A **real** bus rather than an emit-only stub: M7's fallback bridge and its
  // parked-session machinery both resolve on subscriptions, so a bus that only
  // recorded would make the degraded path untestable — which is the one path
  // §5.2 says must be verified rather than assumed.
  const bus = createEventBus({ events: storage.store.events, clock });
  bus.subscribe((event) => {
    events.push({
      type: event.type,
      ids: event.ids,
      payload: event.payload,
      persist: event.persist,
    });
  });

  const questionBridge =
    options.questionBridge === undefined
      ? createQuestionBridgeClient({
          orchestrator: () => options.orchestrator,
          questions: storage.store.questions,
          bus,
          clock,
          log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
        })
      : ({
          ...options.questionBridge,
          mode: () => 'orchestrator' as const,
        } satisfies QuestionBridgeClient);

  const leases = createLeaseBook({
    projects: () => projects,
    isAssignmentOpen: (assignmentId) =>
      storage.store.assignments.get(assignmentId)?.status === 'open',
    log: (level, message, detail) => logs.push({ level, message, detail }),
  });

  const launch = createLaunchChain({
    sessions,
    usage,
    transcripts,
    store: {
      assignments: storage.store.assignments,
      agents: storage.store.agents,
      projects: storage.store.projects,
      settings: storage.store.settings,
      questions: storage.store.questions,
    },
    questionBridge,
    roster: () => roster,
    projects: () => projects,
    assignmentContext:
      options.assignmentContext ??
      createAssignmentContextStub({ assignments: storage.store.assignments }),
    leases,
    secrets: options.secrets ?? fakeSecrets({ 'claude.oauthToken': 'sk-ant-oat01-fixture' }),
    config,
    auth: options.auth ?? 'subscription',
    policy: { allowPermissionElevation: true, globalDeny: [] },
    agentEnv: options.agentEnv ?? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CONFIG_DIR: null },
    stateDir: storage.paths.state,
    query: options.query ?? scriptedQuery({ messages: successScript() }).query,
    clock,
    bus,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  });

  const questionSessions = createQuestionSessions({
    sessions,
    questions: storage.store.questions,
    control: launch,
    bus,
    clock,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  });

  const service = createRunnerService({ sessions, usage, transcripts: reader, launch });
  const routes = createRunnerRoutes({
    service,
    logger: { error: () => undefined, debug: () => undefined } as unknown as Logger,
  });

  let seeded = 0;
  return {
    storage,
    sessions,
    usage,
    transcripts,
    service,
    launch,
    roster,
    projects,
    events,
    logs,
    config,
    bus,
    questionBridge,
    questionSessions,

    subscribeQuestions: () => questionSessions.subscribe(),

    seed(seedOptions = {}) {
      seeded += 1;
      const project = storage.store.projects.create({
        slug: `fixture-${String(seeded)}`,
        name: `Fixture ${String(seeded)}`,
        localPath: resolve(options.dataRoot, '..', `fixture-${String(seeded)}`),
        ...(seedOptions.projectStatus === undefined ? {} : { status: seedOptions.projectStatus }),
      });
      const agentId = seedOptions.agentId ?? `agent-${String(seeded)}`;
      storage.store.agents.upsert({ id: agentId, name: `Agent ${String(seeded)}` });
      const assignment = storage.store.assignments.create({
        projectId: project.id,
        pattern: 'solo',
        goal: 'a fixture assignment',
      });
      return { projectId: project.id, assignmentId: assignment.id, agentId };
    },

    async call(method, path, callOptions = {}) {
      const route = routes.find((entry) => entry.method === method && entry.path === path);
      if (route === undefined) throw new Error(`no route ${method} ${path}`);
      const req = {
        method,
        path,
        params: callOptions.params ?? {},
        query: new URLSearchParams(callOptions.query ?? ''),
        body: callOptions.body,
        origin: 'local',
        requestId: 'req-1',
        logger: { debug: () => undefined },
      } as unknown as RequestContext;
      const result = (await route.handler(req, responseTools)) as HttpResult;
      return {
        status: result.status,
        body: JSON.parse(result.body?.toString('utf8') ?? '{}') as Record<string, unknown>,
      };
    },

    transcriptLines(sessionId) {
      const page = reader.tail(sessionId, { maxBytes: 1_000_000 });
      return page.lines as unknown as Record<string, unknown>[];
    },

    close() {
      // The same order the module's `stop()` uses: no new admissions, then the
      // database goes. A pump that fired after the connection closed would be a
      // test-only crash with nothing to do with the code under test.
      launch.stopAdmitting();
      storage.close();
    },
  };
}
