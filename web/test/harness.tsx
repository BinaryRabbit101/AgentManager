/**
 * Mounting a screen the way `main.tsx` mounts it, with the network under the
 * test's control.
 *
 * Everything long-lived is constructed rather than imported as module state
 * (see `app/AppContext.tsx`), which is what makes this possible: the same
 * provider tree, a real `QueryClient`, a real `ApiClient` and a real
 * `EventStream` — with only `fetch` and the SSE transport substituted. Nothing
 * below the providers knows it is in a test.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { AvatarCache } from '../src/api/avatars';
import { ApiClient } from '../src/api/client';
import type {
  AgentView,
  Diagnostic,
  EventFrame,
  EffectiveConfig,
  Health,
  Project,
} from '../src/api/types';
import { AppServicesProvider, type BootFacts } from '../src/app/AppContext';
import { EventStream } from '../src/events/EventStream';
import type { SseConnection, SseHandlers, SseTransport } from '../src/events/sse';

// ---------------------------------------------------------------------------
// A scriptable SSE transport
// ---------------------------------------------------------------------------

export interface FakeStream {
  readonly transport: SseTransport;
  /** Every URL the stream has been opened with, in order. */
  readonly urls: string[];
  /** Pushes one frame to the live handler, as the server would. */
  emit(frame: Partial<EventFrame> & { readonly type: string }): void;
  /** Foundation's `replay-complete`, which is what makes the client `live`. */
  completeReplay(): void;
  /** A heartbeat comment — the thing `EventSource` cannot see. */
  heartbeat(): void;
  /** Drops the connection, as a killed core would. */
  drop(): void;
}

export function fakeStream(): FakeStream {
  const urls: string[] = [];
  let handlers: SseHandlers | undefined;
  let fail: ((error: Error) => void) | undefined;

  const transport: SseTransport = (url, _headers, signal, incoming): SseConnection => {
    urls.push(url);
    handlers = incoming;
    let settle: (() => void) | undefined;
    const done = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    signal.addEventListener('abort', () => settle?.(), { once: true });
    // The server accepts the socket on the next tick, as a real one would.
    queueMicrotask(() => incoming.onOpen());
    return { done, close: () => settle?.() };
  };

  return {
    transport,
    urls,
    emit: (frame) => {
      handlers?.onActivity();
      handlers?.onFrame({
        kind: 'event',
        event: 'event',
        ...(frame.id === undefined ? {} : { id: frame.id }),
        data: JSON.stringify({
          ts: '2026-08-17T09:00:00.000Z',
          ids: {},
          payload: undefined,
          persist: frame.id !== undefined,
          ...frame,
        }),
      });
    },
    completeReplay: () => {
      handlers?.onActivity();
      handlers?.onFrame({ kind: 'event', event: 'replay-complete', data: '{"count":0}' });
    },
    heartbeat: () => {
      handlers?.onActivity();
      handlers?.onFrame({ kind: 'comment' });
    },
    drop: () => fail?.(new Error('the core stopped answering')),
  };
}

// ---------------------------------------------------------------------------
// Fixtures — the smallest honest version of each wire shape
// ---------------------------------------------------------------------------

export function anAgent(overrides: {
  readonly id: string;
  readonly name?: string;
  readonly specialty?: AgentView['definition']['specialty'];
  readonly avatar?: AgentView['definition']['avatar'];
  readonly tagline?: string;
  readonly overseer?: boolean;
  readonly pinned?: boolean;
  readonly boardOrder?: number;
  readonly archivedAt?: string | null;
  readonly diagnostics?: readonly Diagnostic[];
  readonly needsCredentials?: boolean;
  readonly lastUsedAt?: string | null;
}): AgentView {
  return {
    definition: {
      schemaVersion: 1,
      id: overrides.id,
      name: overrides.name ?? overrides.id,
      specialty: overrides.specialty ?? 'general',
      ...(overrides.avatar === undefined ? {} : { avatar: overrides.avatar }),
      ...(overrides.tagline === undefined ? {} : { tagline: overrides.tagline }),
      ...(overrides.overseer === undefined
        ? {}
        : { capabilities: { overseer: overrides.overseer } }),
      meta: { createdAt: '2026-08-01T00:00:00.000Z' },
    },
    persona: '',
    uiState: {
      agentId: overrides.id,
      boardOrder: overrides.boardOrder ?? 0,
      pinned: overrides.pinned ?? false,
      lastUsedAt: overrides.lastUsedAt ?? null,
    },
    diagnostics: overrides.diagnostics ?? [],
    archivedAt: overrides.archivedAt ?? null,
    avatarUrl: `/api/roster/agents/${overrides.id}/avatar`,
    ...(overrides.needsCredentials === undefined
      ? {}
      : { needsCredentials: overrides.needsCredentials }),
  };
}

export function aProject(overrides: {
  readonly id: string;
  readonly name?: string;
  readonly localPath?: string;
  readonly status?: Project['status'];
  readonly health?: Project['health'];
}): Project {
  return {
    id: overrides.id,
    slug: overrides.id,
    name: overrides.name ?? overrides.id,
    localPath: overrides.localPath ?? `C:\\Code\\${overrides.id}`,
    repoUrl: null,
    defaultBranch: 'main',
    vcs: 'git',
    notes: '',
    status: overrides.status ?? 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    lastActivityAt: null,
    archivedAt: null,
    health: overrides.health ?? [],
  };
}

export const BOOT_FACTS: BootFacts = {
  config: {
    edition: 'home',
    version: '0.1.0',
    config: {},
    sources: {},
    origins: {},
    layers: ['built-in'],
    redacted: true,
  } satisfies EffectiveConfig,
  health: {
    status: 'ok',
    phase: 'running',
    version: '0.1.0',
    edition: 'home',
    uptime: 1,
    modules: [
      { name: 'storage', status: 'ok' },
      { name: 'roster', status: 'ok' },
      { name: 'projects', status: 'ok' },
      { name: 'orchestrator', status: 'ok' },
    ],
    conditions: [],
  } satisfies Health,
};

// ---------------------------------------------------------------------------
// The mount
// ---------------------------------------------------------------------------

export type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A table of `path → body`, which is what most screens need. */
export function routes(table: Readonly<Record<string, unknown>>): Responder {
  return (url) => {
    const path = url.split('?')[0] ?? url;
    const body = table[path];
    if (body === undefined) {
      return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
    }
    return json(body);
  };
}

export interface MountOptions {
  readonly respond?: Responder;
  readonly stream?: FakeStream;
  readonly boot?: BootFacts;
  readonly route?: string;
}

export interface Mounted extends RenderResult {
  readonly client: ApiClient;
  readonly events: EventStream;
  readonly avatars: AvatarCache;
  readonly stream: FakeStream;
  readonly queryClient: QueryClient;
  /** Every request the screen made, in order — the request-count assertions. */
  readonly calls: string[];
}

export function mount(ui: ReactElement, options: MountOptions = {}): Mounted {
  const calls: string[] = [];
  const respond = options.respond ?? routes({});
  const stream = options.stream ?? fakeStream();

  const client = new ApiClient({
    fetch: ((input: string, init: RequestInit) => {
      calls.push(input);
      return Promise.resolve(respond(input, init));
    }) as unknown as typeof globalThis.fetch,
    tokens: { get: () => null, set: () => undefined },
  });
  const avatars = new AvatarCache(client);
  const events = new EventStream({ client, transport: stream.transport });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });

  const wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <AppServicesProvider services={{ client, avatars, events, boot: options.boot ?? BOOT_FACTS }}>
        <MemoryRouter initialEntries={[options.route ?? '/']}>{children}</MemoryRouter>
      </AppServicesProvider>
    </QueryClientProvider>
  );

  const result = render(ui, { wrapper });
  return { ...result, client, events, avatars, stream, queryClient, calls };
}
