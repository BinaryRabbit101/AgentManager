/**
 * Minting an agent id from a display name (roster DESIGN §9.1, §9.2).
 *
 * > `POST /agents` — "create; id derived from name if absent, collision-suffixed"
 * > `POST /agents/:id/duplicate` — "mints a new id from the new name
 * > (`priya-bugfix` → `priya-bugfix-2` if no name given)"
 *
 * `ids.ts` decides what a *valid* id is; this file decides how a human's
 * "Priya (bug fixes)" becomes one. The two are deliberately separate: the
 * validity rules are schema-level and apply to hand-edited files, while these
 * are a one-way convenience that only ever runs on the create path.
 *
 * The element has its own slugger rather than reaching for the projects
 * element's because feature modules never import each other (foundation §6.1),
 * and because the two vocabularies genuinely differ: a project slug may be 24
 * characters and is free of reserved names, an agent id may be 64 and must dodge
 * `RESERVED_AGENT_IDS` (including Windows device names — the id is a folder).
 */
import { AGENT_ID_MAX_LENGTH, AGENT_ID_MIN_LENGTH, agentIdProblem } from './ids.js';

/** Used when a name slugifies to nothing at all — "🐛", "???", "  ". */
export const FALLBACK_AGENT_SLUG = 'agent';

/**
 * Ids past this are refused rather than suffixed forever. Reaching it means
 * 999 agents share one name, which is a naming problem rather than a slug one.
 */
export const MAX_SLUG_ATTEMPTS = 999;

/**
 * A display name reduced to the id character set: lower-case alphanumerics in
 * hyphen-separated groups.
 *
 * Diacritics are folded through Unicode NFD so "Renée" becomes `renee` rather
 * than `ren-e` — the id is a folder name the owner will type at a shell, and
 * losing the letter entirely reads as a bug.
 */
export function slugifyAgentName(name: string): string {
  const folded = name
    .normalize('NFD')
    // Combining marks, now separated from their base letters by NFD.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const slug = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, AGENT_ID_MAX_LENGTH)
    // A truncation can leave a trailing hyphen behind, which the id pattern
    // rejects; trimming again is cheaper than reasoning about where the cut fell.
    .replace(/-+$/g, '');

  return slug.length >= AGENT_ID_MIN_LENGTH ? slug : FALLBACK_AGENT_SLUG;
}

/**
 * The suffixed form: `priya-bugfix` → `priya-bugfix-2`.
 *
 * Suffixing is applied to a base that has already been trimmed to fit, so the
 * result cannot exceed {@link AGENT_ID_MAX_LENGTH} — an id that is one character
 * too long because of its `-12` would be refused by validation at the very end
 * of a create, which is the least useful moment to discover it.
 */
export function suffixAgentId(base: string, attempt: number): string {
  if (attempt <= 1) return base;
  const suffix = `-${String(attempt)}`;
  const room = AGENT_ID_MAX_LENGTH - suffix.length;
  const head = base.length <= room ? base : base.slice(0, room).replace(/-+$/g, '');
  return `${head}${suffix}`;
}

/**
 * The first free id derived from `base`, or `undefined` when the suffix space is
 * exhausted.
 *
 * `taken` answers for *every* id the library has ever issued — live agents,
 * archived ones, and any folder sitting in `agents/` that failed to load —
 * because §9.3's "ids are never reused" is what lets a transcript from last
 * month still name its author.
 *
 * A reserved or malformed base is fixed here rather than refused: `nul` is a
 * perfectly reasonable thing to call an agent, and `nul-2` is a better answer
 * than a validation error about Windows device names.
 */
export function mintAgentId(name: string, taken: (id: string) => boolean): string | undefined {
  const base = slugifyAgentName(name);

  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidate = suffixAgentId(base, attempt);
    // `attempt === 1` can produce a reserved id ("import") or, after
    // truncation, a malformed one; both simply move on to `-2`.
    if (agentIdProblem(candidate) !== undefined) continue;
    if (!taken(candidate)) return candidate;
  }

  return undefined;
}
