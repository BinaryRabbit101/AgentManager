/**
 * The environment merge (roster IMPLEMENTATION M4).
 *
 * The `PATH` case is a named acceptance criterion rather than an incidental
 * assertion: `Options.env` **replaces** the child environment on the pinned SDK,
 * and an agent that loses `PATH` fails with errors that look like MCP bugs
 * (SDK-NOTES §3, DESIGN §10).
 */
import { describe, expect, it } from 'vitest';

import { Secret } from '../../secrets/index.js';
import type { SecretResolver } from '../../secrets/index.js';

import { lookupEnv, mergeAgentEnv } from './envMerge.js';
import { SessionCompileError } from './sessionOptions.js';

/** A resolver over a plain map — M6 supplies the real one (M4 acceptance). */
function stubResolver(secrets: Readonly<Record<string, string>>): SecretResolver {
  return {
    get: (key) => Promise.resolve(key in secrets ? new Secret(secrets[key] as string) : undefined),
  };
}

const EMPTY: SecretResolver = { get: () => Promise.resolve(undefined) };

describe('mergeAgentEnv', () => {
  it('keeps the inherited PATH (the replace-not-merge regression guard)', async () => {
    const merged = await mergeAgentEnv({
      base: { PATH: 'C:\\Windows\\System32;C:\\tools', HOME: 'C:\\Users\\owner' },
      layers: [{ source: 'foundation.agentEnv', entries: [{ name: 'FOO', value: 'bar' }] }],
      secrets: EMPTY,
    });
    expect(merged.env['PATH']).toBe('C:\\Windows\\System32;C:\\tools');
    expect(merged.env['HOME']).toBe('C:\\Users\\owner');
    expect(merged.env['FOO']).toBe('bar');
  });

  it('keeps the real process PATH under whatever casing the platform uses', async () => {
    const merged = await mergeAgentEnv({ base: process.env, layers: [], secrets: EMPTY });
    expect(lookupEnv(merged.env, 'PATH')).toBe(lookupEnv(process.env as never, 'PATH'));
    expect(lookupEnv(merged.env, 'PATH')).toBeDefined();
  });

  it('applies the layers in §13 order, later winning', async () => {
    const merged = await mergeAgentEnv({
      base: { LAYER: 'base', PATH: '/usr/bin' },
      layers: [
        { source: 'foundation.agentEnv', entries: [{ name: 'LAYER', value: 'foundation' }] },
        { source: 'project', entries: [{ name: 'LAYER', value: 'project' }] },
        { source: 'assignment', entries: [{ name: 'LAYER', value: 'assignment' }] },
      ],
      secrets: EMPTY,
    });
    expect(merged.env['LAYER']).toBe('assignment');
    expect(merged.env['PATH']).toBe('/usr/bin');
  });

  it('drops undefined values rather than serialising them as "undefined"', async () => {
    const merged = await mergeAgentEnv({
      base: { PRESENT: 'yes', ABSENT: undefined },
      layers: [],
      secrets: EMPTY,
    });
    expect(merged.env).toEqual({ PRESENT: 'yes' });
    expect('ABSENT' in merged.env).toBe(false);
  });

  it('resolves a secretRef through the resolver — the one authorized reveal site', async () => {
    const merged = await mergeAgentEnv({
      base: {},
      layers: [
        {
          source: 'project',
          entries: [{ name: 'GMAIL_TOKEN', secretRef: 'mcp.gmail.token' }],
        },
      ],
      secrets: stubResolver({ 'mcp.gmail.token': 'ya29-not-a-real-token' }),
    });
    expect(merged.env['GMAIL_TOKEN']).toBe('ya29-not-a-real-token');
  });

  it('fails the launch by name when a secretRef does not resolve (§10)', async () => {
    const attempt = mergeAgentEnv({
      base: {},
      layers: [
        { source: 'project', entries: [{ name: 'GMAIL_TOKEN', secretRef: 'mcp.gmail.token' }] },
      ],
      secrets: EMPTY,
      agentName: 'Priya',
      agentId: 'priya-bugfix',
    });
    await expect(attempt).rejects.toBeInstanceOf(SessionCompileError);
    await expect(attempt).rejects.toThrow(/agent Priya needs secret `mcp\.gmail\.token`/);
    const error = await attempt.catch((caught: unknown) => caught as SessionCompileError);
    expect(error.diagnostics[0]).toMatchObject({
      level: 'error',
      code: 'roster.secret.unresolved',
      agentId: 'priya-bugfix',
      path: 'project.env.GMAIL_TOKEN',
    });
  });

  it('warns when a layer takes over an auth variable (architecture D2)', async () => {
    const merged = await mergeAgentEnv({
      base: { CLAUDE_CODE_OAUTH_TOKEN: 'inherited' },
      layers: [{ source: 'project', entries: [{ name: 'ANTHROPIC_API_KEY', value: 'sk-work' }] }],
      secrets: EMPTY,
      agentId: 'priya-bugfix',
    });
    expect(merged.env['ANTHROPIC_API_KEY']).toBe('sk-work');
    expect(merged.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'roster.env.auth-override',
    ]);
  });

  it('does not warn when a layer restates the value the environment already had', async () => {
    const merged = await mergeAgentEnv({
      base: { ANTHROPIC_API_KEY: 'sk-work' },
      layers: [{ source: 'project', entries: [{ name: 'ANTHROPIC_API_KEY', value: 'sk-work' }] }],
      secrets: EMPTY,
    });
    expect(merged.diagnostics).toEqual([]);
  });
});

describe('lookupEnv', () => {
  it('finds PATH however the platform spells it', () => {
    expect(lookupEnv({ Path: 'a' }, 'PATH')).toBe('a');
    expect(lookupEnv({ PATH: 'a' }, 'path')).toBe('a');
    expect(lookupEnv({}, 'PATH')).toBeUndefined();
  });
});
