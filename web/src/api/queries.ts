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
  BrowseListing,
  EffectiveConfig,
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
  SessionListView,
  WorkItemListView,
  WorkspaceListView,
} from './types';

/** Every key the app uses, in one object so §3.4's map cannot mistype one. */
export const queryKeys = {
  config: ['config', 'effective'] as const,
  health: ['health'] as const,
  roster: ['roster', 'agents'] as const,
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
  questions: (status: QuestionStatus) => ['questions', { status }] as const,
  question: (id: string) => ['questions', 'one', id] as const,
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

/** `GET /api/sessions?agentId=` — the agent detail page's history (§7.3). */
export function useAgentSessions(client: ApiClient, id: string): UseQueryResult<SessionListView> {
  return useQuery({
    queryKey: queryKeys.agentSessions(id),
    queryFn: async () =>
      unwrap(await client.request<SessionListView>('/sessions', { query: { agentId: id } })),
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
