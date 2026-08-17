/**
 * §3.1's rule 4 — the per-agent grant gate — remote DESIGN §6.2 and §6.3;
 * IMPLEMENTATION §8.
 *
 * ## The gate binds to launch *semantics*, not to route names
 *
 * §6.2 says this twice and gives the history, so it is worth restating whole:
 *
 * > "The rule is: *any route that can cause a session to start, resume as new
 * > work, or receive new instructions is gated, for every agent it would put to
 * > work* — and the tier list above is an enumeration of that rule as of v1, not
 * > its definition. […] This is stated as a principle because the enumeration was
 * > already wrong once: it named only `POST /api/sessions`, while the product's
 * > actual launch path is `POST /api/assignments/solo` […] so a remote client
 * > could start an agent with no grant simply by using the endpoint the UI
 * > actually calls."
 *
 * So {@link INITIATING_SURFACES} is an enumeration *plus* a safety net:
 * {@link classifyPath} treats any **write** to a path under `/api/assignments` or
 * `/api/sessions` that is not in the explicit observe/restrain lists as
 * initiating. A new launch route therefore arrives gated, and a new *harmless*
 * write there arrives over-gated and fails the enumeration test in
 * `grants.test.ts` until someone classifies it deliberately. Over-gated and
 * loudly wrong beats ungated and silently wrong.
 *
 * ## The three tiers, and the two that must never be gated
 *
 * | Tier | Gated? | Why |
 * |---|---|---|
 * | **Observe** — lists, reads, transcripts, streams, **answering a question** | No | "Watching is the point of remote", and §7.4 makes answering a hard invariant: gating it "would recreate exactly the failure ui's README forbids — a question stranded on the desktop". |
 * | **Restrain** — `/stop`, `/pause`, lowering `runner.capacity` | **Never** | "Stopping a runaway agent from a phone must work for *any* agent, including one whose grant expired an hour ago. A safety valve behind a consent gate is not a safety valve." |
 * | **Initiate** — every session-initiating surface | Yes | These are the verbs that make an agent do new work. |
 *
 * ## What is deliberately out of scope
 *
 * §6.2: "The gate binds to *client-initiated* launch routes, and deliberately not
 * to engine-driven ones." Runner's auto-resume of a parked session and the pattern
 * engine's next turn "pass through no HTTP route, carry no bearer token, and have
 * no remote request context to evaluate a grant against". Nothing in this file can
 * reach them, which is the intended shape rather than a gap: "the grant's question
 * is *may this remote client put this agent to work?*, asked once at the point a
 * client asks; it is not a per-session execution permit."
 */
import type {
  AgentsRepository,
  AssignmentsRepository,
  SessionsRepository,
} from '../../storage/index.js';

import { pathMatchesPattern } from './policy.js';

/** §3.1 rule 4 / §8.2: "show the grant prompt, then retry". */
export const REMOTE_ACCESS_REQUIRED_CODE = 'remote_access_required';

/** §6.3's opt-in that grants and starts in one call. */
export const CONFIRM_FIELD = 'confirmRemoteAccess';

/** Which of §6.2's three tiers a request falls in. */
export type RouteTier = 'observe' | 'restrain' | 'initiate';

/** How the agents a request would put to work are found. */
export type AgentSource =
  /** `body.agentId` — `POST /api/assignments/solo`. */
  | 'body-agent'
  /** `body.members[].agentId` — `POST /api/assignments`. */
  | 'body-members'
  /** The agent of the session named by `:id`. */
  | 'session'
  /** Every member of the assignment named by `:id`. */
  | 'assignment';

export interface LaunchSurface {
  readonly methods: readonly string[];
  /** An exact path, or one with `:name` segments, or a `/**` suffix. */
  readonly pattern: string;
  readonly source: AgentSource;
  /** Why this is initiation, in §6.2's terms. */
  readonly reason: string;
}

/**
 * §6.2's Initiate tier, enumerated.
 *
 * `POST /api/sessions`, `POST /api/sessions/:id/continue` and
 * `POST /api/assignments/:id/advance` are named by the design and are listed here
 * even though this build's route table does not (yet) register them: the whole
 * point of the safety net above is that an enumeration may lag, and an entry that
 * matches nothing costs nothing. `/api/sessions/:id/resume` is this build's
 * `/continue` — it resumes a paused session as new work — and is gated as such.
 */
export const INITIATING_SURFACES: readonly LaunchSurface[] = [
  {
    methods: ['POST'],
    pattern: '/api/assignments/solo',
    source: 'body-agent',
    reason:
      'The product’s real launch path: a drag-and-drop start creates the assignment and starts ' +
      'its first session in one call (remote DESIGN §6.2, §7.1).',
  },
  {
    methods: ['POST'],
    pattern: '/api/assignments',
    source: 'body-members',
    reason:
      'A pattern launch puts every member to work, so the gate is evaluated per agent and the ' +
      '409 lists all of them (remote DESIGN §6.2).',
  },
  {
    methods: ['POST'],
    pattern: '/api/assignments/:id/advance',
    source: 'assignment',
    reason:
      'Advancing plans and starts the next turn, which is new work for whichever seats that turn ' +
      'fills (remote DESIGN §6.2).',
  },
  {
    methods: ['POST'],
    pattern: '/api/sessions',
    source: 'body-agent',
    reason: 'A raw session start, where it exists as a route (remote DESIGN §6.2).',
  },
  {
    methods: ['POST'],
    pattern: '/api/sessions/:id/steer',
    source: 'session',
    reason:
      'Steering injects arbitrary new instructions into a live session: it is initiation wearing ' +
      'a continuation’s clothes (remote DESIGN §6.2).',
  },
  {
    methods: ['POST'],
    pattern: '/api/sessions/:id/continue',
    source: 'session',
    reason: 'Continuing resumes a session as new work (remote DESIGN §6.2).',
  },
  {
    methods: ['POST'],
    pattern: '/api/sessions/:id/resume',
    source: 'session',
    reason:
      'This build’s `/continue`: resuming a paused session puts the agent back to work, so it is ' +
      'initiation by §6.2’s rule rather than by its name.',
  },
];

/**
 * §6.2's Restrain tier, enumerated — ungated in both directions, always.
 *
 * `PUT /api/runner/capacity` is here because runner §15.3 #17 makes lowering the
 * cap a restraint. Raising it is neither restraint nor initiation of any *agent*,
 * so no grant could be evaluated for it; it is left to the route's own policy.
 */
export const RESTRAINING_SURFACES: readonly LaunchSurface[] = [
  {
    methods: ['POST'],
    pattern: '/api/sessions/:id/stop',
    source: 'session',
    reason: 'A safety valve behind a consent gate is not a safety valve (remote DESIGN §6.2).',
  },
  {
    methods: ['POST'],
    pattern: '/api/sessions/:id/pause',
    source: 'session',
    reason: 'Pausing is restraint, never initiation (remote DESIGN §6.2).',
  },
  {
    methods: ['PUT'],
    pattern: '/api/runner/capacity',
    source: 'session',
    reason: 'Runner §15.3 #17: lowering the cap is a restraint.',
  },
];

/**
 * Writes under the launch namespaces that are deliberately **not** initiation.
 *
 * Every entry is a decision, and the enumeration test asserts that this list plus
 * the two above cover every write the live route table exposes there — so a new
 * route cannot join this list by accident.
 */
export const NON_INITIATING_WRITES: readonly LaunchSurface[] = [
  {
    methods: ['PATCH'],
    pattern: '/api/assignments/:id',
    source: 'assignment',
    reason: 'Changes a budget, a round cap or a goal. Starts nothing.',
  },
  {
    methods: ['POST'],
    pattern: '/api/assignments/:id/close',
    source: 'assignment',
    reason: 'Closing is the opposite of initiation — a reduction, like stop and pause.',
  },
  {
    methods: ['POST'],
    pattern: '/api/sessions/:id/pin',
    source: 'session',
    reason: 'Exempts a transcript from retention. Touches no agent’s work.',
  },
];

/** The namespaces the safety net watches. */
export const LAUNCH_NAMESPACES: readonly string[] = ['/api/assignments', '/api/sessions'];

/** Methods that can change something. */
const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

function find(
  surfaces: readonly LaunchSurface[],
  method: string,
  path: string,
): LaunchSurface | undefined {
  return surfaces.find(
    (surface) => surface.methods.includes(method) && pathMatchesPattern(surface.pattern, path),
  );
}

/** True when `path` is inside one of the launch namespaces. */
export function inLaunchNamespace(path: string): boolean {
  return LAUNCH_NAMESPACES.some(
    (namespace) => path === namespace || path.startsWith(`${namespace}/`),
  );
}

/**
 * §6.2's rule, as a pure function over method and path.
 *
 * Pure because IMPLEMENTATION §8's criterion is "a test enumerates the live route
 * table and asserts every route that can start a session is gated", and a rule
 * that could only be exercised through a socket cannot be enumerated that way.
 */
export function classifyPath(method: string, path: string): RouteTier {
  if (find(RESTRAINING_SURFACES, method, path) !== undefined) return 'restrain';
  if (find(INITIATING_SURFACES, method, path) !== undefined) return 'initiate';
  if (find(NON_INITIATING_WRITES, method, path) !== undefined) return 'observe';
  // The safety net: an unclassified write inside a launch namespace is treated as
  // initiation, so a route added without a thought about D5 arrives gated.
  if (WRITE_METHODS.includes(method) && inLaunchNamespace(path)) return 'initiate';
  return 'observe';
}

/** The surface an initiating request matched, when the enumeration knows it. */
export function initiatingSurface(method: string, path: string): LaunchSurface | undefined {
  return find(INITIATING_SURFACES, method, path);
}

/** One agent named in a `409 remote_access_required` body (§6.3). */
export interface AgentRef {
  readonly agentId: string;
  readonly agentName: string | null;
}

export interface GateStores {
  readonly sessions: Pick<SessionsRepository, 'get'>;
  readonly assignments: Pick<AssignmentsRepository, 'listMembers'>;
  readonly agents: Pick<AgentsRepository, 'get'>;
}

export interface AgentsForRequest {
  /** Every agent the request would put to work, de-duplicated, in request order. */
  readonly agents: readonly AgentRef[];
  /**
   * True when the request is initiating but no agent could be resolved.
   *
   * Fail **closed**: an initiating route whose agents cannot be named is refused
   * rather than allowed, because "we could not tell whose grant to check" is not
   * a reason to skip checking one. The refusal is the same `409` with an empty
   * list, which the client renders as "this cannot be started remotely" and does
   * not retry into a loop.
   */
  readonly unresolved: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Which agents an initiating request would put to work.
 *
 * Read from the *request*, never from the handler's later interpretation of it,
 * because the gate has to answer before the handler runs — that is what makes
 * "creates no assignment and no session row" true of a refusal.
 */
export function agentsForRequest(
  input: {
    readonly method: string;
    readonly path: string;
    readonly params: Readonly<Record<string, string>>;
    readonly body: unknown;
  },
  stores: GateStores,
): AgentsForRequest {
  const surface = initiatingSurface(input.method, input.path);
  const ids: string[] = [];

  const pushFromBody = (): void => {
    const body = asRecord(input.body);
    if (body === undefined) return;
    const single = body['agentId'];
    if (typeof single === 'string' && single.length > 0) ids.push(single);
  };

  const pushMembers = (): void => {
    const body = asRecord(input.body);
    const members = body?.['members'];
    if (!Array.isArray(members)) return;
    for (const entry of members) {
      const member = asRecord(entry);
      const agentId = member?.['agentId'];
      if (typeof agentId === 'string' && agentId.length > 0) ids.push(agentId);
    }
  };

  const pushSession = (): void => {
    const sessionId = input.params['id'];
    if (sessionId === undefined || sessionId.length === 0) return;
    const session = stores.sessions.get(sessionId);
    if (session !== undefined) ids.push(session.agentId);
  };

  const pushAssignment = (): void => {
    const assignmentId = input.params['id'];
    if (assignmentId === undefined || assignmentId.length === 0) return;
    for (const member of stores.assignments.listMembers(assignmentId)) ids.push(member.agentId);
  };

  switch (surface?.source) {
    case 'body-agent':
      pushFromBody();
      break;
    case 'body-members':
      pushMembers();
      break;
    case 'session':
      pushSession();
      break;
    case 'assignment':
      pushAssignment();
      break;
    default:
      // The safety net matched but the enumeration has no entry, so nothing here
      // knows how to name the agents. Both body shapes are tried — they cover
      // every launch body in the inventory — and failing that the request is
      // refused as unresolved rather than waved through.
      pushFromBody();
      pushMembers();
      break;
  }

  const unique = [...new Set(ids)];
  return {
    agents: unique.map((agentId) => ({
      agentId,
      agentName: stores.agents.get(agentId)?.name ?? null,
    })),
    unresolved: unique.length === 0,
  };
}

/** Whether the request body opted into §6.3's grant-and-start-atomically path. */
export function wantsConfirm(body: unknown): boolean {
  return asRecord(body)?.[CONFIRM_FIELD] === true;
}
