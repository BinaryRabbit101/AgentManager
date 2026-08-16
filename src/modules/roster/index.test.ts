/**
 * Guard tests for the two properties M0 and M1 promise about the *build*
 * rather than about any one function.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

describe('SDK boundary', () => {
  it('M1 imports no Claude Agent SDK — option shapes live only in the compiler (DESIGN §13)', () => {
    const offenders = sourceFiles(ROSTER_DIR).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /from '@anthropic-ai\//.test(text) || /require\('@anthropic-ai\//.test(text);
    });
    expect(offenders).toEqual([]);
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
