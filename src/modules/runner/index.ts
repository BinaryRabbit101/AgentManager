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
  DEFAULT_TAIL_BYTES,
  MAX_CONCURRENT_LIMIT,
  RUNNER_CONFIG_DEFAULTS,
  runnerConfigSchema,
  type RunnerConfig,
} from './config.js';
export {
  DuplicateSessionInputError,
  InvalidExitReasonError,
  InvalidRequestError,
  InvalidTransitionError,
  MissingExitReasonError,
  RunnerError,
  SessionNotFoundError,
} from './errors.js';
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
export { createRunnerService, type RunnerService, type RunnerServiceOptions } from './service.js';
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
