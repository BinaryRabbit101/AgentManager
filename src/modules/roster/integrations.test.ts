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
  integrationPreflight,
  integrationSecretRefs,
  isOAuthIntegration,
  mcpToolPrefix,
  validateIntegrationAllowRules,
} from './integrations.js';
import { integrationsSchema, type AgentDefinition } from './schema.js';
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

// ---------------------------------------------------------------------------
// OAuth and the preflight projection (§10, WO6)
// ---------------------------------------------------------------------------

describe('auth: "oauth" (§10, WO6 item 1)', () => {
  it('is accepted on http and sse, and compiles to a server with no credential header', async () => {
    const { servers } = await compileIntegrations({
      agentId: 'a',
      agentName: 'A',
      integrations: integrationsSchema.parse({
        todo: { transport: 'http', url: 'https://todo.example/mcp', auth: 'oauth' },
        calendar: { transport: 'sse', url: 'https://cal.example/sse', auth: 'oauth' },
      }),
      secrets: EMPTY,
    });
    expect(servers['todo']).toEqual({ type: 'http', url: 'https://todo.example/mcp' });
    expect(servers['calendar']).toEqual({ type: 'sse', url: 'https://cal.example/sse' });
    // The SDK has no auth field to compile to (sdk.d.ts:1037, :1152), so the
    // absence of one here is the whole mechanism rather than an omission.
    expect(JSON.stringify(servers)).not.toContain('auth');
  });

  it('keeps a non-credential header, because a routing header is not auth', () => {
    const parsed = integrationsSchema.parse({
      todo: {
        transport: 'http',
        url: 'https://todo.example/mcp',
        auth: 'oauth',
        headers: { 'X-Tenant': 'acme' },
      },
    });
    expect(parsed['todo']).toMatchObject({ auth: 'oauth', headers: { 'X-Tenant': 'acme' } });
  });

  it('is rejected on stdio, and says why rather than "unrecognized key"', () => {
    const result = integrationsSchema.safeParse({
      local: { transport: 'stdio', command: 'node', auth: 'oauth' },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('remote MCP servers only');
  });

  it('is rejected beside a credential-shaped header or a secretRef', () => {
    const shaped = integrationsSchema.safeParse({
      todo: {
        transport: 'http',
        url: 'https://todo.example/mcp',
        auth: 'oauth',
        headers: { Authorization: { secretRef: 'mcp.todo.token' } },
      },
    });
    expect(shaped.success).toBe(false);
    expect(JSON.stringify(shaped.error?.issues)).toContain('mutually exclusive');

    const ref = integrationsSchema.safeParse({
      todo: {
        transport: 'sse',
        url: 'https://todo.example/sse',
        auth: 'oauth',
        headers: { 'X-Api-Key': { secretRef: 'mcp.todo.key' } },
      },
    });
    expect(ref.success).toBe(false);
    expect(JSON.stringify(ref.error?.issues)).toContain('mutually exclusive');
  });

  it('carries no secretRef, so an export of it requires no secret material at all', () => {
    const definition = withIntegrations(
      integrationsSchema.parse({
        todo: { transport: 'http', url: 'https://todo.example/mcp', auth: 'oauth' },
      }),
    );
    expect(integrationSecretRefs(definition)).toEqual([]);
    expect(isOAuthIntegration(definition.integrations?.['todo'] as never)).toBe(true);
  });
});

describe('the preflight projection (§10, WO6 item 2)', () => {
  const oauthAndCreds = (): AgentDefinition =>
    withIntegrations(
      integrationsSchema.parse({
        todo: { transport: 'http', url: 'https://todo.example/mcp', auth: 'oauth' },
        gmail: {
          transport: 'stdio',
          command: 'node',
          env: { GMAIL_TOKEN: { secretRef: 'mcp.gmail.token' } },
        },
      }),
    );

  it('answers ready / needs-auth per integration, and reveals no value', async () => {
    const states = await integrationPreflight({
      definition: oauthAndCreds(),
      secrets: RESOLVING,
    });
    const byName = Object.fromEntries(states.map((state) => [state.integration, state]));

    expect(byName['gmail']?.state).toBe('ready');
    expect(byName['gmail']?.credentials).toEqual([
      expect.objectContaining({ secretRef: 'mcp.gmail.token', resolved: true }),
    ]);
    // The OAuth default is cautious: no session has connected, so the grant is
    // unknown — and unknown is reported as needs-auth rather than as ready.
    expect(byName['todo']?.state).toBe('needs-auth');
    expect(byName['todo']?.auth).toBe('oauth');
    expect(byName['todo']?.toolPrefix).toBe('mcp__todo__');

    expect(JSON.stringify(states)).not.toContain(TOKEN);
  });

  it('reports missing-secret when a ref does not resolve, and names only the ref', async () => {
    const states = await integrationPreflight({ definition: oauthAndCreds(), secrets: EMPTY });
    const gmail = states.find((state) => state.integration === 'gmail');
    expect(gmail?.state).toBe('missing-secret');
    expect(gmail?.missingSecretRefs).toEqual(['mcp.gmail.token']);
    expect(gmail?.detail).toContain('mcp.gmail.token');
  });

  it('promotes an OAuth server to ready once a session has reported it connected', async () => {
    const states = await integrationPreflight({
      definition: oauthAndCreds(),
      secrets: RESOLVING,
      lastSeen: { todo: 'connected' },
    });
    expect(states.find((state) => state.integration === 'todo')?.state).toBe('ready');
  });

  it('demotes a credential server the last session could not connect', async () => {
    const states = await integrationPreflight({
      definition: oauthAndCreds(),
      secrets: RESOLVING,
      lastSeen: { gmail: 'failed' },
    });
    expect(states.find((state) => state.integration === 'gmail')?.state).toBe('needs-auth');
  });

  it('reports a required-but-undeclared connector as not-attached', async () => {
    const states = await integrationPreflight({
      definition: oauthAndCreds(),
      secrets: RESOLVING,
      required: ['todo', 'jira'],
    });
    expect(states.find((state) => state.integration === 'todo')?.required).toBe(true);
    const jira = states.find((state) => state.integration === 'jira');
    expect(jira?.state).toBe('not-attached');
    expect(jira?.transport).toBeUndefined();
    expect(jira?.detail).toContain('does not declare it');
  });
});
