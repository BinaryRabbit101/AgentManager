/**
 * The **live** half of M8: the drafting call against the real engine, and the
 * P50 latency the milestone asks for.
 *
 * Token-gated like every other live check in this repository (roster SDK-NOTES
 * §10, orchestrator `__spike__/sdk.spike.test.ts`): drafting runs through the
 * same Agent SDK and the same subscription auth as everything else, and this
 * machine has no `CLAUDE_CODE_OAUTH_TOKEN`, so the whole file skips. What it
 * measures cannot be faked — "P50 latency measured and recorded; if it exceeds
 * ~8 s the model or prompt size is revisited before the milestone closes" is a
 * statement about the real model answering the real prompt — and everything
 * *else* about the pipeline is proved against the injectable seam in
 * `draft.test.ts`, which runs everywhere.
 *
 * **Recorded result on this machine: not measured — no token is present here.**
 * The gate below is the record: when a token exists, three runs are timed, the
 * median is asserted against {@link DRAFT_P50_BUDGET_MS} and printed through the
 * test reporter, so the number lands in CI output rather than in a comment
 * somebody has to trust.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DRAFT_P50_BUDGET_MS,
  draftFromDescription,
  realDraftQuery,
  type DraftQueryFn,
} from './draft.js';
import { parseAgentDefinition } from './parse.js';

const token = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
const hasToken = typeof token === 'string' && token !== '';

const scratchDirs: string[] = [];

/** Keeps the live call off the developer's real `~/.claude` (runner SDK-NOTES L14). */
function isolatedQuery(): DraftQueryFn {
  const configDir = mkdtempSync(resolve(tmpdir(), 'agentmanager-roster-draft-config-'));
  const cwd = mkdtempSync(resolve(tmpdir(), 'agentmanager-roster-draft-cwd-'));
  scratchDirs.push(configDir, cwd);
  return (args) =>
    realDraftQuery({
      prompt: args.prompt,
      options: { ...args.options, cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } },
    });
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

describe.skipIf(!hasToken)('drafting against the real SDK (M8)', () => {
  it(
    'drafts a definition the M1 schema accepts, with a P50 inside the budget',
    { timeout: 300_000 },
    async () => {
      const durations: number[] = [];
      let last;

      for (let run = 0; run < 3; run += 1) {
        const started = Date.now();
        last = await draftFromDescription(
          {
            description:
              'Someone who watches our PHP sites for 500s and patches them, but always writes ' +
              'a failing test first.',
            hints: { modelTier: 'balanced' },
          },
          { query: isolatedQuery() },
        );
        durations.push(Date.now() - started);
      }

      const sorted = [...durations].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
      // Recorded where a human and CI can both see it.
      expect({ p50, runs: durations }).toBeDefined();
      process.stdout.write(`\ndraft P50: ${String(p50)} ms over ${JSON.stringify(durations)}\n`);

      expect(last?.degraded).toBe(false);
      expect(p50).toBeLessThan(DRAFT_P50_BUDGET_MS);

      // The same completion the wizard performs, so "it drafted something" and
      // "the something is savable" are one assertion.
      const completed = parseAgentDefinition(
        {
          ...last?.draft,
          id: 'live-draft',
          meta: {
            createdAt: '2026-08-17T10:00:00.000Z',
            updatedAt: '2026-08-17T10:00:00.000Z',
            origin: 'drafted',
            duplicatedFrom: null,
          },
        },
        'draft.live.test.ts',
      );
      expect(completed.name.length).toBeGreaterThan(0);
    },
  );
});
