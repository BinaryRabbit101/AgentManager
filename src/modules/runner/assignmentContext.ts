/**
 * `getAssignmentContext` (runner DESIGN §3.1 step 3) — the registry lookup and
 * the stub behind it.
 *
 * Orchestrator owns this call (runner §15.1-3, orchestrator §2.3) and publishes
 * it on the `orchestrator` service. Runner M3 lands before that, so the launch
 * chain resolves the provider like this:
 *
 * ```
 * ctx.require('orchestrator')?.getAssignmentContext   ??   this stub
 * ```
 *
 * and the integration is therefore a **registry lookup, not a code change**:
 * when orchestrator's module starts providing the method, the stub stops being
 * reached and nothing in the launch chain moves.
 *
 * ## What the stub may and may not do
 *
 * It reads the `assignments` row through **foundation's repository**, which is
 * the sanctioned cross-element path (foundation §1.3; the same door §5.2 uses
 * for the questions fallback). It never writes one: D9 is explicit that runner
 * does not mint assignments, and a stub that created its own precondition would
 * be exactly the boundary violation the decision forbids. A `startSession`
 * against an id nothing created still fails at admission.
 *
 * Two fields the row cannot answer, and the honest values for them:
 *
 * - **`write`** is an assignment property orchestrator stores per assignment;
 *   foundation's `assignments` table has no column for it. The stub answers
 *   `true`, which is orchestrator's own documented default for the solo pattern
 *   (orchestrator §2.3) and the only value under which the workspace lease
 *   behaves as a real launch would. A read-only assignment is therefore
 *   *unrepresentable* until orchestrator provides the real context — stated
 *   here rather than hidden, because a stub that silently answered `false`
 *   would make roster compile a mutating-tool deny nobody asked for.
 * - **`scopeRules`** is `{}` — no scope restriction, orchestrator's solo
 *   default. The stub does not invent rule strings; runner does not read them
 *   either way (§15.1-3: "runner passes them through untouched").
 */
import type { AssignmentsRepository } from '../../storage/index.js';

import type { AssignmentContext, AssignmentContextProvider } from './contracts.js';
import { AssignmentNotFoundError } from './errors.js';

export interface AssignmentContextStubDeps {
  /** Foundation's repository. The stub reads; it never writes. */
  readonly assignments: Pick<AssignmentsRepository, 'get' | 'listMembers'>;
}

/**
 * The fallback implementation of orchestrator's contract.
 *
 * Everything it returns is derived from the persisted row, so a session
 * launched through it carries the same budget and round figures the real
 * provider would report for an assignment in that state.
 */
export function createAssignmentContextStub(
  deps: AssignmentContextStubDeps,
): AssignmentContextProvider {
  return {
    getAssignmentContext(assignmentId: string): Promise<AssignmentContext> {
      return Promise.resolve().then(() => {
        const row = deps.assignments.get(assignmentId);
        if (row === undefined) throw new AssignmentNotFoundError(assignmentId);

        // The seat's role, when the assignment has exactly one member: with more
        // than one, "the role of the member the session is for" is a question
        // only orchestrator can answer, and `startSession`'s own `role` is the
        // caller's answer to it.
        const members = deps.assignments.listMembers(assignmentId);
        const soleRole = members.length === 1 ? members[0]?.role : undefined;

        return {
          id: row.id,
          pattern: row.pattern,
          status: row.status === 'closed' ? 'closed' : 'open',
          ...(soleRole === undefined ? {} : { role: soleRole }),
          write: true,
          scopeRules: {},
          tokenBudget: row.tokenBudget,
          tokensUsed: row.tokensUsed,
          roundCap: row.roundCap,
          roundsUsed: row.roundsUsed,
          // A third field the row cannot answer: pre-grants live in an
          // orchestrator-owned column this stub deliberately does not read,
          // because reading another element's column through foundation's
          // generic repository is exactly the boundary the header refuses. No
          // pre-grants means every gate asks, which is the behaviour every
          // session had before the column existed.
          preGrantedTools: [],
          // The base row has no artifact column either; it is orchestrator's own.
          artifactPath: null,
        };
      });
    },
  };
}

/**
 * The §11.3 lookup: orchestrator's real provider when it is on the registry,
 * the stub when it is not.
 *
 * A provider object that exists but does not carry the method is treated as
 * absent — an orchestrator build that has not reached its M1 is exactly the
 * case this milestone was written for, and a `TypeError` at launch would be a
 * worse answer than the stub.
 */
export function resolveAssignmentContextProvider(
  fromRegistry: Partial<AssignmentContextProvider> | undefined,
  fallback: AssignmentContextProvider,
): AssignmentContextProvider {
  const provided = fromRegistry?.getAssignmentContext;
  if (typeof provided !== 'function') return fallback;
  return {
    getAssignmentContext: (assignmentId, options) =>
      provided.call(fromRegistry, assignmentId, options),
  };
}
