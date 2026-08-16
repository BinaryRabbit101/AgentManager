/**
 * The refusal vocabulary of the CRUD surface (roster DESIGN §9.1, M3).
 *
 * `errors.ts` next door owns {@link RosterValidationError} — "this document is
 * not a valid agent definition", which is a *schema* verdict and is produced by
 * the parser long before any HTTP route exists. This file owns the other kind:
 * a well-formed request that the roster refuses for a reason of its own (the id
 * is taken, the agent is gone, a purge would orphan a transcript). Keeping them
 * apart means M1's parser stays free of HTTP concepts and this file stays free
 * of Zod.
 *
 * Each error carries three things a caller can act on without parsing prose: a
 * stable machine-readable {@link RosterServiceError.code}, the HTTP status the
 * API answers with, and a `details` bag naming the offending values. `routes.ts`
 * turns exactly those three into foundation's one error shape, which is why no
 * handler ever surfaces a stack.
 *
 * Statuses follow the same split projects drew: `400` for "the request you sent
 * cannot be carried out", `404` for "no such agent", `409` for "something
 * already claims this / something still depends on it", `413`/`415` for an
 * upload that is too big or the wrong kind.
 */

/** Base class, so a route (or a test) can recognise an expected refusal. */
export class RosterServiceError extends Error {
  override readonly name: string = 'RosterServiceError';

  constructor(
    /** Stable, machine-readable: `agent_not_found`, `agent_id_immutable`, … */
    readonly code: string,
    message: string,
    readonly status: number,
    /** Merged into the JSON error body; never contains a stack or a secret. */
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The request body was malformed — a missing field, or a value outside its union. */
export class InvalidRosterRequestError extends RosterServiceError {
  override readonly name = 'InvalidRosterRequestError';

  constructor(
    message: string,
    readonly field?: string,
  ) {
    super('invalid_request', message, 400, field === undefined ? {} : { field });
  }
}

/** No agent with that id — neither in the registry nor in `.archive/` (§9.3). */
export class AgentNotFoundError extends RosterServiceError {
  override readonly name = 'AgentNotFoundError';

  constructor(readonly agentId: string) {
    super('agent_not_found', `No agent with id "${agentId}".`, 404, { agentId });
  }
}

/**
 * The agent exists but has been archived, and the operation needs a live one.
 *
 * Distinct from {@link AgentNotFoundError} because §9.3 keeps archived
 * definitions readable "for display": a `GET` succeeds where a `PATCH` must not,
 * and a UI that got a flat 404 for both could not tell the user which happened.
 */
export class AgentArchivedError extends RosterServiceError {
  override readonly name = 'AgentArchivedError';

  constructor(
    readonly agentId: string,
    readonly archivedAt: string,
  ) {
    super(
      'agent_archived',
      `Agent "${agentId}" was archived at ${archivedAt}; archived definitions are readable but not editable (DESIGN §9.3).`,
      409,
      { agentId, archivedAt },
    );
  }
}

/**
 * An explicit `id` on a create collides with an agent — live, archived, or just
 * a folder sitting in the library.
 *
 * A *derived* id never reaches this: a name whose slug is taken is suffixed
 * (§9.1, "collision-suffixed"). This is only for an id the caller chose, where
 * silently writing to a different one would be worse than refusing.
 */
export class AgentIdTakenError extends RosterServiceError {
  override readonly name = 'AgentIdTakenError';

  constructor(readonly agentId: string) {
    super(
      'agent_id_taken',
      `Agent id "${agentId}" is already in use. Ids are never reused, including by archived agents (DESIGN §9.3).`,
      409,
      { agentId },
    );
  }
}

/**
 * A `PATCH` tried to change an immutable field (§3, M3's acceptance: "`PATCH`
 * attempting to change `id` is a 400").
 *
 * `id` is the folder name and the join key of every session, assignment and
 * transcript; `meta.createdAt` is provenance. Renaming either is a new agent,
 * which is what duplicate is for.
 */
export class ImmutableFieldError extends RosterServiceError {
  override readonly name = 'ImmutableFieldError';

  constructor(readonly fields: readonly string[]) {
    super(
      'immutable_field',
      `${fields.join(', ')} cannot be changed after an agent is created. ` +
        'Duplicate the agent instead (POST /api/roster/agents/:id/duplicate).',
      400,
      { fields: [...fields] },
    );
  }
}

/**
 * A hard purge was asked for while sessions still reference the agent (§9.3).
 *
 * The invariant being protected is that "a transcript can always name who
 * produced it": ids are never reused, and an agent whose history exists is
 * archived rather than removed.
 */
export class PurgeBlockedError extends RosterServiceError {
  override readonly name = 'PurgeBlockedError';

  constructor(
    readonly agentId: string,
    readonly sessionCount: number,
  ) {
    super(
      'purge_blocked',
      `Agent "${agentId}" is referenced by ${String(sessionCount)} session(s) and cannot be purged; ` +
        'it has been archived instead so its transcripts can still name it (DESIGN §9.3).',
      409,
      { agentId, sessionCount },
    );
  }
}

/** `PUT /board-order` named an id the roster does not have (§9.5). */
export class UnknownBoardOrderIdError extends RosterServiceError {
  override readonly name = 'UnknownBoardOrderIdError';

  constructor(readonly unknownIds: readonly string[]) {
    super(
      'unknown_agent_id',
      `Board order names ${unknownIds.length === 1 ? 'an agent' : 'agents'} the roster does not have: ` +
        `${unknownIds.join(', ')}. The previous order is unchanged.`,
      400,
      { unknownIds: [...unknownIds] },
    );
  }
}

/** An avatar upload was larger than the cap (§9.5). */
export class AvatarTooLargeError extends RosterServiceError {
  override readonly name = 'AvatarTooLargeError';

  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(
      'avatar_too_large',
      `Avatar is ${String(bytes)} bytes; the limit is ${String(limit)}. The previous avatar is unchanged.`,
      413,
      { bytes, limit },
    );
  }
}

/** An avatar upload was not one of the accepted image formats (§9.5). */
export class AvatarNotAnImageError extends RosterServiceError {
  override readonly name = 'AvatarNotAnImageError';

  constructor(readonly accepted: readonly string[]) {
    super(
      'avatar_not_an_image',
      `Avatar must be one of ${accepted.join(', ')}, recognised by its own bytes rather than by the ` +
        'declared content type. The previous avatar is unchanged.',
      415,
      { accepted: [...accepted] },
    );
  }
}

/** A write to the library failed — a full disk, a lock, a revoked ACL. */
export class LibraryWriteError extends RosterServiceError {
  override readonly name = 'LibraryWriteError';

  constructor(what: string, options?: { cause?: unknown }) {
    super(
      'library_write_failed',
      `The agent library could not be written (${what}). See the core log for detail.`,
      500,
      {},
      options,
    );
  }
}
