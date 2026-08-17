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
  ProjectsPort,
  RosterPort,
  RunnerPort,
  SessionLauncher,
  StartSessionRequest,
  StartSessionResult,
  WorkItemLinker,
} from './ports.js';
