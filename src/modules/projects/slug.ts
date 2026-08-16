/**
 * Slug generation (projects DESIGN §1.1).
 *
 * > "`slug`: lowercase, `[a-z0-9-]`, <= 24 chars, unique. Used in worktree paths
 * > — kept short deliberately."
 *
 * The 24-character cap is not cosmetic. §4.4 puts worktrees at
 * `%LOCALAPPDATA%\AgentManager\worktrees\<project-slug>\<assignment-id-8>` and
 * branches at `agentmanager/<assignment-id-8>-<slug>`, both of which have to
 * stay well clear of `MAX_PATH` on a machine where `LongPathsEnabled` may be
 * off. So the cap is enforced **including the dedup suffix**: `-2` eats into the
 * stem rather than extending past the limit.
 */
import { SlugExhaustedError } from './errors.js';

/** §1.1's cap, counted over the finished slug, suffix included. */
export const MAX_SLUG_LENGTH = 24;

/** The shape every stored slug satisfies. */
export const SLUG_PATTERN = /^[a-z0-9-]+$/;

/** Used when a name reduces to nothing a slug can be made of (e.g. `工程`). */
export const FALLBACK_SLUG = 'project';

/** Stops the dedup loop; `app-9999` means something else has gone wrong. */
const MAX_DEDUP_ATTEMPTS = 9999;

export function isSlug(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value);
}

/**
 * Reduces a display name to a slug: `My App (v2)` → `my-app-v2`.
 *
 * Diacritics are folded rather than dropped (`Café` → `cafe`), because
 * transliterating is the difference between a recognisable slug and `caf`.
 * Anything else outside `[a-z0-9]` collapses to a single `-`.
 */
export function slugify(input: string): string {
  const folded = input
    .normalize('NFKD')
    // Combining marks left behind by NFKD — this is what folds `é` to `e`.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

  const trimmed = trimDashes(folded).slice(0, MAX_SLUG_LENGTH);
  // Truncation can land on a dash; a trailing one would be ugly in a path.
  const slug = trimDashes(trimmed);
  return slug.length === 0 ? FALLBACK_SLUG : slug;
}

/**
 * The first free slug in the `app`, `app-2`, `app-3` series (§1.1).
 *
 * Numbering starts at 2 rather than 1 because the unsuffixed slug *is* the
 * first: `app` and `app-1` side by side would read as if a zeroth existed.
 *
 * @param isTaken asked once per candidate; the repository backs it with a
 *   `slug` lookup, and a test with a set.
 * @throws SlugExhaustedError after {@link MAX_DEDUP_ATTEMPTS} candidates.
 */
export function dedupeSlug(base: string, isTaken: (slug: string) => boolean): string {
  const start = slugify(base);
  if (!isTaken(start)) return start;

  for (let n = 2; n <= MAX_DEDUP_ATTEMPTS; n += 1) {
    const suffix = `-${String(n)}`;
    // The cap counts the suffix, so a long stem gives ground to it rather than
    // pushing the slug past 24 characters.
    const stem = trimDashes(start.slice(0, MAX_SLUG_LENGTH - suffix.length));
    const candidate = `${stem.length === 0 ? FALLBACK_SLUG.slice(0, 1) : stem}${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }

  throw new SlugExhaustedError(start);
}

function trimDashes(value: string): string {
  return value.replace(/^-+/, '').replace(/-+$/, '');
}
