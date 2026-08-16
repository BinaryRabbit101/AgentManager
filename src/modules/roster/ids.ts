/**
 * Agent ids (roster DESIGN.md §2.1, §3).
 *
 * An agent id is a slug, and the slug **is the folder name** under
 * `<libraryRoot>/agents/`. Everything else follows from that one fact: the
 * character set has to be safe on Windows and in a URL path segment, the id is
 * immutable (renaming it would rename a directory that transcripts, sessions
 * and assignments all reference by id), and ids are never reused (§9.3 —
 * "a transcript can always name who produced it").
 *
 * Reserved ids exist for the same reason. A folder called `nul` cannot be
 * created on Windows, and a folder called `import` would collide with
 * `/api/roster/import` the moment someone hand-writes a link. Both failures
 * happen far from the cause, so they are refused at the schema instead.
 */

/** Two characters is the shortest id a human will still recognise on a card. */
export const AGENT_ID_MIN_LENGTH = 2;

/** Comfortably under Windows' 255-character path-segment limit, with the
 *  library root, `agents/`, and the deepest file inside the folder to spare. */
export const AGENT_ID_MAX_LENGTH = 64;

/**
 * Lower-case alphanumerics in hyphen-separated groups: `priya-bugfix`.
 *
 * Deliberately narrower than DESIGN's `[a-z0-9-]`: no leading, trailing or
 * doubled hyphens, so `priya--bugfix` and `priya-bugfix-` cannot both exist
 * beside `priya-bugfix` and look like typos of each other in a folder listing.
 */
export const AGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Names that cannot be an agent id.
 *
 * Three groups, all of them "the id is a folder name and a URL segment":
 *
 * - **Windows device names** — `CON`, `NUL`, `COM1`… cannot be directory names
 *   on Windows at all, in any casing.
 * - **API path segments** under `/api/roster` (§9.1). `/agents/:id` never
 *   actually collides with `/import`, but the UI routes client-side on the same
 *   strings and `/agents/new` is the conventional "create" route.
 * - **Names roster gives itself** — `agentmanager` is the in-process MCP server
 *   the orchestration toolset mounts under (§13), and skills are namespaced
 *   `<agent-id>:<skill>` (§7.1), so an agent called `agentmanager` would produce
 *   tool and skill names indistinguishable from the system's own.
 */
export const RESERVED_AGENT_IDS: ReadonlySet<string> = new Set([
  // Windows device names.
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
  // `/api/roster` path segments and UI routes.
  'agents',
  'agent',
  'archive',
  'avatar',
  'board-order',
  'draft',
  'duplicate',
  'export',
  'import',
  'new',
  'roster',
  'ui-state',
  'validate',
  // Names the system uses for itself.
  'agentmanager',
  'orchestrator',
]);

/**
 * Why `value` is not a usable agent id, or `undefined` when it is one.
 *
 * Returns a sentence rather than a boolean so the schema can put the actual
 * reason next to the offending path instead of a generic "invalid string".
 */
export function agentIdProblem(value: string): string | undefined {
  if (value.length < AGENT_ID_MIN_LENGTH) {
    return `agent id must be at least ${AGENT_ID_MIN_LENGTH} characters`;
  }
  if (value.length > AGENT_ID_MAX_LENGTH) {
    return `agent id must be at most ${AGENT_ID_MAX_LENGTH} characters`;
  }
  if (!AGENT_ID_PATTERN.test(value)) {
    return (
      `agent id must be a slug: lower-case letters and digits in hyphen-separated ` +
      `groups (got "${value}")`
    );
  }
  if (RESERVED_AGENT_IDS.has(value)) {
    return `agent id "${value}" is reserved`;
  }
  return undefined;
}

/** True when `value` is a well-formed, unreserved agent id. */
export function isAgentId(value: string): boolean {
  return agentIdProblem(value) === undefined;
}
