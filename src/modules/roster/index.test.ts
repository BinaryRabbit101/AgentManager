/**
 * Guard tests for the two properties M0 and M1 promise about the *build*
 * rather than about any one function.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as roster from './index.js';

const ROSTER_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * The only roster modules allowed to see the SDK (DESIGN §13: `compileSession`
 * is "the only place SDK option shapes appear"). M1 held this as "nowhere at
 * all"; M4 landed the compiler, so it becomes an allowlist rather than a ban —
 * which is the stronger statement, because a new file is an offender by default.
 */
const SDK_IMPORTERS: readonly string[] = [
  'sessionOptions.ts', // the `Options` type, re-exported as ClaudeAgentSdkOptions
  'compileSession.ts', // constructs it
  'compileSession.test.ts', // type-level validation + the gated runtime smoke test
  'draft.ts', // M8: the one `query()` call roster makes (§12.2, §13)
  'draft.live.test.ts', // the token-gated live drafting check
];

describe('SDK boundary', () => {
  it('only the option compiler imports the Claude Agent SDK (DESIGN §13)', () => {
    const offenders = sourceFiles(ROSTER_DIR)
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return /from '@anthropic-ai\//.test(text) || /require\('@anthropic-ai\//.test(text);
      })
      .filter((file) => !SDK_IMPORTERS.includes(basename(file)));
    expect(offenders).toEqual([]);
  });

  it('the schema itself still has no SDK import (M1 acceptance)', () => {
    for (const name of ['schema.ts', 'contracts.ts', 'parse.ts', 'migrate.ts']) {
      expect(readFileSync(join(ROSTER_DIR, name), 'utf8')).not.toMatch(/@anthropic-ai\//);
    }
  });

  it('package.json pins the SDK to an exact version (M0 acceptance)', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const pinned = manifest.dependencies?.['@anthropic-ai/claude-agent-sdk'];
    expect(pinned).toBeDefined();
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the barrel', () => {
  it('exports the schema, the parser and the contracts M2–M4 consume', () => {
    for (const name of [
      'agentDefinitionSchema',
      'parseAgentDefinition',
      'safeParseAgentDefinition',
      'serialiseAgentDefinition',
      'migrate',
      'diagnosticSchema',
      'effectivePermissionsSchema',
      'RosterValidationError',
      'AGENT_SCHEMA_VERSION',
    ] as const) {
      expect(roster[name]).toBeDefined();
    }
  });

  it('pins the schema version this build writes', () => {
    expect(roster.AGENT_SCHEMA_VERSION).toBe(1);
  });
});
