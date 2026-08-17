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
  BrowseListing,
  EffectiveConfig,
  Health,
  ProjectListView,
  RosterListView,
} from './types';

/** Every key the app uses, in one object so §3.4's map cannot mistype one. */
export const queryKeys = {
  config: ['config', 'effective'] as const,
  health: ['health'] as const,
  roster: ['roster', 'agents'] as const,
  projects: (includeArchived: boolean) => ['projects', { includeArchived }] as const,
  browse: (path: string | null) => ['fs', 'browse', path] as const,
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
