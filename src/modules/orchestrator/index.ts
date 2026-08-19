/**
 * The orchestrator element's public surface.
 *
 * The composition root imports {@link createOrchestratorModule}; every other
 * element reaches this one through `ctx.require('orchestrator')` and the types
 * below, never through a direct import (foundation §6.1).
 */
export {
  createOrchestratorModule,
  ORCHESTRATOR_MODULE_ID,
  ORCHESTRATOR_SERVICE,
  type OrchestratorInternals,
  type OrchestratorModuleOptions,
} from './module.js';

export {
  ORCHESTRATOR_CONFIG_DEFAULTS,
  orchestratorConfigSchema,
  type OrchestratorConfig,
} from './config.js';

/** §8.1's counters (M7). Pure, and shared by the engine and the patterns. */
export { BREAKER_NAMES, evaluateBreakers, type BreakerName, type BreakerTrip } from './breakers.js';

/** §7's policy (M3): what the halt card offers and what each answer does. */
export {
  applyBudgetCardPolicy,
  createBudgetPolicy,
  BUDGET_HALT_OPTIONS,
  BUDGET_RAISE_GATE,
  type BudgetDecision,
  type BudgetPolicy,
} from './budgets.js';

/** §8.2's gates, and the one way an engine-authored card is raised. */
export { raiseCard, GATE_CARD_PREFIX, GATE_OPTIONS, type CardSpec } from './cards.js';

/** §10's push channel (M8). */
export {
  createNotifier,
  realNotifyTimers,
  type Notifier,
  type NotifyResult,
  type NotifyTimers,
} from './notify.js';

/** §11.3's fleet view (M9), and §16-6's six-word vocabulary. */
export {
  createFleetStatusReader,
  FLEET_STATES,
  type AgentStatus,
  type FleetState,
  type FleetStatus,
} from './status.js';

export {
  AssignmentClosedError,
  AssignmentNotFoundError,
  AssignmentRefusedError,
  DependencyUnavailableError,
  InvalidRequestError,
  OrchestratorError,
  RunnerUnavailableError,
  REFUSAL_CODES,
  type Refusal,
  type RefusalCode,
} from './errors.js';

export {
  createQuestionInbox,
  isQuestionStrength,
  normalisePrompt,
  QUESTION_STRENGTHS,
  QuestionNotFoundError,
  QuestionNotOpenError,
  strengthRank,
  type AnswerQuestionInput,
  type AskRequest,
  type ExpirySweepResult,
  type ListQuestionsQuery,
  type QuestionAnswer,
  type QuestionBridge,
  type QuestionCard,
  type QuestionInbox,
  type QuestionInboxOptions,
  type QuestionOption,
  type QuestionOutcome,
  type QuestionStrength,
  type RecommendationInput,
  type RecommendationView,
} from './questions.js';
export { createQuestionRoutes, type QuestionRoutesDeps } from './questionRoutes.js';

// --- M5/M6: the pattern engine and the adversarial pair --------------------

export {
  cardSeatOrder,
  isConverged,
  patternFor,
  seatsOf,
  CRITIC_SEAT,
  DRAFTER_SEAT,
  HALT_REASONS,
  PAIR_PATTERN,
  PATTERNS,
  SOLO_PATTERN,
  type AssignmentState,
  type BreakerCounters,
  type HaltReason,
  type PatternConfig,
  type PatternDef,
  type PatternSummary,
  type PlanResult,
  type PromptSpec,
  type SeatDef,
  type Termination,
  type TurnPlan,
} from './patterns.js';
export {
  createPatternEngine,
  ROUND_CAP_CARD,
  ROUND_CAP_OPTIONS,
  type AdvanceOutcome,
  type PatternEngine,
  type PatternEngineOptions,
  type TurnReconciliation,
} from './engine.js';
export { createEngineRoutes, type EngineRoutesDeps } from './engineRoutes.js';
export {
  createTurnRepository,
  TurnAlreadyActiveError,
  TURN_STATUSES,
  type BlockingIssue,
  type TurnReport,
  type TurnRepository,
  type TurnRow,
  type TurnStatus,
  type TurnVerdict,
} from './turns.js';
export {
  createMailboxRepository,
  MESSAGE_KINDS,
  type Delivery,
  type InlinedMail,
  type MailboxRepository,
  type MessageKind,
  type MessageView,
} from './messages.js';
export {
  createToolsetFactory,
  TOOLSET_SERVER_KEY,
  OVERSEER_TOOL_NAMES,
  WORKER_TOOL_NAMES,
  type LaunchIdentity,
  type SessionToolset,
  type ToolRefusalCode,
  type ToolResult,
  type ToolsetFactory,
} from './toolset.js';
export {
  TOOLING_GUARDRAIL,
  composePrompt,
  type ComposedPrompt,
  type ComposePromptInput,
} from './prompt.js';
export {
  createConversationReader,
  type ConversationEntry,
  type ConversationRound,
  type ConversationView,
} from './conversation.js';
export { createAssignmentRepository, type AssignmentRepository } from './repository.js';
export { createAssignmentService, type AssignmentServiceOptions } from './service.js';
export { createAssignmentRoutes } from './routes.js';
export { emitScopeRules, normaliseScopePath } from './scopeRules.js';
export {
  isMachineCreated,
  validateCreateAssignment,
  type AgentFacts,
  type ParentFacts,
  type ProjectFacts,
  type ValidationInput,
  type ValidationResult,
  type WorkItemFacts,
} from './validate.js';

export type {
  AssignmentContext,
  AssignmentPatch,
  AssignmentPhase,
  AssignmentRole,
  AssignmentScope,
  AssignmentService,
  AssignmentView,
  AssignmentWarning,
  BootReconciliation,
  CloseReason,
  CreateAssignmentRequest,
  CreateAssignmentResult,
  CreateSoloRequest,
  CreateSoloResult,
  ListAssignmentsQuery,
  ScopeRules,
} from './types.js';

export type {
  OverseerRosterEntryPort,
  ProjectsPort,
  RosterPort,
  RunnerPort,
  SessionContinuation,
  SessionLauncher,
  StartSessionRequest,
  StartSessionResult,
  TranscriptTailReader,
  WorkItemLinker,
} from './ports.js';
