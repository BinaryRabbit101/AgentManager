/**
 * Query keys and the hooks over them (DESIGN §1.2).
 *
 * "One query key per endpoint, `staleTime` generous because the event feed is
 * what invalidates." The app polls nothing: every refetch in the whole frontend
 * is either a mount or an event arriving through §3.4's map.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { ApiClient } from './client';
import { unwrap } from './result';
import type {
  AgentView,
  AssignmentListView,
  AssignmentView,
  BrowseListing,
  ConversationView,
  EffectiveConfig,
  PatternListView,
  PermissionCatalogue,
  RemoteAgentListView,
  RemoteStatus,
  RemoteTokenListView,
  RunnerQueue,
  RunnerUsage,
  FleetStatus,
  Health,
  ProjectActivityPage,
  ProjectDetail,
  ProjectListView,
  QuestionCard,
  QuestionListView,
  QuestionStatus,
  RosterListView,
  SessionDetailView,
  TaskTemplateListView,
  SessionListView,
  SessionStatus,
  TriggerListView,
  WorkItemListView,
  WorkspaceListView,
} from './types';

/** Every key the app uses, in one object so §3.4's map cannot mistype one. */
export const queryKeys = {
  config: ['config', 'effective'] as const,
  health: ['health'] as const,
  roster: ['roster', 'agents'] as const,
  /** Under the same `roster` prefix as the board, so §3.4's one `roster.*` rule
   *  refetches both halves of the library from one event (roster §2.4, WO5). */
  taskTemplates: ['roster', 'templates'] as const,
  /** Static server-side (roster §6.3) — under the `roster` prefix for tidiness
   *  rather than because anything invalidates it. */
  permissionCatalogue: ['roster', 'permission-catalogue'] as const,
  projects: (includeArchived: boolean) => ['projects', { includeArchived }] as const,
  project: (id: string) => ['projects', 'one', id] as const,
  browse: (path: string | null) => ['fs', 'browse', path] as const,
  session: (id: string) => ['sessions', id] as const,
  orchestratorStatus: ['orchestrator', 'status'] as const,
  activity: (id: string) => ['projects', 'one', id, 'activity'] as const,
  workItems: (id: string) => ['projects', 'one', id, 'work-items'] as const,
  workspaces: (id: string) => ['projects', 'one', id, 'workspaces'] as const,
  agent: (id: string) => ['roster', 'agents', id] as const,
  agentSessions: (id: string) => ['sessions', { agentId: id }] as const,
  sessions: (status: string) => ['sessions', { status }] as const,
  questions: (status: QuestionStatus) => ['questions', { status }] as const,
  /**
   * The open cards belonging to one assignment — what §9's session view answers
   * inline. Keyed under `questions` on purpose: §3.4's map invalidates the whole
   * `['questions']` prefix on `assignment.question.raised` / `.answered`, so this
   * follows the inbox without a second entry in the map.
   */
  assignmentQuestions: (assignmentId: string) =>
    ['questions', { assignmentId, status: 'open' }] as const,
  question: (id: string) => ['questions', 'one', id] as const,
  assignments: (status: string) => ['assignments', { status }] as const,
  assignment: (id: string) => ['assignments', 'one', id] as const,
  conversation: (id: string) => ['assignments', 'one', id, 'conversation'] as const,
  patterns: ['assignments', 'patterns'] as const,
  /** §2.8's standing schedules — every trigger, for settings → Automation. */
  triggers: ['triggers'] as const,
  /** The same rows, scoped to one project page. Under the same prefix, so
   *  §3.4's one `trigger.*` rule refreshes both surfaces from one event. */
  projectTriggers: (projectId: string) => ['triggers', { projectId }] as const,
  runnerUsage: ['runner', 'usage'] as const,
  runnerQueue: ['runner', 'queue'] as const,
  remoteStatus: ['remote', 'status'] as const,
  remoteTokens: ['remote', 'tokens'] as const,
  remoteAgents: ['remote', 'agents'] as const,
};

/** §16: generous, because invalidation is event-driven rather than temporal. */
export const DEFAULT_STALE_TIME_MS = 30_000;

export function useRoster(client: ApiClient): UseQueryResult<RosterListView> {
  return useQuery({
    queryKey: queryKeys.roster,
    queryFn: async () => unwrap(await client.request<RosterListView>('/roster/agents')),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/**
 * `GET /api/roster/templates` — the Start-work template strip (roster §2.4, WO5).
 *
 * `retry: false` is inherited from the client, so a core that predates the route
 * costs one 404 per mount and the strip renders as the blank card alone — which
 * is exactly today's flow, and the reason the blank card is first.
 */
export function useTaskTemplates(client: ApiClient): UseQueryResult<TaskTemplateListView> {
  return useQuery({
    queryKey: queryKeys.taskTemplates,
    queryFn: async () => unwrap(await client.request<TaskTemplateListView>('/roster/templates')),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/**
 * `GET /api/roster/permission-catalogue` — the editor's rule picker (§7.1, WO2).
 *
 * The answer never changes for the life of a core, so `staleTime` is `Infinity`:
 * one request per app load, and no refetch on a remount of the editor.
 *
 * `retry: false` is inherited from the client, so a core that predates the route
 * costs one 404 and the picker degrades to Compose + Raw — which is why the
 * fieldset takes the catalogue as an optional prop rather than waiting on it.
 */
export function usePermissionCatalogue(client: ApiClient): UseQueryResult<PermissionCatalogue> {
  return useQuery({
    queryKey: queryKeys.permissionCatalogue,
    queryFn: async () =>
      unwrap(await client.request<PermissionCatalogue>('/roster/permission-catalogue')),
    staleTime: Infinity,
  });
}

/**
 * §2.8's triggers, either every one or one project's (WO8).
 *
 * `staleTime` is the usual generous one because the event feed is what
 * invalidates: `trigger.fired|skipped|blocked|disabled` all land on
 * `['triggers']`, so a background run appears here without anything polling.
 */
export function useTriggers(
  client: ApiClient,
  projectId?: string,
): UseQueryResult<TriggerListView> {
  return useQuery({
    queryKey: projectId === undefined ? queryKeys.triggers : queryKeys.projectTriggers(projectId),
    queryFn: async () =>
      unwrap(
        await client.request<TriggerListView>('/triggers', {
          ...(projectId === undefined ? {} : { query: { projectId } }),
        }),
      ),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

export function useProjects(
  client: ApiClient,
  includeArchived = false,
): UseQueryResult<ProjectListView> {
  return useQuery({
    queryKey: queryKeys.projects(includeArchived),
    queryFn: async () =>
      unwrap(
        await client.request<ProjectListView>('/projects', {
          query: includeArchived ? { includeArchived: 'true' } : {},
        }),
      ),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

export function useBrowse(client: ApiClient, path: string | null): UseQueryResult<BrowseListing> {
  return useQuery({
    queryKey: queryKeys.browse(path),
    queryFn: async () =>
      unwrap(
        await client.request<BrowseListing>('/fs/browse', {
          query: path === null ? {} : { path },
        }),
      ),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/**
 * One project, with its `defaults` (§6's pre-fill and the elevation banner).
 *
 * The list route spreads the same record today, but only `GET /api/projects/:id`
 * is *promised* to carry `defaults` ("full record, defaults (elevation
 * included)"), and the elevation banner is the one thing in the launch flow that
 * must never quietly stop rendering because a list projection got thinner.
 */
export function useProject(client: ApiClient, id: string | null): UseQueryResult<ProjectDetail> {
  return useQuery({
    queryKey: queryKeys.project(id ?? ''),
    enabled: id !== null && id !== '',
    queryFn: async () =>
      unwrap(await client.request<ProjectDetail>(`/projects/${encodeURIComponent(id ?? '')}`)),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/** `GET /api/sessions/:id` — the record, its usage rollup, its queue position. */
export function useSession(client: ApiClient, id: string): UseQueryResult<SessionDetailView> {
  return useQuery({
    queryKey: queryKeys.session(id),
    queryFn: async () =>
      unwrap(await client.request<SessionDetailView>(`/sessions/${encodeURIComponent(id)}`)),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/**
 * The inbox, in **one** request (§11.1).
 *
 * orchestrator §11.1's list projection carries the recommendations inline and
 * the assignment / project / session ids denormalised, so nothing here joins and
 * no second query stands between arriving at `/questions` and the first card.
 * IMPLEMENTATION §5 makes a second request on a cold load a milestone failure.
 */
export function useQuestions(
  client: ApiClient,
  status: QuestionStatus,
): UseQueryResult<QuestionListView> {
  return useQuery({
    queryKey: queryKeys.questions(status),
    queryFn: async () =>
      unwrap(await client.request<QuestionListView>('/questions', { query: { status } })),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/**
 * `GET /api/questions/:id` — the deep link's **one** request (§2.1, §11.1).
 *
 * The same projection the list returns, "plus its answer record", so arriving
 * cold on `/questions/abc` draws an answerable card without a list load and
 * without a join.
 */
export function useQuestion(client: ApiClient, id: string): UseQueryResult<QuestionCard> {
  return useQuery({
    queryKey: queryKeys.question(id),
    queryFn: async () =>
      unwrap(await client.request<QuestionCard>(`/questions/${encodeURIComponent(id)}`)),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/**
 * `GET /api/questions?status=open&assignmentId=…` — the session view's cards.
 *
 * §11.3 pins one answer endpoint and one card component "local and remote
 * alike", and §11 pins that a card is answered where it is *seen*. The session
 * view is one of those places: a run that stops to ask should not require a trip
 * to the inbox and back, so it reads its own assignment's open cards and renders
 * the same {@link QuestionCardView} the inbox does. The filter is the server's
 * (`assignmentId`); narrowing to this session is a `sessionId` comparison on the
 * projection, which already carries it denormalised.
 */
export function useAssignmentQuestions(
  client: ApiClient,
  assignmentId: string,
): UseQueryResult<QuestionListView> {
  return useQuery({
    queryKey: queryKeys.assignmentQuestions(assignmentId),
    enabled: assignmentId !== '',
    queryFn: async () =>
      unwrap(
        await client.request<QuestionListView>('/questions', {
          query: { status: 'open', assignmentId },
        }),
      ),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/**
 * `GET /api/orchestrator/status` — the fleet view, and §2.2's badge count.
 *
 * This is the endpoint ui M2 and M5 both degraded around while it was still
 * orchestrator M9. It has landed, so the badge reads `questions.open` from the
 * server instead of counting `assignment.question.raised` frames from zero — the
 * shape of the degrade was always "only where the value is read", and this is
 * that one line. Live updates still come from the events (§11.1 wants the badge
 * inside a second, and a refetch round-trip is not that); the query is what makes
 * a cold load and a reconnect correct.
 */
export function useOrchestratorStatus(client: ApiClient): UseQueryResult<FleetStatus> {
  return useQuery({
    queryKey: queryKeys.orchestratorStatus,
    queryFn: async () => unwrap(await client.request<FleetStatus>('/orchestrator/status')),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/** `GET /api/projects/:id/activity` — §8.2's timeline, grouped by assignment. */
export function useProjectActivity(
  client: ApiClient,
  id: string,
): UseQueryResult<ProjectActivityPage> {
  return useQuery({
    queryKey: queryKeys.activity(id),
    queryFn: async () =>
      unwrap(
        await client.request<ProjectActivityPage>(`/projects/${encodeURIComponent(id)}/activity`),
      ),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/** `GET /api/projects/:id/work-items` — the thin ranked list of §8.2 region 4. */
export function useWorkItems(client: ApiClient, id: string): UseQueryResult<WorkItemListView> {
  return useQuery({
    queryKey: queryKeys.workItems(id),
    // The launch flow mounts before a project is chosen; an id-less request
    // would be a 404 the user never asked for.
    enabled: id !== '',
    queryFn: async () =>
      unwrap(
        await client.request<WorkItemListView>(`/projects/${encodeURIComponent(id)}/work-items`),
      ),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/** `GET /api/projects/:id/workspaces` — §8.2's **Review needed** region. */
export function useWorkspaces(client: ApiClient, id: string): UseQueryResult<WorkspaceListView> {
  return useQuery({
    queryKey: queryKeys.workspaces(id),
    queryFn: async () =>
      unwrap(
        await client.request<WorkspaceListView>(`/projects/${encodeURIComponent(id)}/workspaces`),
      ),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/** `GET /api/roster/agents/:id` — the editor's subject (§7.3). */
export function useAgent(client: ApiClient, id: string): UseQueryResult<AgentView> {
  return useQuery({
    queryKey: queryKeys.agent(id),
    queryFn: async () =>
      unwrap(await client.request<AgentView>(`/roster/agents/${encodeURIComponent(id)}`)),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/**
 * `GET /api/sessions` — §2.1's sessions destination, newest first.
 *
 * The same route the agent page filters by `agentId`; here it is unfiltered
 * except by `status`, and the server's order is kept (runner §11.1 returns
 * newest first). Nothing here sorts.
 */
export function useSessions(
  client: ApiClient,
  status: SessionStatus | 'all',
): UseQueryResult<SessionListView> {
  return useQuery({
    queryKey: queryKeys.sessions(status),
    queryFn: async () =>
      unwrap(
        await client.request<SessionListView>('/sessions', {
          query: status === 'all' ? {} : { status },
        }),
      ),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/** `GET /api/sessions?agentId=` — the agent detail page's history (§7.3). */
export function useAgentSessions(client: ApiClient, id: string): UseQueryResult<SessionListView> {
  return useQuery({
    queryKey: queryKeys.agentSessions(id),
    queryFn: async () =>
      unwrap(await client.request<SessionListView>('/sessions', { query: { agentId: id } })),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/** `GET /api/assignments/:id` — §10.2's header. The same route for a solo one. */
export function useAssignment(client: ApiClient, id: string): UseQueryResult<AssignmentView> {
  return useQuery({
    queryKey: queryKeys.assignment(id),
    queryFn: async () =>
      unwrap(await client.request<AssignmentView>(`/assignments/${encodeURIComponent(id)}`)),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/**
 * `GET /api/assignments/:id/conversation` — rounds → entries (§10.1).
 *
 * "The UI performs no merge of its own: the ordering is the server's." So this
 * is one request and the component renders what comes back in the order it
 * comes back — there is no second query to join a turn to its report.
 */
export function useConversation(client: ApiClient, id: string): UseQueryResult<ConversationView> {
  return useQuery({
    queryKey: queryKeys.conversation(id),
    queryFn: async () =>
      unwrap(
        await client.request<ConversationView>(
          `/assignments/${encodeURIComponent(id)}/conversation`,
        ),
      ),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/** `GET /api/assignments?status=open` — §12's third panel, in tokens. */
export function useAssignments(
  client: ApiClient,
  status: 'open' | 'closed' = 'open',
): UseQueryResult<AssignmentListView> {
  return useQuery({
    queryKey: queryKeys.assignments(status),
    queryFn: async () =>
      unwrap(await client.request<AssignmentListView>('/assignments', { query: { status } })),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/** `GET /api/patterns` — §10.4's dialog is driven "entirely" by this. */
export function usePatterns(client: ApiClient, enabled = true): UseQueryResult<PatternListView> {
  return useQuery({
    queryKey: queryKeys.patterns,
    enabled,
    queryFn: async () => unwrap(await client.request<PatternListView>('/patterns')),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/**
 * `GET /api/runner/usage` — §12's first panel.
 *
 * Runner's own IMPLEMENTATION M11 owns this route; until it lands the request
 * 404s and the panel says so in one sentence rather than rendering zeros that
 * would read as "you have used nothing" (§12's honesty contract). `retry: false`
 * is inherited, so the absent case costs one request per mount and no more.
 */
export function useRunnerUsage(client: ApiClient): UseQueryResult<RunnerUsage> {
  return useQuery({
    queryKey: queryKeys.runnerUsage,
    queryFn: async () => unwrap(await client.request<RunnerUsage>('/runner/usage')),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/** `GET /api/runner/queue` — §12's second panel, live on `runner.queue.changed`. */
export function useRunnerQueue(client: ApiClient): UseQueryResult<RunnerQueue> {
  return useQuery({
    queryKey: queryKeys.runnerQueue,
    queryFn: async () => unwrap(await client.request<RunnerQueue>('/runner/queue')),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/**
 * `GET /api/remote/status` — §13.2, and the source of §13.4's deny list.
 *
 * `enabled` is the feature detection of §3.5: in the work edition the module is
 * not loaded and its routes do not exist, so the query is never made. It is not
 * a 404 probe — the decision is read from the module list at boot.
 */
export function useRemoteStatus(client: ApiClient, enabled: boolean): UseQueryResult<RemoteStatus> {
  return useQuery({
    queryKey: queryKeys.remoteStatus,
    enabled,
    queryFn: async () => unwrap(await client.request<RemoteStatus>('/remote/status')),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

export function useRemoteTokens(
  client: ApiClient,
  enabled: boolean,
): UseQueryResult<RemoteTokenListView> {
  return useQuery({
    queryKey: queryKeys.remoteTokens,
    enabled,
    queryFn: async () => unwrap(await client.request<RemoteTokenListView>('/remote/tokens')),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/** `GET /api/remote/agents` — the per-agent grants of §13.2, with `expiresAt`. */
export function useRemoteAgents(
  client: ApiClient,
  enabled: boolean,
): UseQueryResult<RemoteAgentListView> {
  return useQuery({
    queryKey: queryKeys.remoteAgents,
    enabled,
    queryFn: async () => unwrap(await client.request<RemoteAgentListView>('/remote/agents')),
    staleTime: DEFAULT_STALE_TIME_MS,
  });
}

/** The two boot facts of §3.5, fetched once before anything renders. */
export async function fetchBootFacts(
  client: ApiClient,
): Promise<{ config: EffectiveConfig; health: Health }> {
  const [config, health] = await Promise.all([
    client.request<EffectiveConfig>('/config/effective'),
    client.request<Health>('/health'),
  ]);
  return { config: unwrap(config), health: unwrap(health) };
}
