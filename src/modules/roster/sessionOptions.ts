/**
 * The vocabulary of `compileSession` (roster DESIGN.md §13) — the contract the
 * runner consumes, and the one place in the system where SDK option shapes are
 * allowed to appear (§13; the SDK type is re-exported through
 * {@link ClaudeAgentSdkOptions} so no other element ever imports the package).
 *
 * Two seams are flagged here rather than papered over:
 *
 * - **`ResolvedAgent`** (§2.3, §13) is M2's type and does not exist yet.
 *   {@link CompilableAgent} is the subset the compiler actually needs, stated
 *   structurally so M2's `ResolvedAgent` satisfies it without a conversion.
 *   *Consolidate when M2 lands.*
 * - **`agentEnv` nulls.** Foundation's config declares
 *   `agentEnv: Record<string, string | null>` where `null` means "compute the
 *   default" (`config/schema.ts`, e.g. `CLAUDE_CONFIG_DIR` →
 *   `<dataRoot>/state/claude-config`). Nothing in foundation resolves those
 *   nulls yet, and computing a data-root-relative path is not roster's job, so
 *   {@link CompileSessionInput.agentEnv} takes an already-resolved record and
 *   the composition root owes it. *Flagged for foundation.*
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { SecretResolver } from '../../secrets/index.js';

import type { Diagnostic, EffectivePermissions } from './contracts.js';
import type { EnvEntry } from './envMerge.js';
import type { PersonaComposition } from './persona.js';
import type { CanUseToolPolicy, PermissionPolicy, RawPermissionSet } from './permissions.js';
import type { AgentDefinition, Role } from './schema.js';

/** §13's `ClaudeAgentSdkOptions` — the object handed to `query()`. */
export type ClaudeAgentSdkOptions = Options;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * What the compiler needs to know about an agent.
 *
 * The definition plus the prose the definition points at: §4's persona body and
 * role addenda are files in the agent folder, and reading files is the store's
 * job (M2), not the compiler's — `compileSession` stays a pure function of its
 * inputs so the table tests can drive it without a filesystem.
 */
export interface CompilableAgent {
  readonly definition: AgentDefinition;
  /** `persona.md`, verbatim. Empty when the agent has no persona file. */
  readonly persona: string;
  /** `roles/<role>.md` bodies by role; only the assignment's role is read. */
  readonly roleAddenda?: Readonly<Partial<Record<Role, string>>> | undefined;
  /** Absolute path to the agent folder — M5's `plugins: [{ type: 'local' }]` root. */
  readonly directory?: string | undefined;
}

/** §13's `ProjectContext` — raw input, never a computed result. */
export interface ProjectContext {
  readonly projectId: string;
  /** The leased workspace root, not necessarily `project.localPath`. */
  readonly cwd: string;
  /** allow / deny / ask / mode in roster's vocabulary, uncomposed. */
  readonly permissionOverride?: RawPermissionSet | undefined;
  /** The §6.2 escape hatch, gated by `policy.allowPermissionElevation`. */
  readonly elevation?: { readonly allow: readonly string[]; readonly reason: string } | undefined;
  /** Literal values and secretRefs, already ordered by projects. */
  readonly env?: readonly EnvEntry[] | undefined;
  /** Resolved project brief text → §4's fourth slot. Not the repo's `CLAUDE.md`. */
  readonly instructions?: string | undefined;
  readonly workspace?:
    | {
        readonly kind: 'primary' | 'worktree';
        readonly path: string;
        readonly branch: string | null;
      }
    | undefined;
}

/** §13's `AssignmentContext`, in runner §15.1-3's shape. Always present: D4
 *  makes every session belong to an assignment, solo included. */
export interface AssignmentContext {
  readonly id: string;
  /** The seat's role → §4's `roles/<role>.md` addendum. */
  readonly role?: Role | undefined;
  /** `false` ⇒ the compiler adds the §6.2 mutating-tool deny. */
  readonly write: boolean;
  /** Raw rules, composed as the assignment layer (§6.2). */
  readonly scopeRules?: RawPermissionSet | undefined;
  /** Assignment-scoped environment, last in the §13 merge order. */
  readonly env?: readonly EnvEntry[] | undefined;
  /** Carried for orchestrator's own accounting; the compiler reads neither. */
  readonly tokenBudget?: number | null | undefined;
  readonly tokensUsed?: number | undefined;
  readonly roundCap?: number | null | undefined;
  readonly roundsUsed?: number | undefined;
}

export interface CompileSessionInput {
  readonly agent: CompilableAgent;
  readonly project?: ProjectContext | undefined;
  readonly assignment: AssignmentContext;
  /** Foundation's `policy` namespace (§6.2's two out-of-band inputs). */
  readonly policy: PermissionPolicy;
  /** Foundation's `agentEnv`, with every `null` already resolved — see the
   *  module note. Second in the §13 merge order. */
  readonly agentEnv?: Readonly<Record<string, string>> | undefined;
  /** The environment to spread first. Defaults to `process.env`; injectable so
   *  the `PATH` regression guard is not a test of the host machine. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>> | undefined;
  /** Foundation's `runner.defaultModel`, used when the definition names none. */
  readonly defaultModel?: string | undefined;
  /** The §3.2 read-only face. `.reveal()` is called here and in runner's
   *  `attachAuthEnv()` — nowhere else in the system. */
  readonly secrets: SecretResolver;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** §13's return shape, plus the two things the runner would otherwise re-derive:
 *  the default-deny policy it must implement, and the composed system prompt. */
export interface CompiledSession {
  readonly options: ClaudeAgentSdkOptions;
  /** For display and audit (§9.1: composition the user cannot see is
   *  composition they will not trust). */
  readonly effective: EffectivePermissions;
  /** §6.1's default-deny policy — the runner installs the callback, not roster. */
  readonly policy: CanUseToolPolicy;
  readonly systemPrompt: PersonaComposition;
  readonly diagnostics: readonly Diagnostic[];
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/**
 * A launch that must not start.
 *
 * The one case in M4 is an unresolved `secretRef` (§10: "an unresolved ref fails
 * the launch with a clear 'agent Priya needs secret `mcp.gmail.token`' error
 * rather than starting a session whose tools will silently 401"). It is an
 * exception rather than an `error` diagnostic because a diagnostic is something
 * the caller may choose to ignore, and this is not.
 *
 * Sibling to `RosterValidationError` (`errors.ts`) in shape and intent; kept in
 * this file because `errors.ts` is M1's and M2/M3 are editing it concurrently.
 * *Consolidate into `errors.ts` after the M2/M3 merge.*
 */
export class SessionCompileError extends Error {
  override readonly name = 'SessionCompileError';
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[] = []) {
    super(message);
    this.diagnostics = diagnostics;
  }
}
