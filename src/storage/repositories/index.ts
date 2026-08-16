/**
 * The `Store` aggregate — what `ctx.store` is (DESIGN §1.3, §6.1).
 *
 * "All writes go through the `Store` module. Feature modules receive
 * **repository objects** (`ctx.store.sessions`, `ctx.store.questions`, …), not
 * the raw handle. No feature module composes SQL against another element's
 * tables; cross-element reads go through the owning repository. The
 * foundation-shipped repositories **are** the sanctioned cross-element read
 * path — an element needing another element's data calls a repository method
 * (adding one if it does not exist yet), never a hand-written join against a
 * foreign table."
 *
 * The absence of a `db` property is therefore the point of this type, not an
 * oversight: there is no supported way for a feature module to reach the handle
 * through its context.
 */
import type { Database } from '../sqlite.js';
import { systemClock, type Clock } from '../time.js';
import { createTranscriptStore, type TranscriptStore } from '../transcripts.js';

import { createAgentsRepository, type AgentsRepository } from './agents.js';
import { createAssignmentsRepository, type AssignmentsRepository } from './assignments.js';
import { createEventsRepository, type EventsRepository } from './events.js';
import { createMessagesRepository, type MessagesRepository } from './messages.js';
import { createProjectsRepository, type ProjectsRepository } from './projects.js';
import { createQuestionsRepository, type QuestionsRepository } from './questions.js';
import { createRemoteTokensRepository, type RemoteTokensRepository } from './remoteTokens.js';
import { createSessionsRepository, type SessionsRepository } from './sessions.js';
import { createSettingsRepository, type SettingsRepository } from './settings.js';
import { createUsageRepository, type UsageRepository } from './usage.js';

export interface Store {
  readonly agents: AgentsRepository;
  readonly projects: ProjectsRepository;
  readonly assignments: AssignmentsRepository;
  readonly sessions: SessionsRepository;
  readonly usage: UsageRepository;
  readonly messages: MessagesRepository;
  readonly questions: QuestionsRepository;
  readonly events: EventsRepository;
  readonly settings: SettingsRepository;
  readonly remoteTokens: RemoteTokensRepository;
  /** The transcript layout, writer and tailing reader (§1.5). */
  readonly transcripts: TranscriptStore;
  /**
   * Runs `fn` inside one SQLite transaction.
   *
   * For the case a single repository method cannot express: two repositories
   * that must commit together. Nested calls are safe — better-sqlite3 uses
   * savepoints — so a repository method that is itself transactional composes
   * inside this without deadlocking.
   */
  transaction<T>(fn: () => T): T;
}

export interface CreateStoreOptions {
  readonly db: Database;
  /** `<dataRoot>/state/transcripts` — the transcript root of §1.5. */
  readonly transcriptsRoot: string;
  /** Injectable, so tests are not time-dependent (§6.1). */
  readonly clock?: Clock;
  readonly transcripts?: {
    readonly fsyncEveryLines?: number;
    readonly fsyncIntervalMs?: number;
  };
}

export function createStore(options: CreateStoreOptions): Store {
  const { db } = options;
  const clock = options.clock ?? systemClock;
  const sessions = createSessionsRepository(db, clock);

  const transcripts = createTranscriptStore({
    root: options.transcriptsRoot,
    sessions,
    clock,
    ...(options.transcripts?.fsyncEveryLines === undefined
      ? {}
      : { fsyncEveryLines: options.transcripts.fsyncEveryLines }),
    ...(options.transcripts?.fsyncIntervalMs === undefined
      ? {}
      : { fsyncIntervalMs: options.transcripts.fsyncIntervalMs }),
  });

  return {
    agents: createAgentsRepository(db, clock),
    projects: createProjectsRepository(db, clock),
    assignments: createAssignmentsRepository(db, clock),
    sessions,
    usage: createUsageRepository(db, clock),
    messages: createMessagesRepository(db, clock),
    questions: createQuestionsRepository(db, clock),
    events: createEventsRepository(db, clock),
    settings: createSettingsRepository(db, clock),
    remoteTokens: createRemoteTokensRepository(db, clock),
    transcripts,
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  };
}

export type { AgentInput, AgentRecord, AgentsRepository, ListAgentsOptions } from './agents.js';
export type {
  AssignmentInput,
  AssignmentMember,
  AssignmentMemberInput,
  AssignmentPattern,
  AssignmentRecord,
  AssignmentRole,
  AssignmentStatus,
  AssignmentsRepository,
  ListAssignmentsOptions,
} from './assignments.js';
export type {
  EventInput,
  EventPruneResult,
  EventQuery,
  EventRecord,
  EventRetention,
  EventsRepository,
} from './events.js';
export type {
  MailboxOptions,
  MessageInput,
  MessageRecord,
  MessagesRepository,
} from './messages.js';
export type {
  ListProjectsOptions,
  ProjectInput,
  ProjectPatch,
  ProjectRecord,
  ProjectsRepository,
} from './projects.js';
export type {
  AnswerInput,
  AnsweredVia,
  QuestionInput,
  QuestionKind,
  QuestionRecommendation,
  QuestionRecord,
  QuestionStatus,
  QuestionsRepository,
  RecommendationInput,
} from './questions.js';
export type {
  RemoteTokenInput,
  RemoteTokenRecord,
  RemoteTokensRepository,
} from './remoteTokens.js';
export type {
  ListSessionsFilter,
  SessionInput,
  SessionOrigin,
  SessionPatch,
  SessionRecord,
  SessionStatus,
  SessionsRepository,
} from './sessions.js';
export type { SettingRecord, SettingsRepository } from './settings.js';
export type { UsageDelta, UsageEvent, UsageRepository, UsageTotals } from './usage.js';
