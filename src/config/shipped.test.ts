/**
 * Pins the three shipped files (`config/*.json`) to DESIGN §2.2 and §2.3.
 *
 * `defaults.json` "is the documentation of what is configurable", so a key added
 * to the schema without being added to the file — or the other way round — is a
 * drift these tests fail on.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isPlainObject, joinPath } from './merge.js';
import { findInstallRoot } from './paths.js';
import { createFoundationRegistry, foundationConfigShape } from './schema.js';

const repoRoot = findInstallRoot(dirname(fileURLToPath(import.meta.url)));

function readShipped(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, 'config', name), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** Every dotted leaf path in a value, so a delta file can be compared to the inventory. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (!isPlainObject(value)) return [prefix];
  const entries = Object.entries(value);
  if (entries.length === 0) return [prefix];
  return entries.flatMap(([key, child]) => leafPaths(child, joinPath(prefix, key)));
}

const defaults = readShipped('defaults.json');
const workEdition = readShipped('edition.work.json');
const homeEdition = readShipped('edition.home.json');
const registry = createFoundationRegistry();

describe('config/defaults.json', () => {
  it('covers every namespace in the composed schema', () => {
    expect(Object.keys(defaults).sort()).toEqual(Object.keys(foundationConfigShape).sort());
  });

  it('is exactly the defaults the registry composes', () => {
    // Two representations of one thing: the file is layer 1, the registry
    // defaults let a module ship a namespace the file does not mention yet.
    expect(defaults).toEqual(registry.composeDefaults());
  });

  it('validates against the composed schema on its own', () => {
    const parsed = registry.composeSchema().safeParse(defaults);
    expect(parsed.success).toBe(true);
  });

  it('carries the §2.3 values', () => {
    expect(defaults).toMatchObject({
      edition: 'work',
      dataRoot: null,
      library: { root: null, watch: true },
      http: { bind: '127.0.0.1', port: 7477 },
      remote: { bind: 'tailscale', port: 7478, hostnameHint: null },
      modules: { remote: { enabled: false }, orchestrator: { enabled: true } },
      runner: { maxConcurrent: 2, queueLimit: 50, defaultModel: 'sonnet' },
      projects: { root: null, worktreesRoot: null, browseRoots: null },
      agentEnv: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CONFIG_DIR: null },
      policy: { allowPermissionElevation: true, globalDeny: [] },
      auth: { mode: 'subscription' },
      secrets: { provider: 'auto' },
      logging: { level: 'info', maxFileMB: 10, maxFiles: 10, retentionDays: 14 },
      service: { autostart: false, shutdownGraceSeconds: 20 },
      retention: {
        eventDays: 30,
        eventMaxRows: 200000,
        transcriptDays: 90,
        transcriptCapMb: 500,
      },
    });
  });
});

describe('config/edition.work.json', () => {
  it('sets exactly the work-edition deltas of DESIGN §2.2 and §2.3', () => {
    expect(workEdition).toEqual({
      modules: { remote: { enabled: false } },
      http: { bind: '127.0.0.1' },
      auth: { mode: 'env' },
      policy: { allowPermissionElevation: false },
      runner: { maxConcurrent: 1 },
      orchestrator: { notify: { enabled: false } },
    });
  });

  it('lowers runner.maxConcurrent below the shipped default', () => {
    expect(workEdition['runner']).toMatchObject({ maxConcurrent: 1 });
    expect(registry.composeDefaults()['runner']).toMatchObject({ maxConcurrent: 2 });
  });
});

describe('config/edition.home.json', () => {
  it('sets exactly the home-edition deltas of DESIGN §2.2 and §2.3', () => {
    expect(homeEdition).toEqual({
      modules: { remote: { enabled: true } },
      remote: { bind: 'tailscale' },
      auth: { mode: 'subscription' },
      service: { autostart: true },
      orchestrator: { notify: { enabled: true } },
    });
  });
});

describe('both edition files', () => {
  it('touch only keys that exist in the inventory', () => {
    const known = new Set(leafPaths(defaults));
    for (const [name, file] of [
      ['edition.work.json', workEdition],
      ['edition.home.json', homeEdition],
    ] as const) {
      for (const path of leafPaths(file)) {
        expect(known.has(path), `${name} sets unknown key ${path}`).toBe(true);
      }
    }
  });

  it('never name the edition themselves — the edition selects the file', () => {
    expect(workEdition['edition']).toBeUndefined();
    expect(homeEdition['edition']).toBeUndefined();
  });

  it('are the only place the away-notification lever differs (DESIGN §2.3)', () => {
    expect(workEdition['orchestrator']).toEqual({ notify: { enabled: false } });
    expect(homeEdition['orchestrator']).toEqual({ notify: { enabled: true } });
  });
});
