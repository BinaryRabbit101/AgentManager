/**
 * Worktree naming, the `MAX_PATH` budget, and Windows removal (projects
 * IMPLEMENTATION M6; DESIGN §4.4).
 *
 * The arithmetic and the retry loop are unit-tested here so that
 * `workspaces.test.ts` can stay about the *rule* of §4.1 rather than about
 * string lengths. Two of these assertions are load-bearing:
 *
 * - the id is truncated from the **tail**, because ULIDs share a timestamp
 *   prefix and two assignments minted in one millisecond would otherwise share
 *   a worktree path and a branch name;
 * - the worst-case path for a 24-character slug fits inside `MAX_PATH` with the
 *   repository's own tree still to come — M6's "total worktree path length is
 *   verified against MAX_PATH for a 24-char slug".
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from './__tests__/helpers.js';
import {
  removeDirectoryWithRetry,
  repositoryBusyReason,
  shortAssignmentId,
  worktreeNaming,
  worktreePathBudget,
  MAX_PATH,
  SHORT_ASSIGNMENT_ID_LENGTH,
} from './worktree.js';

describe('naming (§4.4)', () => {
  it('puts the worktree at <root>\\<slug>\\<id8> on branch agentmanager/<id8>-<slug>', () => {
    const naming = worktreeNaming(
      'C:\\AgentManager\\worktrees',
      'billing',
      '01JZ8ABCDEF123456789XYZ',
    );
    expect(naming.shortId).toHaveLength(SHORT_ASSIGNMENT_ID_LENGTH);
    expect(naming.path).toBe(`C:\\AgentManager\\worktrees\\billing\\${naming.shortId}`);
    expect(naming.branch).toBe(`agentmanager/${naming.shortId}-billing`);
  });

  it('truncates the assignment id from the tail, so same-millisecond ULIDs do not collide', () => {
    // Two ULIDs minted in the same millisecond: identical timestamp prefix,
    // different random tail. A leading truncation would give them one path.
    const first = '01JZ8ABCDEFGHJKMNPQRSTVWXY';
    const second = '01JZ8ABCDEFGHJKMNPQRSTVW11';
    expect(first.slice(0, 10)).toBe(second.slice(0, 10));
    expect(shortAssignmentId(first)).not.toBe(shortAssignmentId(second));

    const a = worktreeNaming('C:\\wt', 'billing', first);
    const b = worktreeNaming('C:\\wt', 'billing', second);
    expect(a.path).not.toBe(b.path);
    expect(a.branch).not.toBe(b.branch);
  });

  it('sanitises anything that is not [a-z0-9-]', () => {
    expect(shortAssignmentId('ASSIGN/ment 1')).toMatch(/^[a-z0-9-]{8}$/);
  });
});

describe('the MAX_PATH budget (§4.4)', () => {
  it('fits a 24-character slug under MAX_PATH with headroom left for the repository', () => {
    // The default root, as foundation resolves it.
    const budget = worktreePathBudget('C:\\Users\\owner\\AppData\\Local\\AgentManager\\worktrees');
    expect(budget.worstCaseRootLength).toBeLessThanOrEqual(budget.limit);
    expect(budget.limit).toBeLessThan(MAX_PATH);
    // Concretely: root + '\' + 24 + '\' + 8.
    expect(budget.worstCaseRootLength).toBe(
      'C:\\Users\\owner\\AppData\\Local\\AgentManager\\worktrees'.length + 34,
    );
  });

  it('reports a root that leaves no room', () => {
    const deep = `C:\\${'x'.repeat(200)}\\worktrees`;
    expect(worktreePathBudget(deep).withinLimit).toBe(false);
  });
});

describe('repositoryBusyReason (§4.4 refusals)', () => {
  it('answers undefined for an ordinary repository and names the state otherwise', () => {
    const dir = makeTempDir('agentmanager-worktree-busy-');
    try {
      mkdirSync(resolve(dir.path, '.git'), { recursive: true });
      expect(repositoryBusyReason(dir.path)).toBeUndefined();

      writeFileSync(resolve(dir.path, '.git', 'MERGE_HEAD'), 'abc', 'utf8');
      expect(repositoryBusyReason(dir.path)).toContain('merge');
    } finally {
      dir.cleanup();
    }
  });
});

describe('removal with backoff (§4.4 "Windows removal")', () => {
  it('removes a directory tree and reports the attempt count', async () => {
    const dir = makeTempDir('agentmanager-worktree-remove-');
    const target = resolve(dir.path, 'tree');
    mkdirSync(resolve(target, 'nested'), { recursive: true });
    writeFileSync(resolve(target, 'nested', 'file.txt'), 'x', 'utf8');

    const result = await removeDirectoryWithRetry(target, { attempts: 3, initialDelayMs: 1 });
    expect(result).toMatchObject({ removed: true, attempts: 1 });
    dir.cleanup();
  });

  it('retries with a growing delay and reports failure rather than throwing', async () => {
    const delays: number[] = [];
    let calls = 0;

    const result = await removeDirectoryWithRetry('C:\\worktrees\\billing\\abc12345', {
      attempts: 3,
      initialDelayMs: 10,
      // The held-handle case §4.4 names, made deterministic.
      remove: () => {
        calls += 1;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      },
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    expect(calls).toBe(3);
    expect(result.removed).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error).toContain('EBUSY');
    // Backoff, not a busy loop: 10 then 20, and no sleep after the last attempt.
    expect(delays).toEqual([10, 20]);
  });

  it('stops as soon as a retry succeeds', async () => {
    let calls = 0;
    const result = await removeDirectoryWithRetry('C:\\worktrees\\billing\\abc12345', {
      attempts: 4,
      initialDelayMs: 1,
      remove: () => {
        calls += 1;
        if (calls < 2) throw new Error('EPERM: operation not permitted');
      },
      sleep: () => Promise.resolve(),
    });

    expect(result).toMatchObject({ removed: true, attempts: 2 });
  });
});
