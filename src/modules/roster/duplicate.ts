/**
 * Duplicate-and-edit (roster DESIGN §9.2).
 *
 * > "A first-class operation, not `GET` + `POST`."
 *
 * The distinction is the whole point of the file. A `GET` + `POST` clone would
 * carry the fields the API happens to return, which is exactly the set that
 * *excludes* everything the folder holds — the persona body, the role addenda,
 * the skills, the avatar. Duplicating the **folder** and then rewriting only the
 * header means a clone is complete by default and loses something only where
 * this file says so.
 *
 * What changes, and nothing else:
 *
 * | field | why |
 * |---|---|
 * | `id` | minted from the new name, or `<source>-2` (§9.2) |
 * | `name` | the caller's, or the source's |
 * | `meta.origin` | `"duplicated"` |
 * | `meta.duplicatedFrom` | the source id — the provenance link the UI shows |
 * | `meta.createdAt` / `updatedAt` | fresh; the clone is a new identity |
 *
 * What deliberately does **not** change: `integrations`, including every
 * `secretRef`. §9.2: "the clone points at the same secrets, which is almost
 * always intended, and foundation's secret store is keyed by ref not by agent."
 * Copying a *reference* is safe in a way copying a value never would be, which
 * is the entire reason the schema stores refs.
 */
import { isoTimestamp } from '../../storage/time.js';

import type { AgentDefinition } from './schema.js';
import { MAX_SLUG_ATTEMPTS, mintAgentId, suffixAgentId } from './slug.js';

/** How a duplicate's id is chosen, given the caller's optional new name. */
export interface DuplicateIdRequest {
  readonly sourceId: string;
  /** `{ name }` from `POST /agents/:id/duplicate`; absent means "same name". */
  readonly name?: string;
  /** True for any id the library has ever issued (§9.3). */
  readonly taken: (id: string) => boolean;
}

/**
 * The clone's id.
 *
 * With a name, it is minted from the name like any other create. Without one,
 * §9.2 fixes the answer as `priya-bugfix` → `priya-bugfix-2` — deliberately not
 * a slug of the unchanged name, because that would be the source's own id and
 * the suffix search would land on the same place by a longer route.
 */
export function duplicateAgentId(request: DuplicateIdRequest): string | undefined {
  if (request.name !== undefined && request.name.trim().length > 0) {
    return mintAgentId(request.name, request.taken);
  }
  for (let attempt = 2; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidate = suffixAgentId(request.sourceId, attempt);
    if (!request.taken(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The clone's `agent.json`, derived from the source's.
 *
 * A pure function over the definition: the folder copy is the store's job, and
 * keeping the two apart is what lets a test assert "the source is untouched"
 * against the definition without a filesystem at all.
 */
export function duplicateDefinition(
  source: AgentDefinition,
  options: { readonly id: string; readonly name?: string; readonly now: Date },
): AgentDefinition {
  const at = isoTimestamp(options.now);
  const name = options.name?.trim();
  return {
    ...source,
    id: options.id,
    name: name === undefined || name.length === 0 ? source.name : name,
    meta: {
      ...source.meta,
      createdAt: at,
      updatedAt: at,
      origin: 'duplicated',
      duplicatedFrom: source.id,
    },
  };
}
