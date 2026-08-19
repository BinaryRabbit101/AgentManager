/**
 * The connector library (roster DESIGN §10.3; WO3).
 *
 * WO3's acceptance list, criterion by criterion:
 *
 * - the schema accepts what §10.3 specifies and rejects a bad id, an unknown
 *   key, a credential-shaped literal and `auth: "oauth"` on stdio — **with the
 *   existing messages**, because the config field is `integrationConfigSchema`
 *   itself rather than a copy of it;
 * - the store round-trips, the delete names the agents that would break, and a
 *   colliding id is suffixed the way an agent's is;
 * - an agent attaching `{ connector }` compiles to the same `mcpServers` entry
 *   as the equivalent inline config, and a dangling ref fails the compile with
 *   the agent and the connector named;
 * - the preflight reports the underlying state plus `connector`, and a dangling
 *   ref reports `missing-connector`, which outranks `missing-secret`;
 * - editing the library changes the *next* compile of every referencing agent;
 * - an export inlines the ref, and an import carrying one is refused.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Secret } from '../../secrets/index.js';
import type { SecretResolver } from '../../secrets/index.js';

import { bootstrapLibrary } from './bootstrap.js';
import {
  CONNECTORS_DIRNAME,
  CONNECTOR_JSON_FILENAME,
  CONNECTOR_SCHEMA_VERSION,
  createConnectorStore,
  safeParseConnector,
  serialiseConnector,
  type Connector,
} from './connectors.js';
import {
  compileIntegrations,
  integrationPreflight,
  resolveIntegrations,
  type ConnectorLookup,
} from './integrations.js';
import { buildAgentPack, readAgentPack, PACK_AGENT_PREFIX } from './pack.js';
import { serialiseAgentDefinition } from './parse.js';
import { createRosterRoutes } from './routes.js';
import {
  connectorIdProblem,
  integrationsSchema,
  type AgentDefinition,
  type IntegrationConfig,
} from './schema.js';
import { SessionCompileError } from './sessionOptions.js';
import { loadFixture } from './__tests__/fixtures.js';
import {
  callRoute,
  fakeGit,
  makeHarness,
  makeSpacedTempDir,
  silentLogger,
  writeAgentFolder,
  type Harness,
  type TempDir,
} from './__tests__/helpers.js';

const TOKEN = 'gmail-t0ken-do-not-log';
const RESOLVING: SecretResolver = {
  get: (key) => Promise.resolve(key === 'mcp.gmail.token' ? new Secret(TOKEN) : undefined),
};
const EMPTY: SecretResolver = { get: () => Promise.resolve(undefined) };

/** The fixture mailbox's own stdio server — the config the library holds. */
const GMAIL_CONFIG: IntegrationConfig = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@example/gmail-mcp'],
  env: { GMAIL_PROFILE: 'work', GMAIL_TOKEN: { secretRef: 'mcp.gmail.token' } },
  toolPrefixHint: 'mcp__gmail__',
};

const VALID: Record<string, unknown> = {
  schemaVersion: CONNECTOR_SCHEMA_VERSION,
  id: 'gmail',
  label: 'Gmail (work)',
  description: 'The shared work mailbox.',
  config: GMAIL_CONFIG,
  meta: { createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-19T10:00:00.000Z' },
};

let temp: TempDir;
let harness: Harness;

/** Writes a connector folder the way a hand-editing owner or a `git pull` would. */
function writeConnectorFolder(libraryRoot: string, id: string, contents: string): string {
  const dir = join(libraryRoot, CONNECTORS_DIRNAME, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CONNECTOR_JSON_FILENAME), contents, 'utf8');
  return dir;
}

function connector(over: Record<string, unknown> = {}): Connector {
  const parsed = safeParseConnector({ ...VALID, ...over }, 'test');
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

/** A lookup over a plain table — the seam the compiler actually takes. */
function library(table: Readonly<Record<string, IntegrationConfig>>): ConnectorLookup {
  return (id) => table[id];
}

/** The fixture mailbox, with its inline gmail server replaced by a reference. */
function referencingAgent(): AgentDefinition {
  return { ...loadFixture('email-responder'), integrations: { gmail: { connector: 'gmail' } } };
}

beforeEach(() => {
  temp = makeSpacedTempDir('agentmanager roster connectors ');
  harness = makeHarness({ dataRoot: join(temp.path, 'data') });
  bootstrapLibrary({ root: harness.libraryRoot, git: fakeGit().git, initGit: false });
});

afterEach(() => {
  harness.close();
  temp.cleanup();
});

// ---------------------------------------------------------------------------

describe('the schema (§10.3)', () => {
  it('accepts the shape WO3 specifies', () => {
    const parsed = safeParseConnector(VALID, 'test');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.config).toEqual(GMAIL_CONFIG);
  });

  it('rejects an unknown key rather than ignoring it (§3)', () => {
    const stray = safeParseConnector({ ...VALID, autoMount: true }, 'test');
    expect(stray.ok).toBe(false);
    expect(stray.ok ? '' : stray.error.issues[0]?.path).toBe('autoMount');
  });

  it('holds the id to the integration-name rules, because it is a server name', () => {
    expect(connectorIdProblem('gmail')).toBeUndefined();
    expect(connectorIdProblem('todo_mcp')).toBeUndefined();
    // The existing messages, verbatim: this is `integrationNameProblem`.
    expect(connectorIdProblem('Gmail')).toMatch(/lower-case/);
    expect(connectorIdProblem('g__mail')).toMatch(/__/);
    expect(connectorIdProblem('')).toMatch(/1–64/);
    // Plus the reserved set, because the id is also a folder name and a URL
    // segment: `nul` is not a directory on Windows at all.
    expect(connectorIdProblem('nul')).toMatch(/reserved/);
    expect(safeParseConnector({ ...VALID, id: 'Gmail' }, 'test').ok).toBe(false);
  });

  it('refuses a credential-shaped literal in the config, at the config’s own path', () => {
    const bad = safeParseConnector(
      { ...VALID, config: { ...GMAIL_CONFIG, env: { GMAIL_TOKEN: 'ya29.a0-real-looking-token' } } },
      'test',
    );
    expect(bad.ok).toBe(false);
    const issue = bad.ok ? undefined : bad.error.issues[0];
    expect(issue?.path).toBe('config.env.GMAIL_TOKEN');
    expect(issue?.message).toContain('credential-shaped');
    expect(issue?.message).toContain('secretRef');
  });

  it('refuses auth "oauth" on stdio with §10.1’s sentence', () => {
    const bad = safeParseConnector(
      { ...VALID, config: { transport: 'stdio', command: 'npx', auth: 'oauth' } },
      'test',
    );
    expect(bad.ok).toBe(false);
    expect(bad.ok ? '' : bad.error.issues[0]?.message).toContain('remote MCP servers only');
  });

  it('round-trips through the canonical byte form', () => {
    const bytes = serialiseConnector(connector());
    expect(bytes.endsWith('\n')).toBe(true);
    const again = safeParseConnector(JSON.parse(bytes) as unknown, 'test');
    expect(again.ok && again.value).toEqual(connector());
  });
});

// ---------------------------------------------------------------------------

describe('the reference variant of integrations (§10.3)', () => {
  it('accepts { connector } beside inline configs, and nothing else on it', () => {
    expect(integrationsSchema.safeParse({ gmail: { connector: 'gmail' } }).success).toBe(true);
    expect(
      integrationsSchema.safeParse({ mail: { connector: 'gmail' }, todo: GMAIL_CONFIG }).success,
    ).toBe(true);
    // An override beside the reference would be a second place the connector is
    // defined, which is the problem the library exists to remove.
    expect(
      integrationsSchema.safeParse({ gmail: { connector: 'gmail', command: 'npx' } }).success,
    ).toBe(false);
    expect(integrationsSchema.safeParse({ gmail: { connector: 'Gmail' } }).success).toBe(false);
  });

  it('leaves an inline config’s failures at their own paths (no union summary)', () => {
    const parsed = integrationsSchema.safeParse({
      gmail: { ...GMAIL_CONFIG, env: { GMAIL_TOKEN: 'literal' } },
    });
    expect(parsed.success).toBe(false);
    const issue = parsed.success ? undefined : parsed.error.issues[0];
    // The whole reason the record dispatches on shape rather than unioning: a
    // UI cannot deep-link at a path that is no longer reported.
    expect(issue?.path).toEqual(['gmail', 'env', 'GMAIL_TOKEN']);
    expect(issue?.message).toContain('credential-shaped');
  });

  it('resolves a ref to the library’s config and reports one that dangles', () => {
    const resolved = resolveIntegrations(
      { mail: { connector: 'gmail' }, gone: { connector: 'jira' }, inline: GMAIL_CONFIG },
      library({ gmail: GMAIL_CONFIG }),
    );
    expect(resolved.integrations.map((entry) => entry.name)).toEqual(['mail', 'inline']);
    expect(resolved.integrations[0]?.config).toEqual(GMAIL_CONFIG);
    expect(resolved.integrations[0]?.connector).toBe('gmail');
    expect(resolved.integrations[1]?.connector).toBeUndefined();
    expect(resolved.dangling).toEqual([{ name: 'gone', connector: 'jira' }]);
  });
});

// ---------------------------------------------------------------------------

describe('the store and the registry (§2.3, applied to connectors)', () => {
  it('writes through the store and reads the same document back', () => {
    const store = createConnectorStore({ root: harness.libraryRoot });
    const written = store.write(connector());
    expect(written.connector).toEqual(connector());
    expect(store.hasFolder('gmail')).toBe(true);
    expect(store.folderNames()).toEqual(['gmail']);
  });

  it('loads a hand-written folder, and reports a malformed one as a diagnostic', async () => {
    writeConnectorFolder(harness.libraryRoot, 'gmail', JSON.stringify(VALID));
    writeConnectorFolder(harness.libraryRoot, 'broken', '{ not json');
    harness.service.load();

    const listed = await harness.service.listConnectors();
    expect(listed.connectors.map((one) => one.id)).toEqual(['gmail']);
    expect(listed.diagnostics[0]?.code).toBe('roster.invalid-connector');
    expect(listed.diagnostics[0]?.level).toBe('error');
    expect(listed.diagnostics[0]?.path).toContain(CONNECTOR_JSON_FILENAME);
  });

  it('refuses a folder whose name disagrees with the id inside it', () => {
    writeConnectorFolder(harness.libraryRoot, 'elsewhere', JSON.stringify(VALID));
    harness.service.load();
    expect(harness.service.connectorDiagnostics()[0]?.code).toBe('roster.connector-id-mismatch');
  });

  it('picks up an added, edited and removed connector on reload', async () => {
    harness.service.load();
    expect((await harness.service.listConnectors()).connectors).toEqual([]);

    writeConnectorFolder(harness.libraryRoot, 'gmail', JSON.stringify(VALID));
    expect(harness.service.reloadConnectorFolders(['gmail']).changed).toBe(true);
    expect((await harness.service.getConnector('gmail')).label).toBe('Gmail (work)');

    // An identical rewrite is not a change — the content-hash rule the agent
    // registry uses, so the watcher and the writer cannot feed each other.
    writeConnectorFolder(harness.libraryRoot, 'gmail', JSON.stringify(VALID));
    expect(harness.service.reloadConnectorFolders(['gmail']).changed).toBe(false);

    writeConnectorFolder(
      harness.libraryRoot,
      'gmail',
      JSON.stringify({ ...VALID, label: 'Gmail (personal)' }),
    );
    expect(harness.service.reloadConnectorFolders(['gmail']).changed).toBe(true);
    expect((await harness.service.getConnector('gmail')).label).toBe('Gmail (personal)');
  });
});

// ---------------------------------------------------------------------------

describe('the CRUD surface (§9.1, §10.3)', () => {
  it('creates with an id derived from the label, and suffixes a collision', async () => {
    harness.service.load();

    const first = await harness.service.createConnector({
      label: 'Gmail',
      config: GMAIL_CONFIG,
    });
    expect(first.id).toBe('gmail');
    expect(first.transport).toBe('stdio');
    expect(first.toolPrefix).toBe('mcp__gmail__');

    const second = await harness.service.createConnector({ label: 'Gmail', config: GMAIL_CONFIG });
    expect(second.id).toBe('gmail-2');

    // And an id the caller chose, when it is taken, is a refusal rather than a
    // silent write somewhere else.
    await expect(
      harness.service.createConnector({ id: 'gmail', config: GMAIL_CONFIG }),
    ).rejects.toMatchObject({ code: 'connector_id_taken', status: 409 });
  });

  it('reports credential names and never a value', async () => {
    harness.service.load();
    const view = await harness.service.createConnector({ label: 'Gmail', config: GMAIL_CONFIG });
    expect(view.credentials).toEqual([{ secretRef: 'mcp.gmail.token', resolved: false }]);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it('patches label, description and config, and refuses to move the id', async () => {
    harness.service.load();
    await harness.service.createConnector({ id: 'gmail', label: 'Gmail', config: GMAIL_CONFIG });

    const patched = await harness.service.patchConnector('gmail', {
      description: 'The shared work mailbox.',
      config: { ...GMAIL_CONFIG, args: ['-y', '@example/gmail-mcp', '--verbose'] },
    });
    expect(patched.description).toBe('The shared work mailbox.');
    expect(patched.config).toMatchObject({ args: ['-y', '@example/gmail-mcp', '--verbose'] });
    expect(patched.label).toBe('Gmail');

    // `null` clears; an absent key leaves alone (§9.1's three-way distinction).
    expect((await harness.service.patchConnector('gmail', { description: null })).description).toBe(
      undefined,
    );

    await expect(harness.service.patchConnector('gmail', { id: 'gmail-2' })).rejects.toMatchObject({
      code: 'immutable_field',
    });
  });

  it('refuses a delete while an agent references it, and names the agents', async () => {
    writeAgentFolder(harness.libraryRoot, referencingAgent());
    writeConnectorFolder(harness.libraryRoot, 'gmail', JSON.stringify(VALID));
    harness.service.load();

    expect(harness.service.connectorUsedBy('gmail')).toEqual(['marcus-inbox']);
    expect((await harness.service.getConnector('gmail')).usedBy).toEqual(['marcus-inbox']);
    expect(() => harness.service.removeConnector('gmail')).toThrowError(/marcus-inbox/);

    // Detach it, and the same delete goes through.
    harness.service.patch('marcus-inbox', { integrations: {} });
    expect(harness.service.removeConnector('gmail')).toEqual({
      connectorId: 'gmail',
      removed: true,
    });
    await expect(harness.service.getConnector('gmail')).rejects.toMatchObject({
      code: 'connector_not_found',
      status: 404,
    });
  });

  it('announces a connector edit on the roster’s own channel', async () => {
    harness.service.load();
    const before = harness.events.length;
    await harness.service.createConnector({ label: 'Gmail', config: GMAIL_CONFIG });

    const emitted = harness.events.slice(before);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe('roster.changed');
    expect((emitted[0]?.payload as { reason: string }).reason).toBe('connectors');
    // A library file is not agent history: nothing is written to `events`.
    expect(emitted[0]?.persist).toBe(false);
  });

  it('serves the five routes, with a 409 body that lists the referencing agents', async () => {
    writeAgentFolder(harness.libraryRoot, referencingAgent());
    writeConnectorFolder(harness.libraryRoot, 'gmail', JSON.stringify(VALID));
    harness.service.load();
    const routes = createRosterRoutes({ service: harness.service, logger: silentLogger() });

    const listed = await callRoute(routes, 'GET', '/api/roster/connectors');
    expect(listed.status).toBe(200);
    expect((listed.body as { connectors: { id: string }[] }).connectors.map((c) => c.id)).toEqual([
      'gmail',
    ]);

    const created = await callRoute(routes, 'POST', '/api/roster/connectors', {
      body: { label: 'Todo', config: { transport: 'http', url: 'https://todo.test/mcp' } },
    });
    expect(created.status).toBe(201);
    expect(created.headers['location']).toBe('/api/roster/connectors/todo');

    const one = await callRoute(routes, 'GET', '/api/roster/connectors/:id', {
      params: { id: 'todo' },
    });
    expect(one.status).toBe(200);

    const patched = await callRoute(routes, 'PATCH', '/api/roster/connectors/:id', {
      params: { id: 'todo' },
      body: { label: 'Todo (work)' },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as { label: string }).label).toBe('Todo (work)');

    const refused = await callRoute(routes, 'DELETE', '/api/roster/connectors/:id', {
      params: { id: 'gmail' },
    });
    expect(refused.status).toBe(409);
    const body = refused.body as { error: string; agentIds: string[] };
    expect(body.error).toBe('connector_in_use');
    expect(body.agentIds).toEqual(['marcus-inbox']);

    const deleted = await callRoute(routes, 'DELETE', '/api/roster/connectors/:id', {
      params: { id: 'todo' },
    });
    expect(deleted.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('compiling a reference (§10.3)', () => {
  const sessionEnv = { PATH: 'C:\\Windows\\System32' };

  it('produces the same mcpServers entry as the equivalent inline config', async () => {
    const inline = await compileIntegrations({
      agentId: 'marcus-inbox',
      agentName: 'Marcus',
      integrations: { gmail: GMAIL_CONFIG },
      secrets: RESOLVING,
      sessionEnv,
    });
    const referenced = await compileIntegrations({
      agentId: 'marcus-inbox',
      agentName: 'Marcus',
      integrations: { gmail: { connector: 'gmail' } },
      secrets: RESOLVING,
      sessionEnv,
      connectors: library({ gmail: GMAIL_CONFIG }),
    });

    expect(referenced.servers).toEqual(inline.servers);
    expect(JSON.stringify(referenced.servers)).toBe(JSON.stringify(inline.servers));
    // The env spread is the interesting half: a second code path would very
    // plausibly have got `PATH` right and the ordering wrong.
    expect(referenced.servers['gmail']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@example/gmail-mcp'],
      env: { PATH: 'C:\\Windows\\System32', GMAIL_PROFILE: 'work', GMAIL_TOKEN: TOKEN },
    });
  });

  it('mounts a reference under the agent-local name, not the connector id', async () => {
    const { servers } = await compileIntegrations({
      agentId: 'marcus-inbox',
      agentName: 'Marcus',
      integrations: { 'work-mail': { connector: 'gmail' } },
      secrets: RESOLVING,
      connectors: library({ gmail: GMAIL_CONFIG }),
    });
    expect(Object.keys(servers)).toEqual(['work-mail']);
  });

  it('refuses the launch when the reference dangles, naming the agent and the id', async () => {
    const failure = await compileIntegrations({
      agentId: 'marcus-inbox',
      agentName: 'Marcus',
      integrations: { gmail: { connector: 'gmail' } },
      secrets: RESOLVING,
      connectors: library({}),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionCompileError);
    const error = failure as SessionCompileError;
    expect(error.message).toContain('Marcus');
    expect(error.message).toContain('gmail');
    expect(error.diagnostics[0]?.code).toBe('roster.connector.unresolved');
    expect(error.diagnostics[0]?.path).toBe('integrations.gmail.connector');
  });

  it('carries a library edit into the next compile, with nothing to invalidate', async () => {
    const table: Record<string, IntegrationConfig> = { gmail: GMAIL_CONFIG };
    const lookup: ConnectorLookup = (id) => table[id];
    const input = {
      agentId: 'marcus-inbox',
      agentName: 'Marcus',
      integrations: { gmail: { connector: 'gmail' } },
      secrets: RESOLVING,
      connectors: lookup,
    };

    const before = await compileIntegrations(input);
    expect(before.servers['gmail']).toMatchObject({ command: 'npx' });

    table['gmail'] = { ...GMAIL_CONFIG, command: 'gmail-mcp' };
    const after = await compileIntegrations(input);
    expect(after.servers['gmail']).toMatchObject({ command: 'gmail-mcp' });
  });
});

// ---------------------------------------------------------------------------

describe('the preflight (§10.2, §10.3)', () => {
  it('reports the underlying state and says the row came from the library', async () => {
    const rows = await integrationPreflight({
      definition: { integrations: { mail: { connector: 'gmail' } } },
      secrets: RESOLVING,
      connectors: library({ gmail: GMAIL_CONFIG }),
    });
    expect(rows[0]).toMatchObject({
      integration: 'mail',
      connector: 'gmail',
      transport: 'stdio',
      state: 'ready',
    });
    expect(rows[0]?.credentials).toEqual([
      expect.objectContaining({ secretRef: 'mcp.gmail.token', resolved: true }),
    ]);
  });

  it('reports the resolved connector’s missing secret, not the reference', async () => {
    const rows = await integrationPreflight({
      definition: { integrations: { mail: { connector: 'gmail' } } },
      secrets: EMPTY,
      connectors: library({ gmail: GMAIL_CONFIG }),
    });
    expect(rows[0]?.state).toBe('missing-secret');
    expect(rows[0]?.connector).toBe('gmail');
    expect(rows[0]?.missingSecretRefs).toEqual(['mcp.gmail.token']);
  });

  it('reports a dangling reference as missing-connector, outranking missing-secret', async () => {
    const rows = await integrationPreflight({
      definition: {
        integrations: { gone: { connector: 'jira' }, mail: GMAIL_CONFIG },
      },
      // Nothing resolves, so the *inline* server is `missing-secret` — and the
      // dangling reference is still the worse state, said as its own.
      secrets: EMPTY,
      connectors: library({}),
    });

    const gone = rows.find((row) => row.integration === 'gone');
    expect(gone?.state).toBe('missing-connector');
    expect(gone?.connector).toBe('jira');
    expect(gone?.transport).toBeUndefined();
    expect(gone?.credentials).toEqual([]);
    expect(gone?.detail).toContain('jira');
    expect(rows.find((row) => row.integration === 'mail')?.state).toBe('missing-secret');
    // Declared order is kept: a row that moved when a library entry was deleted
    // would look like a different connector.
    expect(rows.map((row) => row.integration)).toEqual(['gone', 'mail']);
  });

  it('treats "no library at all" as a dangling reference, not as no integration', async () => {
    const rows = await integrationPreflight({
      definition: { integrations: { mail: { connector: 'gmail' } } },
      secrets: RESOLVING,
    });
    expect(rows[0]?.state).toBe('missing-connector');
  });

  it('is what the service serves, resolved against the live library', async () => {
    writeAgentFolder(harness.libraryRoot, referencingAgent());
    writeConnectorFolder(harness.libraryRoot, 'gmail', JSON.stringify(VALID));
    harness.service.load();

    const rows = await harness.service.integrations('marcus-inbox');
    expect(rows[0]).toMatchObject({ integration: 'gmail', connector: 'gmail', transport: 'stdio' });
    // The harness wires no secret store, so the ref cannot resolve — which is
    // `missing-secret` rather than `missing-connector`: the *connector* is
    // perfectly present.
    expect(rows[0]?.state).toBe('missing-secret');
  });
});

// ---------------------------------------------------------------------------

describe('export and import (§9.4, §10.3)', () => {
  it('inlines the reference into the pack, leaving no connector key', () => {
    writeAgentFolder(harness.libraryRoot, referencingAgent());
    writeConnectorFolder(harness.libraryRoot, 'gmail', JSON.stringify(VALID));
    harness.service.load();

    const pack = readAgentPack(harness.service.exportPack('marcus-inbox').bytes);
    expect(pack.definition.integrations?.['gmail']).toEqual(GMAIL_CONFIG);
    expect(JSON.stringify(pack.definition)).not.toContain('"connector"');
    // Refs, not values — §9.4's posture is untouched by the inlining.
    expect(pack.manifest.requiredSecrets.map((secret) => secret.ref)).toEqual(['mcp.gmail.token']);
    expect(JSON.stringify(pack.definition)).not.toContain(TOKEN);
  });

  it('refuses to export while the reference dangles', () => {
    writeAgentFolder(harness.libraryRoot, referencingAgent());
    harness.service.load();
    expect(() => harness.service.exportPack('marcus-inbox')).toThrowError(/inlines its connectors/);
  });

  it('refuses to import a pack that carries a reference, saying exports are inlined', () => {
    const definition = referencingAgent();
    const bytes = buildAgentPack({
      definition,
      files: [
        { name: 'agent.json', data: Buffer.from(serialiseAgentDefinition(definition)) },
        { name: 'persona.md', data: Buffer.from('# Marcus\n') },
      ],
      exportedAt: '2026-08-19T10:00:00.000Z',
    });
    // Assembled by hand — no export writes this, which is the point.
    expect(bytes.toString('latin1')).toContain(`${PACK_AGENT_PREFIX}agent.json`);
    expect(() => readAgentPack(bytes)).toThrowError(/Exports inline their connectors/);
  });

  it('keeps a reference as a reference through duplicate (same library, same machine)', () => {
    writeAgentFolder(harness.libraryRoot, referencingAgent());
    writeConnectorFolder(harness.libraryRoot, 'gmail', JSON.stringify(VALID));
    harness.service.load();

    const clone = harness.service.duplicate('marcus-inbox', { name: 'Marcus Two' });
    expect(clone.definition.integrations?.['gmail']).toEqual({ connector: 'gmail' });
    expect(harness.service.connectorUsedBy('gmail')).toEqual(['marcus-inbox', 'marcus-two']);
  });
});
