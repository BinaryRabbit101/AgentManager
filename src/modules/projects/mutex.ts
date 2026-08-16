/**
 * A keyed async mutex — the in-process half of §4.3's serialization.
 *
 * > "Acquisition is serialized per project (an in-process async mutex plus the
 * > partial unique index, so a crash-restart cannot double-lease)."
 *
 * The mutex is what makes the decision of §4.1 — *is anybody already holding
 * the primary tree?* — safe to make. That decision reads the lease table and
 * then writes it, and `acquireWorkspace` awaits git in between; without the
 * lock, two concurrent write-capable assignments both read "nobody holds it"
 * and both take the primary tree, which is precisely the corruption worktrees
 * exist to prevent. The unique index would not catch it either: the two rows
 * are for *different* assignments, so nothing is duplicated — they simply both
 * claim the same directory.
 *
 * Keyed by project, not global: two projects have nothing to serialise against
 * each other, and a `git worktree add` on a large repository is slow enough that
 * one global lock would be felt.
 */

/** Released exactly once; a second call is a no-op rather than a corruption. */
export type Release = () => void;

export interface KeyedMutex {
  /** Resolves when the caller owns `key`. Always release in a `finally`. */
  acquire(key: string): Promise<Release>;
  /** Runs `fn` while holding `key`, releasing even if it throws. */
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Keys with a holder or a waiter. Diagnostics and tests only. */
  held(): readonly string[];
}

export function createKeyedMutex(): KeyedMutex {
  /** key → the promise the *last* queued waiter resolves when it releases. */
  const tails = new Map<string, Promise<void>>();

  function acquire(key: string): Promise<Release> {
    const previous = tails.get(key) ?? Promise.resolve();

    let release: Release = (): void => {};
    const mine = new Promise<void>((resolve) => {
      release = (): void => {
        // The tail is only cleared when nobody queued behind us, so a long chain
        // does not leak a map entry per project for the process lifetime.
        if (tails.get(key) === mine) tails.delete(key);
        resolve();
      };
    });
    tails.set(key, mine);

    return previous.then(() => release);
  }

  return {
    acquire,
    async runExclusive(key, fn) {
      const release = await acquire(key);
      try {
        return await fn();
      } finally {
        release();
      }
    },
    held: () => [...tails.keys()],
  };
}
