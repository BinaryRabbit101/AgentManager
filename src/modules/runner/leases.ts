/**
 * Workspace-lease refcounting (runner DESIGN §3.1).
 *
 * > "**Lease refcounting.** The lease belongs to the *assignment*, not the
 * > session. Runner holds `Map<assignmentId, { leaseId, sessionRefs }>`,
 * > acquires on the first session admitted for that assignment, and releases on
 * > `assignment.closed` from orchestrator — with a safety net that releases when
 * > the last session of an assignment reaches a terminal status **and** the
 * > assignment row is no longer `open`. Paused sessions keep the lease held,
 * > which is the whole point of pausing rather than stopping."
 *
 * Every clause of that paragraph is a method or a guard below. Two of them are
 * worth restating because they are easy to get backwards:
 *
 * - **A second session on the same assignment does not call
 *   `acquireWorkspace` again.** projects' uniqueness index would refuse it, and
 *   even if it did not, two leases for one assignment is two directories for
 *   one piece of work.
 * - **The safety net checks the assignment row, not the session.** A terminal
 *   session on a still-`open` assignment keeps the lease, because the next
 *   session of that assignment — a resume, a second seat, a continue — is
 *   supposed to land in the same tree.
 *
 * In-flight acquisitions are serialised per assignment: `acquire` is `async`,
 * and two sessions admitted for one assignment in the same tick must not both
 * reach projects.
 */
import type {
  AcquireWorkspaceResultView,
  ProjectsProvider,
  WorkspaceLeaseView,
} from './contracts.js';
import { isWorkspaceRefusal } from './contracts.js';

export interface LeaseBookDeps {
  readonly projects: () => ProjectsProvider;
  /** Foundation's `assignments` row status — the safety net's second condition. */
  readonly isAssignmentOpen: (assignmentId: string) => boolean;
  readonly log?: (
    level: 'debug' | 'warn',
    message: string,
    detail: Record<string, unknown>,
  ) => void;
}

export interface LeaseBook {
  /**
   * The lease for an assignment, acquiring it on the first session and
   * refcounting every session after that.
   *
   * Returns projects' refusal untouched — reading `retryable` and deciding
   * between "stay queued" and "fail" is the launch chain's call (§3.2), not
   * this book's.
   */
  acquire(request: {
    readonly assignmentId: string;
    readonly projectId: string;
    readonly sessionId: string;
    readonly write: boolean;
    readonly scopePaths?: readonly string[];
  }): Promise<AcquireWorkspaceResultView>;
  /** The session reached a terminal status; the safety net decides the rest. */
  releaseSession(assignmentId: string, sessionId: string): Promise<void>;
  /** `assignment.closed` arrived: release whatever is held, refs or not. */
  releaseAssignment(assignmentId: string): Promise<void>;
  /** The held lease id, for `sessions.lease_id` and for tests. */
  leaseIdFor(assignmentId: string): string | undefined;
  /** How many live sessions hold the lease. */
  refsFor(assignmentId: string): number;
}

interface Entry {
  lease: WorkspaceLeaseView | undefined;
  readonly sessionRefs: Set<string>;
  /** The acquisition in flight, so two admissions do not both call projects. */
  acquiring: Promise<AcquireWorkspaceResultView> | undefined;
}

export function createLeaseBook(deps: LeaseBookDeps): LeaseBook {
  const held = new Map<string, Entry>();
  const log = deps.log ?? ((): void => {});

  function entryFor(assignmentId: string): Entry {
    const existing = held.get(assignmentId);
    if (existing !== undefined) return existing;
    const created: Entry = { lease: undefined, sessionRefs: new Set(), acquiring: undefined };
    held.set(assignmentId, created);
    return created;
  }

  async function releaseNow(assignmentId: string, entry: Entry, why: string): Promise<void> {
    const lease = entry.lease;
    held.delete(assignmentId);
    if (lease === undefined) return;
    try {
      await deps.projects().releaseWorkspace(lease.id);
      log('debug', 'workspace lease released', { assignmentId, leaseId: lease.id, why });
    } catch (error) {
      // A lease that will not release is projects' boot reconciliation to sweep
      // (§9.2 item 4); failing the session for it would be punishing the wrong
      // party at the wrong time.
      log('warn', 'the workspace lease could not be released; projects will reconcile it', {
        assignmentId,
        leaseId: lease.id,
        why,
        error: String(error),
      });
    }
  }

  return {
    async acquire(request) {
      const entry = entryFor(request.assignmentId);
      entry.sessionRefs.add(request.sessionId);

      if (entry.lease !== undefined) return entry.lease;
      if (entry.acquiring !== undefined) return entry.acquiring;

      const acquiring = deps.projects().acquireWorkspace(request.projectId, request.assignmentId, {
        write: request.write,
        ...(request.scopePaths === undefined ? {} : { scopePaths: request.scopePaths }),
      });
      entry.acquiring = acquiring;

      try {
        const result = await acquiring;
        if (!isWorkspaceRefusal(result)) entry.lease = result;
        return result;
      } finally {
        entry.acquiring = undefined;
        // A refusal leaves no lease and no reason to hold an empty entry, but
        // only once nothing else is waiting on it.
        const current = held.get(request.assignmentId);
        if (
          current !== undefined &&
          current.lease === undefined &&
          current.acquiring === undefined
        ) {
          current.sessionRefs.delete(request.sessionId);
          if (current.sessionRefs.size === 0) held.delete(request.assignmentId);
        }
      }
    },

    async releaseSession(assignmentId, sessionId) {
      const entry = held.get(assignmentId);
      if (entry === undefined) return;
      entry.sessionRefs.delete(sessionId);
      if (entry.sessionRefs.size > 0) return;
      // The safety net, both halves: no live session *and* the assignment is no
      // longer open. Either alone keeps the lease.
      if (deps.isAssignmentOpen(assignmentId)) return;
      await releaseNow(assignmentId, entry, 'last session ended and the assignment is not open');
    },

    async releaseAssignment(assignmentId) {
      const entry = held.get(assignmentId);
      if (entry === undefined) return;
      await releaseNow(assignmentId, entry, 'assignment.closed');
    },

    leaseIdFor: (assignmentId) => held.get(assignmentId)?.lease?.id,
    refsFor: (assignmentId) => held.get(assignmentId)?.sessionRefs.size ?? 0,
  };
}
