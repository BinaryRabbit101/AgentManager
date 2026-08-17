/**
 * Avatar object URLs, memoised per agent id (DESIGN §3.1, §16).
 *
 * `<img src="/api/roster/agents/:id/avatar">` cannot carry an `Authorization`
 * header, so over the tailnet it 401s. §3.1 settles it on the client side: fetch
 * through the API client, render from an object URL, memoise per agent id, and
 * revoke on eviction. No backend change, and — the acceptance criterion of
 * IMPLEMENTATION §2 — **no `<img src="/api/…">` exists in the tree at all**.
 *
 * Only the `file` avatar kind comes through here. `emoji` and `initials` are
 * rendered from the definition with no request, which is most of the board.
 */

import type { ApiClient } from './client';

export interface AvatarCacheOptions {
  /** Bounded so a long-lived board never accumulates object URLs (§16). */
  readonly limit?: number;
  readonly revoke?: (url: string) => void;
}

export class AvatarCache {
  readonly #client: ApiClient;
  readonly #limit: number;
  readonly #revoke: (url: string) => void;
  /** Insertion-ordered, which is what makes eviction least-recently-added. */
  readonly #urls = new Map<string, string>();
  readonly #inflight = new Map<string, Promise<string | undefined>>();

  constructor(client: ApiClient, options: AvatarCacheOptions = {}) {
    this.#client = client;
    this.#limit = options.limit ?? 64;
    this.#revoke = options.revoke ?? ((url) => URL.revokeObjectURL(url));
  }

  /** The cached URL, if this agent's avatar has already been fetched. */
  peek(agentId: string): string | undefined {
    return this.#urls.get(agentId);
  }

  async load(agentId: string): Promise<string | undefined> {
    const cached = this.#urls.get(agentId);
    if (cached !== undefined) return cached;

    // One request per agent even when several cards mount at once.
    const existing = this.#inflight.get(agentId);
    if (existing !== undefined) return existing;

    const pending = this.#fetch(agentId).finally(() => this.#inflight.delete(agentId));
    this.#inflight.set(agentId, pending);
    return pending;
  }

  /**
   * Drops one agent's URL — what `roster.changed` with reason `avatar` calls, so
   * a re-uploaded face is not stuck behind the memo.
   */
  invalidate(agentId: string): void {
    const url = this.#urls.get(agentId);
    if (url === undefined) return;
    this.#urls.delete(agentId);
    this.#revoke(url);
  }

  clear(): void {
    for (const url of this.#urls.values()) this.#revoke(url);
    this.#urls.clear();
  }

  async #fetch(agentId: string): Promise<string | undefined> {
    const result = await this.#client.objectUrl(
      `/roster/agents/${encodeURIComponent(agentId)}/avatar`,
    );
    // A failed avatar is never an error the user sees: roster guarantees one of
    // the three kinds is always present (§5.2), so the card falls back to
    // initials and the board keeps rendering.
    if (result.kind !== 'ok') return undefined;
    this.#urls.set(agentId, result.value);
    this.#evict();
    return result.value;
  }

  #evict(): void {
    while (this.#urls.size > this.#limit) {
      const oldest = this.#urls.keys().next();
      if (oldest.done === true) return;
      this.invalidate(oldest.value);
    }
  }
}

/**
 * `GET /api/logs/download` gets the same treatment (§3.1): fetch → `Blob` → a
 * synthetic anchor click, because a plain link cannot carry the bearer either.
 */
export async function downloadViaApi(
  client: ApiClient,
  path: string,
  filename: string,
  documentRef: Document = globalThis.document,
): Promise<boolean> {
  const result = await client.objectUrl(path);
  if (result.kind !== 'ok') return false;
  const anchor = documentRef.createElement('a');
  anchor.href = result.value;
  anchor.download = filename;
  documentRef.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(result.value);
  return true;
}
