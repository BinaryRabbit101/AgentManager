/**
 * The routes of §2.1, mounted with enough fixture data to be real.
 *
 * Shared by the axe audit, the keyboard walk and the cross-delivery suite, for
 * one reason: all three make claims about **every route**, and three separate
 * lists of routes would drift until one of them quietly stopped covering the
 * screen that broke.
 */

import {
  anAgent,
  aProject,
  BOOT_FACTS,
  json,
  mount,
  type MountOptions,
  type Responder,
} from './harness';
import { App } from '../src/App';
import { anAssignment, aConversation, PATTERNS } from '../src/assignments/fixtures';

export const ADA = anAgent({
  id: 'ada',
  name: 'Ada',
  tagline: 'Draws the shape before the code.',
  avatar: { kind: 'emoji', value: '📐' },
});
export const SAM = anAgent({
  id: 'sam',
  name: 'Sam',
  tagline: 'Finds the hole in it.',
  avatar: { kind: 'initials', value: 'SV', color: '#5a4a9c' },
});
export const LPM = aProject({ id: 'lpm', name: 'littlepocketmuseum' });

/** One library connector, with an unresolved credential — the badge case. */
export const SHARED_GMAIL = {
  id: 'shared-gmail',
  label: 'Gmail (work)',
  transport: 'stdio' as const,
  toolPrefix: 'mcp__shared-gmail__',
  auth: 'credentials' as const,
  credentials: [{ secretRef: 'mcp.shared-gmail.token', resolved: false }],
  usedBy: ['ada'],
  config: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gmail'],
    env: { GMAIL_TOKEN: { secretRef: 'mcp.shared-gmail.token' } },
  },
  meta: { createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
};

const SESSION = {
  session: {
    id: 'ses_1',
    assignmentId: 'asg_1',
    agentId: 'ada',
    projectId: 'lpm',
    status: 'running',
    sdkSessionId: null,
    model: 'claude',
    permissionMode: 'default',
    origin: 'local',
    transcriptPath: 'C:\\transcripts\\ses_1.jsonl',
    transcriptBytes: 120,
    summary: null,
    pinned: false,
    startedAt: '2026-08-17T09:00:00.000Z',
    endedAt: null,
    exitReason: null,
    role: 'implementer',
    resumedFrom: null,
    blockedReason: null,
    turns: 2,
  },
  usage: null,
  queuePosition: null,
};

const QUESTION = {
  id: 'q1',
  kind: 'question',
  status: 'open',
  prompt: 'Store transcripts in the DB or on disk?',
  options: [
    { id: 'disk', label: 'On disk' },
    { id: 'db', label: 'In SQLite' },
  ],
  multiSelect: false,
  allowFreeText: true,
  context: null,
  createdAt: '2026-08-17T09:00:00.000Z',
  holdUntil: null,
  expiresAt: '2026-08-18T09:00:00.000Z',
  assignmentId: 'asg_1',
  projectId: 'lpm',
  sessionId: 'ses_1',
  recommendations: [
    {
      agentId: 'sam',
      role: 'skeptic',
      stance: 'On disk',
      strength: 'blocking',
      rationale: 'A 500MB transcript blows the WAL.',
    },
  ],
  disagreement: true,
  contested: true,
  answeredVia: null,
  answeredAt: null,
  answer: null,
};

const QUEUE = {
  running: 1,
  queued: 0,
  blocked: 0,
  capacity: 3,
  usedWeight: 1,
  cooling: false,
  coolingUntil: null,
  entries: [
    {
      sessionId: 'ses_1',
      assignmentId: 'asg_1',
      agentId: 'ada',
      projectId: 'lpm',
      status: 'running',
      priority: 'normal',
      weight: 1,
      queuedAt: null,
      blockedReason: null,
      position: null,
    },
  ],
};

/** One standing schedule, mid-life: it has run, and it is armed to run again. */
const TRIGGER = {
  id: 'trg_1',
  projectId: 'lpm',
  templateId: 'todo-ticket-replies',
  agentIds: ['ada'],
  everyMinutes: 60,
  activeHours: { from: 8, to: 22 },
  enabled: true,
  variables: { source: 'the todo list' },
  maxRunsPerDay: 24,
  lastFiredAt: '2026-08-17T09:00:00.000Z',
  nextFireAt: '2026-08-17T10:00:00.000Z',
  consecutiveFailures: 0,
  lastOutcome: 'fired',
  lastOutcomeReason: null,
  lastOutcomeAt: '2026-08-17T09:00:00.000Z',
  lastRun: {
    assignmentId: 'asg_1',
    status: 'closed',
    phase: 'converged',
    closeReason: 'converged',
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  runsToday: 1,
  createdAt: '2026-08-16T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
};

const REMOTE_STATUS = {
  state: 'listening',
  enabled: true,
  boundAddress: { address: '100.64.0.7', port: 7478 },
  port: 7478,
  magicDnsName: 'workstation.example-tailnet.ts.net',
  tailscaleState: 'Running',
  lastError: null,
  recentBindFailures: 0,
  detectionSource: 'cli',
  mode: 'tailscale',
  clientUrl: 'http://workstation.example-tailnet.ts.net:7478',
  activeTokenCount: 1,
  deniedRemotely: [
    {
      method: 'POST',
      path: '/api/remote/tokens',
      source: 'declared',
      reason: 'Device tokens are created at the machine itself.',
      conditional: false,
    },
    {
      method: 'POST',
      path: '/api/remote/restart',
      source: 'declared',
      reason: 'Restarting the listener would cut this connection.',
      conditional: false,
    },
    {
      method: 'PUT',
      path: '/api/remote/enabled',
      source: 'backstop',
      reason: 'Remote access switches off from anywhere, on only at the machine.',
      conditional: true,
    },
  ],
  backstopPatterns: [{ methods: ['POST'], pattern: '/api/service/shutdown' }],
};

/** Every route's data, from one responder — the app is one app. */
export const RESPOND: Responder = (url, init) => {
  const path = url.split('?')[0] ?? url;
  if (init.method !== undefined && init.method !== 'GET') return json({ ok: true });
  switch (path) {
    case '/api/roster/agents':
      return json({ agents: [ADA, SAM], diagnostics: [] });
    case '/api/roster/agents/ada':
      return json(ADA);
    // roster §10.3's library (WO3). Read by `/connectors` and, for the attach
    // control, by every screen that mounts the agent editor.
    case '/api/roster/connectors':
      return json({ connectors: [SHARED_GMAIL], diagnostics: [] });
    case '/api/projects':
      return json({ projects: [LPM] });
    case '/api/projects/lpm':
      return json({
        ...LPM,
        defaults: { agentIds: ['ada'] },
        workspacePolicy: 'auto',
        retention: null,
      });
    case '/api/projects/lpm/activity':
      return json({ entries: [], total: 0, limit: 20, offset: 0 });
    case '/api/projects/lpm/work-items':
      return json({
        workItems: [
          {
            id: 'wi_1',
            projectId: 'lpm',
            kind: 'bug',
            title: 'The importer drops trailing commas',
            body: '',
            status: 'open',
            rank: 1,
            scopePaths: ['src/import'],
            source: 'user',
            createdAt: '2026-08-17T09:00:00.000Z',
            updatedAt: '2026-08-17T09:00:00.000Z',
            closedAt: null,
          },
        ],
      });
    case '/api/projects/lpm/workspaces':
      return json({ workspaces: [] });
    case '/api/sessions/ses_1':
      return json(SESSION);
    case '/api/sessions/ses_1/transcript':
      return json({ sessionId: 'ses_1', lines: [], from: 0, next: 0, size: 0, pruned: false });
    case '/api/sessions':
      return json({ sessions: [], next: null });
    case '/api/questions':
      return json({ questions: [QUESTION] });
    case '/api/questions/q1':
      return json(QUESTION);
    case '/api/orchestrator/status':
      return json({
        agents: [],
        assignments: { open: 1, halted: 0, awaitingUser: 0 },
        questions: { open: 1, oldestOpenedAt: '2026-08-17T09:00:00.000Z' },
      });
    case '/api/assignments':
      return json({ assignments: [anAssignment({ status: 'open', phase: 'running' })] });
    case '/api/assignments/asg_1':
      return json(anAssignment());
    case '/api/assignments/asg_1/conversation':
      return json(aConversation());
    case '/api/patterns':
      return json(PATTERNS);
    // §13's standing schedules (WO8). One fixture serves both placements: the
    // project page filters by `?projectId=` and the query string is stripped
    // above, so settings → Automation sees the same row.
    case '/api/triggers':
      return json({ triggers: [TRIGGER] });
    case '/api/runner/queue':
      return json(QUEUE);
    case '/api/runner/usage':
      return json({
        own: {
          window5h: {
            since: '2026-08-17T07:00:00.000Z',
            inputTokens: 1,
            outputTokens: 1,
            sessions: 1,
          },
          window7d: {
            since: '2026-08-10T12:00:00.000Z',
            inputTokens: 2,
            outputTokens: 2,
            sessions: 2,
          },
          source: 'local-estimate',
        },
        rateLimit: { state: 'ok', lastHitAt: null, resetsAt: null, source: 'observed' },
        disclaimer: 'Counts AgentManager sessions only.',
      });
    case '/api/remote/status':
      return json(REMOTE_STATUS);
    case '/api/remote/tokens':
      return json({
        tokens: [
          {
            id: 'tok_1',
            label: 'Pixel',
            device: null,
            prefix: 'abc123',
            createdAt: '2026-05-01T00:00:00.000Z',
            lastUsedAt: null,
            lastUsedPeer: null,
            expiresAt: null,
            revokedAt: null,
            expired: false,
          },
        ],
      });
    case '/api/remote/agents':
      return json({
        agents: [
          {
            agentId: 'ada',
            agentName: 'Ada',
            enabled: true,
            grantedAt: '2026-08-17T09:00:00.000Z',
            expiresAt: '2026-08-20T09:00:00.000Z',
            grantedVia: 'local',
            tokenId: 'tok_1',
          },
        ],
      });
    case '/api/logs':
      return json({
        records: [],
        count: 0,
        source: 'ring',
        level: 'info',
        ringSize: 0,
        ringCapacity: 500,
      });
    default:
      if (path.endsWith('/avatar')) return new Response(new Blob(['png']), { status: 200 });
      return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  }
};

/**
 * §2.1's routes, with the settling text that says the screen is drawn.
 *
 * `/` is home (§2.4) and `/agents` is the board it used to be — the two entries
 * are separate here because the audits make claims about *every* screen, and
 * folding them into one would drop whichever of the two lost the argument.
 */
export const ROUTES: readonly { readonly path: string; readonly settled: string | RegExp }[] = [
  { path: '/', settled: /Store transcripts/u },
  { path: '/agents', settled: 'Ada' },
  { path: '/agents/new', settled: /New agent|Describe/u },
  { path: '/agents/ada', settled: 'Sessions' },
  { path: '/connectors', settled: 'Gmail (work)' },
  { path: '/projects', settled: 'littlepocketmuseum' },
  { path: '/projects/lpm', settled: 'littlepocketmuseum' },
  { path: '/sessions', settled: 'Sessions' },
  { path: '/sessions/ses_1', settled: 'Session' },
  { path: '/assignments', settled: 'Assignments' },
  { path: '/assignments/asg_1', settled: 'Move transcripts off the hot path' },
  { path: '/questions', settled: /Store transcripts/u },
  { path: '/questions/q1', settled: /Store transcripts/u },
  { path: '/usage', settled: 'Usage' },
  { path: '/settings', settled: 'Settings' },
];

/**
 * The home edition with **every** module loaded — the widest surface to audit.
 *
 * The remote module is included deliberately: §13.4's disabled-with-a-reason
 * controls are the ones most likely to fail an accessibility audit (a disabled
 * control still needs a name and an explanation), so the audit must see them.
 */
export const REMOTE_BOOT: NonNullable<MountOptions['boot']> = {
  config: BOOT_FACTS.config,
  health: {
    ...BOOT_FACTS.health,
    modules: [...BOOT_FACTS.health.modules, { id: 'remote', status: 'ok' as const }],
  },
};

export function mountAt(path: string, options: MountOptions = {}): ReturnType<typeof mount> {
  return mount(<App />, { respond: RESPOND, route: path, boot: REMOTE_BOOT, ...options });
}
