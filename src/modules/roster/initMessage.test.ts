/**
 * The session-start assertion (roster DESIGN §7.1, §10; IMPLEMENTATION M5, M6).
 *
 * M5's acceptance has one item that needs a live session ("an agent with two
 * skills launches with both present in the init message's `skills` array"). That
 * test exists, token-gated, in `compileSession.test.ts`. **This** suite is the
 * reason the gate is acceptable: the helper the live test would exercise is
 * fully exercised here against a fabricated init message, so a machine with no
 * `CLAUDE_CODE_OAUTH_TOKEN` still proves every branch of the comparison.
 */
import { describe, expect, it } from 'vitest';

import {
  MCP_SERVER_STATUSES,
  assertSessionStart,
  mcpServerDiagnostics,
  type RequestedSessionSurface,
  type SessionInitFacts,
} from './initMessage.js';

const AGENT_DIR = 'C:\\library\\agents\\priya-bugfix';

const REQUESTED: RequestedSessionSurface = {
  agentId: 'priya-bugfix',
  pluginPaths: [AGENT_DIR],
  skills: ['triage-a-stack-trace', 'apply-a-patch'],
  mcpServers: [],
};

/** A well-formed init message: everything requested, loaded. */
const HEALTHY_INIT: SessionInitFacts = {
  plugins: [{ name: 'priya-bugfix', path: AGENT_DIR }],
  skills: ['triage-a-stack-trace', 'apply-a-patch'],
  mcp_servers: [],
};

describe('plugins and skills (§7.1)', () => {
  it('says nothing when the session loaded exactly what was requested', () => {
    expect(assertSessionStart(REQUESTED, HEALTHY_INIT)).toEqual([]);
  });

  it('is the M5 acceptance in unit form: two declared skills, both present', () => {
    const diagnostics = assertSessionStart(REQUESTED, HEALTHY_INIT);
    expect(diagnostics).toEqual([]);
    expect(HEALTHY_INIT.skills).toEqual(
      expect.arrayContaining(['triage-a-stack-trace', 'apply-a-patch']),
    );
  });

  it('reports a plugin the SDK silently skipped', () => {
    const diagnostics = assertSessionStart(REQUESTED, { ...HEALTHY_INIT, plugins: [] });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('roster.session.plugin-not-loaded');
    expect(diagnostics[0]?.level).toBe('error');
    expect(diagnostics[0]?.message).toContain(AGENT_DIR);
    expect(diagnostics[0]?.agentId).toBe('priya-bugfix');
  });

  it('compares plugin paths without tripping over separators or case', () => {
    const diagnostics = assertSessionStart(REQUESTED, {
      ...HEALTHY_INIT,
      plugins: [{ name: 'priya-bugfix', path: 'c:/library/agents/priya-bugfix/' }],
    });
    expect(diagnostics).toEqual([]);
  });

  it('reports a requested skill that did not load', () => {
    const diagnostics = assertSessionStart(REQUESTED, {
      ...HEALTHY_INIT,
      skills: ['triage-a-stack-trace'],
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('roster.session.skill-not-loaded');
    expect(diagnostics[0]?.message).toContain('apply-a-patch');
  });

  it('accepts the plugin-namespaced spelling the engine uses', () => {
    const diagnostics = assertSessionStart(REQUESTED, {
      ...HEALTHY_INIT,
      skills: ['priya-bugfix:triage-a-stack-trace', 'priya-bugfix:apply-a-patch'],
    });
    expect(diagnostics).toEqual([]);
  });

  it('flags skills that loaded for an agent that asked for none', () => {
    const diagnostics = assertSessionStart(
      { ...REQUESTED, pluginPaths: [], skills: [] },
      { ...HEALTHY_INIT, plugins: [], skills: ['someone-elses-skill'] },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('roster.session.unexpected-skills');
    expect(diagnostics[0]?.level).toBe('warn');
  });

  it('checks nothing it cannot check: skills "all", or a message missing the field', () => {
    expect(assertSessionStart({ ...REQUESTED, skills: 'all' }, HEALTHY_INIT)).toEqual([]);
    expect(assertSessionStart(REQUESTED, { plugins: [{ name: 'p', path: AGENT_DIR }] })).toEqual(
      [],
    );
    expect(assertSessionStart(REQUESTED, {})).toEqual([]);
  });
});

describe('MCP server statuses (§10)', () => {
  const withServers = (name: string): RequestedSessionSurface => ({
    ...REQUESTED,
    pluginPaths: [],
    skills: [],
    mcpServers: [name],
  });

  it('declares the same five statuses the SDK does', () => {
    expect([...MCP_SERVER_STATUSES]).toEqual([
      'connected',
      'failed',
      'needs-auth',
      'pending',
      'disabled',
    ]);
  });

  it('says nothing about a connected server', () => {
    expect(
      mcpServerDiagnostics(withServers('gmail'), [{ name: 'gmail', status: 'connected' }]),
    ).toEqual([]);
  });

  it('surfaces needs-auth as its own kind, not a generic failure', () => {
    const [diagnostic, ...rest] = mcpServerDiagnostics(withServers('gmail'), [
      { name: 'gmail', status: 'needs-auth' },
    ]);

    expect(rest).toEqual([]);
    expect(diagnostic?.code).toBe('roster.mcp.needs-auth');
    expect(diagnostic?.level).toBe('warn');
    expect(diagnostic?.message).toContain('credential');
    expect(diagnostic?.path).toBe('integrations.gmail');
    // The distinction the acceptance is about: a different code from `failed`.
    expect(diagnostic?.code).not.toBe('roster.mcp.failed');
  });

  it('maps failed, pending and disabled onto distinct codes', () => {
    const codes = MCP_SERVER_STATUSES.filter((status) => status !== 'connected').map(
      (status) => mcpServerDiagnostics(withServers('gmail'), [{ name: 'gmail', status }])[0]?.code,
    );
    expect(codes).toEqual([
      'roster.mcp.failed',
      'roster.mcp.needs-auth',
      'roster.mcp.pending',
      'roster.mcp.disabled',
    ]);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('does not guess at a status this build does not know', () => {
    const [diagnostic] = mcpServerDiagnostics(withServers('gmail'), [
      { name: 'gmail', status: 'reticulating' },
    ]);
    expect(diagnostic?.code).toBe('roster.mcp.unknown-status');
    expect(diagnostic?.message).toContain('reticulating');
  });

  it('reports a compiled server the session never mounted', () => {
    const [diagnostic] = mcpServerDiagnostics(withServers('gmail'), []);
    expect(diagnostic?.code).toBe('roster.mcp.not-mounted');
    expect(diagnostic?.message).toContain('mcp__gmail__*');
  });

  it('rides along on the one assertion the runner calls', () => {
    const diagnostics = assertSessionStart(
      { ...REQUESTED, mcpServers: ['gmail'] },
      { ...HEALTHY_INIT, mcp_servers: [{ name: 'gmail', status: 'needs-auth' }] },
    );
    expect(diagnostics.map((d) => d.code)).toEqual(['roster.mcp.needs-auth']);
  });
});
