/**
 * `resolveAgentEnv` — foundation §2.3's `null` means "compute the default".
 *
 * The `CLAUDE_CONFIG_DIR` case is load-bearing rather than cosmetic: it is where
 * the CLI writes the session JSONL that `resume` reads (SDK-NOTES §8, L14), so
 * an unresolved null puts AgentManager's sessions in the owner's own
 * `~/.claude` and breaks pause/resume after a restart.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_ENV_NULL_DEFAULTS, resolveAgentEnv } from './agentEnv.js';
import { makeTempDir, type TempDir } from './__tests__/helpers.js';

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir('agentmanager-runner-agentenv-');
});

afterEach(() => {
  temp.cleanup();
});

describe('resolveAgentEnv', () => {
  it('computes CLAUDE_CONFIG_DIR as <dataRoot>\\state\\claude-config and creates it', () => {
    const stateDir = resolve(temp.path, 'state');
    const resolved = resolveAgentEnv(
      { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CONFIG_DIR: null },
      { stateDir },
    );

    expect(resolved).toEqual({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CONFIG_DIR: resolve(stateDir, 'claude-config'),
    });
    // The engine writing into a directory that does not exist is a failure
    // found at the first pause, not the first launch.
    expect(existsSync(resolved['CLAUDE_CONFIG_DIR'] ?? '')).toBe(true);
  });

  it('drops a null with no computed default, naming it in a warning', () => {
    const warnings: { message: string; detail: Record<string, unknown> }[] = [];
    const resolved = resolveAgentEnv(
      { SOMETHING_ELSE: null, KEPT: 'yes' },
      {
        stateDir: resolve(temp.path, 'state'),
        ensureDir: () => {},
        onWarn: (message, detail) => warnings.push({ message, detail }),
      },
    );

    expect(resolved).toEqual({ KEPT: 'yes' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.detail['name']).toBe('SOMETHING_ELSE');
  });

  it('passes literal values through untouched and in order', () => {
    const resolved = resolveAgentEnv(
      { A: '1', B: '2', C: '3' },
      { stateDir: resolve(temp.path, 'state'), ensureDir: () => {} },
    );
    expect(Object.keys(resolved)).toEqual(['A', 'B', 'C']);
  });

  it('names every key it knows how to compute', () => {
    // A second computed key is a design change, not a string: this assertion is
    // what makes adding one deliberate.
    expect(Object.keys(AGENT_ENV_NULL_DEFAULTS)).toEqual(['CLAUDE_CONFIG_DIR']);
  });
});
