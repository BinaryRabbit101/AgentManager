/**
 * The runner element's public surface (runner DESIGN §11).
 *
 * `src/main.ts` reaches for {@link createRunnerModule}; everything else another
 * element needs arrives through the service registry under
 * {@link RUNNER_SERVICE}, never through an import of this package (foundation
 * §6.1). The types are exported because a consumer has to be able to *name*
 * what the registry hands it.
 */
export {
  AGENT_ENV_NULL_DEFAULTS,
  resolveAgentEnv,
  type AgentEnvPaths,
  type ResolveAgentEnvOptions,
} from './agentEnv.js';
export {
  createAssignmentContextStub,
  resolveAssignmentContextProvider,
  type AssignmentContextStubDeps,
} from './assignmentContext.js';
export {
  attachAuthEnv,
  BASE_URL_ENV,
  CLAUDE_OAUTH_SECRET_KEY,
  OAUTH_TOKEN_ENV,
  STRIPPED_CREDENTIAL_ENV,
  type AttachAuthEnvDeps,
  type AuthMode,
} from './attachAuthEnv.js';
export {
  budgetAllowsResume,
  budgetCrossing,
  budgetHaltPrompt,
  BUDGET_HALT_OPTIONS,
  type BudgetCrossing,
  type BudgetSubject,
} from './budget.js';
export {
  emitRunnerEvent,
  EVENT_PERSIST,
  persistsEvent,
  preview,
  PREVIEW_MAX_LENGTH,
  RUNNER_EVENT_TYPES,
  SESSION_EVENT_TYPES,
  type SessionEventSubject,
} from './events.js';
export {
  createRecovery,
  encodeCwd,
  nodeRecoveryFs,
  type BootReconciliation,
  type Interruption,
  type Recovery,
  type RecoveryDeps,
  type RecoveryFs,
  type Resumability,
} from './recovery.js';
export {
  ALLOW_ONCE_OPTION,
  createDefaultDenyCanUseTool,
  createQuestionCanUseTool,
  DENY_OPTION,
  readAskUserQuestion,
  type DefaultDenyDeps,
  type QuestionCanUseToolDeps,
  type RaisedQuestion,
  type SettledQuestion,
} from './canUseTool.js';
export {
  DEFAULT_TAIL_BYTES,
  MAX_CONCURRENT_LIMIT,
  RUNNER_CONFIG_DEFAULTS,
  runnerConfigSchema,
  type RunnerConfig,
} from './config.js';
export {
  hasQuestionBridge,
  isWorkspaceRefusal,
  type AcquireWorkspaceResultView,
  type AskQuestionRequest,
  type QuestionAnswerView,
  type QuestionBridgeProvider,
  type QuestionBridgeView,
  type QuestionKindView,
  type QuestionOptionView,
  type QuestionOutcomeView,
  type AssignmentCompileContext,
  type AssignmentContext,
  type AssignmentContextProvider,
  type AssignmentScopeRules,
  type CanUseToolPolicyView,
  type CompileDiagnostic,
  type CompileSessionRequest,
  type CompiledSession,
  type EffectivePermissionsView,
  type EnvEntryView,
  type LaunchContextView,
  type ProjectCompileContext,
  type ProjectsProvider,
  type RosterAgent,
  type RosterProvider,
  type SdkOptions,
  type WorkspaceLeaseView,
  type WorkspaceRefusalView,
} from './contracts.js';
export {
  AgentUnavailableError,
  AssignmentClosedError,
  AssignmentNotFoundError,
  DuplicateSessionInputError,
  InvalidExitReasonError,
  InvalidRequestError,
  InvalidTransitionError,
  isLaunchFailure,
  LaunchCompileError,
  LaunchUnavailableError,
  MissingExitReasonError,
  OptionWhitelistError,
  ProjectNotLaunchableError,
  ProviderUnavailableError,
  QueueFullError,
  RunnerError,
  SecretUnresolvedError,
  SessionControlRefusedError,
  SessionExecutionError,
  SessionNotFoundError,
  SessionNotResumableError,
  SessionStartTimeoutError,
  WorkspaceUnavailableError,
  type LaunchFailure,
} from './errors.js';
export {
  createInputQueue,
  type ImageAttachment,
  type InputQueueOptions,
  type PushOptions,
  type SessionInputQueue,
} from './inputQueue.js';
export {
  ASK_USER_QUESTION_TOOL,
  answerMessage,
  createQuestionBridgeClient,
  createQuestionSessions,
  describeAnswer,
  installShadowWarningFilter,
  openQuestionFor,
  outcomeOf,
  parkMessage,
  questionBridgeStatus,
  questionFor,
  SHADOW_WARNING_CODE,
  type BootQuestionReconciliation,
  type QuestionBridgeClient,
  type QuestionBridgeClientDeps,
  type QuestionBridgeDiagnosis,
  type QuestionBridgeMode,
  type QuestionBridgeStatus,
  type QuestionSessions,
  type QuestionSessionsDeps,
} from './questionBridge.js';
export {
  createLaunchChain,
  RESUME_CONTINUATION,
  type ContinueOptions,
  type LaunchChain,
  type LaunchChainDeps,
  type LogSink,
  type ResumeOptions,
  type SessionControlResult,
  type StartSessionRequest,
  type StartSessionResult,
  type SteerOptions,
  type SteerResult,
} from './launch.js';
export { createLeaseBook, type LeaseBook, type LeaseBookDeps } from './leases.js';
export {
  createLiveSessions,
  INTERRUPT_RECEIPT_CAPABILITY,
  readStillQueued,
  windDown,
  type ControlIntent,
  type InterruptReceipt,
  type LiveSession,
  type LiveSessionInit,
  type LiveSessions,
  type WindDownOptions,
  type WindDownOutcome,
} from './liveSessions.js';
export {
  isInitMessage,
  outcomeForResult,
  readAssistant,
  readInitFacts,
  readResult,
  readStreamDelta,
  readUser,
  type AssistantParts,
  type InitFacts,
  type ResultFacts,
  type ResultOutcome,
  type ToolResultLine,
  type ToolUseLine,
  type UserParts,
} from './messages.js';
export {
  assertOptionsWhitelisted,
  diffOptionPaths,
  STRIPPABLE_OPTION_PATHS,
  WHITELISTED_OPTION_PATHS,
} from './optionGuard.js';
export {
  runReaderLoop,
  type GuardReason,
  type ReaderLoopDeps,
  type ReaderLoopOutcome,
} from './readerLoop.js';
export { isReplayMessage, realQuery, type QueryFn, type SdkSession } from './sdk.js';
export {
  createRunnerModule,
  RUNNER_MODULE_ID,
  RUNNER_SERVICE,
  type RunnerInternals,
  type RunnerModuleOptions,
} from './module.js';
export {
  createSessionRepository,
  type EnqueueSessionInput,
  type ListSessionsQuery,
  type RunnerSessionPatch,
  type RunnerSessionRecord,
  type SessionInputRecord,
  type SessionPriority,
  type SessionRepository,
  type TransitionRequest,
} from './repository.js';
export { createRunnerRoutes, type RunnerRoutesDeps } from './routes.js';
export {
  createRunnerService,
  type RunnerService,
  type RunnerServiceOptions,
  type SessionAffordances,
  type SessionDetail,
} from './service.js';
export {
  assertTransition,
  EXIT_REASONS,
  findTransition,
  isExitReason,
  isTransitionAllowed,
  requiresExitReason,
  SESSION_STATUSES,
  SESSION_TRANSITIONS,
  TERMINAL_STATUSES,
  type ExitReason,
  type SessionTransition,
  type TransitionOptions,
} from './status.js';
export {
  ASSISTANT_MAX_LENGTH,
  composeSummary,
  outcomeWord,
  PROMPT_MAX_LENGTH,
  SUMMARY_MAX_LENGTH,
  truncate,
  type SummaryParts,
} from './summary.js';
export {
  createTranscriptFactory,
  lastSeqOf,
  TRANSCRIPT_LINE_TYPES,
  type OpenTranscriptOptions,
  type SessionTranscript,
  type TranscriptEntryBody,
  type TranscriptFactory,
  type TranscriptLine,
  type TranscriptLineType,
} from './transcript.js';
export {
  createTranscriptReader,
  nodeFileIo,
  type FileIo,
  type ReadForwardOptions,
  type ReadTailOptions,
  type TranscriptPage,
  type TranscriptReader,
} from './transcriptReader.js';
