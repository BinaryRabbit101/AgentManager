/**
 * Integrations and secret resolution (roster DESIGN §10, IMPLEMENTATION M6).
 *
 * The three transports, the resolution of a `secretRef` at compile time (the
 * authorized reveal site of foundation §3.2), the launch-time refusal that names
 * the ref, the `{ secretRef, resolved }` shape, and the validator warning for an
 * integration with no matching `mcp__<server>__*` rule.
 */
import { describe, expect, it } from 'vitest';

import { Secret } from '../../secrets/index.js';
import type { SecretResolver } from '../../secrets/index.js';

import { loadFixture } from './__tests__/fixtures.js';
import {
  compileIntegrations,
  integrationCredentialStatus,
  integrationSecretRefs,
  mcpToolPrefix,
  validateIntegrationAllowRules,
} from './integrations.js';
import type { AgentDefinition } from './schema.js';
import { SessionCompileError } from './sessionOptions.js';

const TOKEN = 'gmail-t0ken-do-not-log';

const RESOLVING: SecretResolver = {
  get: (key) => Promise.resolve(key === 'mcp.gmail.token' ? new Secret(TOKEN) : undefined),
};
const EMPTY: SecretResolver = { get: () => Promise.resolve(undefined) };

const MAILBOX = loadFixture('email-responder');

function withIntegrations(integrations: AgentDefinition['integrations']): AgentDefinition {
  return { ...MAILBOX, integrations };
}

describe('the three transports (§10)', () => {
  it('compiles stdio to { command, args, env } with the ref resolved', async () => {
    const { servers } = await compileIntegrations({
      agentId: MAILBOX.id,
      agentName: MAILBOX.name,
      integrations: MAILBOX.integrations,
      secrets: RESOLVING,
      sessionEnv: { PATH: 'C:\\Windows\\System32' },
    });

    expect(servers['gmail']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@example/gmail-mcp'],
      env: {
        // §10's PATH guard: `env` replaces rather than merges, so the session
        // environment is spread in beneath the integration's own entries.
        PATH: 'C:\\Windows\\System32',
        GMAIL_PROFILE: 'work',
        GMAIL_TOKEN: TOKEN,
      },
    });
  });

  it('omits env entirely when the integration declares none, leaving inheritance alone', async () => {
    const { servers } = await compileIntegrations({
      agentId: 'x',
      agentName: 'X',
      integrations: { plain: { transport: 'stdio', command: 'server' } },
      secrets: EMPTY,
      sessionEnv: { PATH: 'p' },
    });
    expect(servers['plain']).toEqual({ type: 'stdio', command: 'server' });
  });

  it('compiles sse and http to { type, url, headers } — and never streamable-http', async () => {
    const { servers } = await compileIntegrations({
      agentId: 'x',
      agentName: 'X',
      integrations: {
        events: {
          transport: 'sse',
          url: 'https://example.test/sse',
          headers: { Authorization: { secretRef: 'mcp.gmail.token' } },
        },
        api: {
          transport: 'http',
          url: 'https://example.test/mcp',
          headers: { 'X-Tenant': 'acme' },
        },
      },
      secrets: RESOLVING,
    });

    expect(servers['events']).toEqual({
      type: 'sse',
      url: 'https://example.test/sse',
      headers: { Authorization: TOKEN },
    });
    expect(servers['api']).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { 'X-Tenant': 'acme' },
    });
    for (const server of Object.values(servers)) {
      expect(server.type).not.toBe('streamable-http');
    }
  });

  it('is an empty record for an agent with no integrations', async () => {
    const { servers } = await compileIntegrations({
      agentId: 'x',
      agentName: 'X',
      integrations: undefined,
      secrets: EMPTY,
    });
    expect(servers).toEqual({});
  });
});

describe('an unresolvable ref (§10)', () => {
  it('fails with an error naming the agent and the ref, and starts nothing', async () => {
    const failure = await compileIntegrations({
      agentId: MAILBOX.id,
      agentName: MAILBOX.name,
      integrations: MAILBOX.integrations,
      secrets: EMPTY,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionCompileError);
    const error = failure as SessionCompileError;
    expect(error.message).toContain('Marcus');
    expect(error.message).toContain('mcp.gmail.token');
    expect(error.diagnostics[0]?.code).toBe('roster.secret.unresolved');
    expect(error.diagnostics[0]?.path).toBe('integrations.gmail.env.GMAIL_TOKEN');
  });
});

describe('the { secretRef, resolved } shape (§10)', () => {
  it('enumerates every ref with its position in the definition', () => {
    expect(integrationSecretRefs(MAILBOX)).toEqual([
      {
        integration: 'gmail',
        kind: 'env',
        key: 'GMAIL_TOKEN',
        secretRef: 'mcp.gmail.token',
        path: 'integrations.gmail.env.GMAIL_TOKEN',
      },
    ]);
  });

  it('reports resolved: true without ever revealing the value', async () => {
    const status = await integrationCredentialStatus(MAILBOX, RESOLVING);
    expect(status).toEqual([
      expect.objectContaining({ secretRef: 'mcp.gmail.token', resolved: true }),
    ]);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it('reports resolved: false for a missing credential', async () => {
    const status = await integrationCredentialStatus(MAILBOX, EMPTY);
    expect(status[0]?.resolved).toBe(false);
  });

  it('finds refs in headers as well as env', () => {
    const refs = integrationSecretRefs(
      withIntegrations({
        api: {
          transport: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: { secretRef: 'mcp.api.key' } },
        },
      }),
    );
    expect(refs[0]).toMatchObject({ kind: 'headers', key: 'Authorization' });
  });
});

describe('the validator warning (§10)', () => {
  it('names the prefix a permission rule would have to use', () => {
    expect(mcpToolPrefix('gmail')).toBe('mcp__gmail__');
  });

  it('warns when an integration has no matching mcp__<server>__* allow rule', () => {
    const diagnostics = validateIntegrationAllowRules({
      ...MAILBOX,
      permissions: { allow: ['Read'], deny: [], ask: [] },
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.level).toBe('warn');
    expect(diagnostics[0]?.code).toBe('roster.integration.no-allow-rule');
    expect(diagnostics[0]?.message).toContain('mcp__gmail__*');
    expect(diagnostics[0]?.path).toBe('integrations.gmail');
  });

  it('is silent for the fixture, which does declare its rules', () => {
    expect(validateIntegrationAllowRules(MAILBOX)).toEqual([]);
  });

  it('counts an ask rule as an answer — a deliberately gated integration is configured', () => {
    expect(
      validateIntegrationAllowRules({
        ...MAILBOX,
        permissions: { allow: [], ask: ['mcp__gmail__send_*'] },
      }),
    ).toEqual([]);
  });

  it('says nothing about an agent with no integrations', () => {
    expect(validateIntegrationAllowRules(loadFixture('coder'))).toEqual([]);
  });
});
