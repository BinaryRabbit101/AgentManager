/**
 * `.agentpack` import / export (roster DESIGN §9.4, IMPLEMENTATION M9).
 *
 * M9's acceptance, criterion by criterion:
 *
 * - "Export → import into a fresh data directory reproduces the agent
 *   byte-for-byte except `id` (on collision) and `meta`" — asserted twice, once
 *   into a *genuinely separate* library (no collision, so not even the id moves)
 *   and once back into the library it came from (collision, so the id does).
 * - "A pack containing a secret value anywhere fails export (guard test)".
 * - "Importing a pack whose `schemaVersion` exceeds the build's is refused with
 *   both numbers in the message".
 * - "Preview lists collisions, missing secrets, and skills to be added, and
 *   writes nothing" — the last clause is asserted against the filesystem and the
 *   event bus, not inferred.
 *
 * The fifth criterion, `POST /agents/:id/validate`, landed with M3 and is held
 * by `validate.test.ts`; see the note at the head of that file.
 *
 * Every case goes through the real store, the real registry and the real service
 * against a temp library, because the whole point of a pack is that it is a
 * faithful copy of a *folder* — a test that packed an object literal would prove
 * nothing about the persona, the roles or the skills that make the folder the
 * unit of export (§2.1).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Secret, type SecretResolver } from '../../secrets/index.js';
import { createZip } from '../../http/zip.js';

import {
  PACK_AGENT_PREFIX,
  PACK_MANIFEST_FILENAME,
  PACK_VERSION,
  buildAgentPack,
  packFilename,
  readAgentPack,
  requiredSecretsFor,
  secretValueViolations,
  type PackManifest,
} from './pack.js';
import { createRosterRoutes } from './routes.js';
import { createRosterService, type ImportResult, type RosterService } from './service.js';
import {
  InvalidAgentPackError,
  PackSchemaVersionError,
  PackSecretValueError,
} from './serviceErrors.js';
import { AGENT_SCHEMA_VERSION, type AgentDefinition } from './schema.js';
import { serialiseAgentDefinition } from './parse.js';
import {
  callRoute,
  makeHarness,
  makeSpacedTempDir,
  multipartBody,
  silentLogger,
  writeFixtureAgent,
  type Harness,
  type TempDir,
} from './__tests__/helpers.js';
import { loadFixture } from './__tests__/fixtures.js';

let temp: TempDir;
let harness: Harness;

/** A secret store that holds exactly the refs it is given. */
function secretsHolding(...refs: readonly string[]): SecretResolver {
  const held = new Set(refs);
  return {
    get: (key) => Promise.resolve(held.has(key) ? new Secret(`value-of-${key}`) : undefined),
  };
}

function serviceOver(library: Harness, secrets: SecretResolver = secretsHolding()): RosterService {
  const service = createRosterService({
    store: library.store,
    uiState: library.uiState,
    agents: library.storage.store.agents,
    sessions: library.storage.store.sessions,
    bus: library.bus,
    secrets,
  });
  service.load();
  return service;
}

/** The live agent folders, `[]` when the library has none yet. */
function agentFolders(libraryRoot: string): string[] {
  const dir = join(libraryRoot, 'agents');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** An agent folder with every kind of content a pack has to carry. */
function writeRichAgent(libraryRoot: string): AgentDefinition {
  const definition = writeFixtureAgent(libraryRoot, 'coder', {
    persona: '# Priya\n\nReproduce first. Then fix.\n',
    files: {
      'roles/skeptic.md': 'Attack the change you are shown.\n',
      'roles/architect.md': 'Say what you would build, and why not the alternative.\n',
      'skills/triage-a-stack-trace/SKILL.md':
        '---\nname: triage-a-stack-trace\ndescription: Read a trace.\n---\n\nStart at the bottom.\n',
      'skills/triage-a-stack-trace/reference.md': 'Frames are innermost-first.\n',
    },
  });
  return definition;
}

beforeEach(() => {
  temp = makeSpacedTempDir('agentmanager roster pack ');
  harness = makeHarness({ dataRoot: join(temp.path, 'data') });
});

afterEach(() => {
  harness.close();
  temp.cleanup();
});

// ---------------------------------------------------------------------------

describe('the pack format (DESIGN §9.4)', () => {
  it('holds the manifest at the root and the agent folder under agent/', () => {
    const definition = writeRichAgent(harness.libraryRoot);
    harness.service.load();

    const bytes = harness.service.exportPack(definition.id).bytes;
    const read = readAgentPack(bytes);

    expect(read.manifest.packVersion).toBe(PACK_VERSION);
    expect(read.manifest.agentId).toBe(definition.id);
    expect(read.manifest.schemaVersion).toBe(AGENT_SCHEMA_VERSION);
    expect(read.files.map((file) => file.name).sort()).toEqual([
      'agent.json',
      'persona.md',
      'roles/architect.md',
      'roles/skeptic.md',
      'skills/triage-a-stack-trace/SKILL.md',
      'skills/triage-a-stack-trace/reference.md',
    ]);
    expect(read.skills).toEqual(['triage-a-stack-trace']);
    expect(packFilename(definition.id)).toBe(`${definition.id}.agentpack`);
  });

  it('names every required secret in the manifest, as a ref and a description', () => {
    writeFixtureAgent(harness.libraryRoot, 'email-responder');
    harness.service.load();

    const read = readAgentPack(harness.service.exportPack('marcus-inbox').bytes);
    expect(read.manifest.requiredSecrets).toEqual([
      {
        ref: 'mcp.gmail.token',
        usedBy: 'integrations.gmail.env.GMAIL_TOKEN',
        description: 'GMAIL_TOKEN for the "gmail" MCP server (stdio environment)',
      },
    ]);
    // The manifest is derived from the definition and from nothing else.
    expect(requiredSecretsFor(read.definition)).toEqual(read.manifest.requiredSecrets);
  });

  it('leaves the generated plugin manifest out of the pack', () => {
    const definition = writeRichAgent(harness.libraryRoot);
    harness.service.load();
    // Loading regenerates it (§7.1), so it is genuinely on disk at this point.
    expect(existsSync(join(harness.libraryRoot, 'agents', definition.id, '.claude-plugin'))).toBe(
      true,
    );

    const read = readAgentPack(harness.service.exportPack(definition.id).bytes);
    expect(read.files.some((file) => file.name.startsWith('.claude-plugin/'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// "A pack containing a secret value anywhere fails export (guard test)"
// ---------------------------------------------------------------------------

describe('the secret-value guard (M9)', () => {
  it('refuses to export an agent whose folder holds a literal credential', () => {
    const definition = writeRichAgent(harness.libraryRoot);
    // A skill's own config file, placed by hand — the definition itself cannot
    // carry a literal under a credential-shaped key, because §10's schema rule
    // already refuses it, so the realistic leak is beside it.
    writeFileSync(
      join(
        harness.libraryRoot,
        'agents',
        definition.id,
        'skills',
        'triage-a-stack-trace',
        'config.json',
      ),
      JSON.stringify({ endpoint: 'https://example.test', GMAIL_TOKEN: 'ya29.a0-live-value' }),
      'utf8',
    );
    harness.service.load();

    let thrown: unknown;
    try {
      harness.service.exportPack(definition.id);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PackSecretValueError);
    const error = thrown as PackSecretValueError;
    expect(error.status).toBe(409);
    expect(error.message).toContain('skills/triage-a-stack-trace/config.json');
    expect(error.message).toContain('GMAIL_TOKEN');
    // The refusal names the key and never the value — the whole reason to refuse.
    expect(error.message).not.toContain('ya29.a0-live-value');
    expect(JSON.stringify(error.details)).not.toContain('ya29.a0-live-value');
  });

  it('refuses a definition whose integrations carry a value rather than a ref', () => {
    const source = loadFixture('email-responder');
    // Constructed directly: the schema makes this unrepresentable, which is
    // exactly why the guard has to be a second, independent check rather than a
    // restatement of the first.
    const leaky = structuredClone(source) as AgentDefinition & {
      integrations: Record<string, { env: Record<string, unknown> }>;
    };
    leaky.integrations['gmail']!.env['GMAIL_TOKEN'] = 'ya29.a0-live-value';

    expect(() =>
      buildAgentPack({
        definition: leaky,
        files: [{ name: 'agent.json', data: Buffer.from(JSON.stringify(leaky)) }],
        exportedAt: '2026-08-16T10:00:00.000Z',
      }),
    ).toThrow(PackSecretValueError);
  });

  it('lets refs and non-credential literals through', () => {
    // `GMAIL_PROFILE` is a literal and stays one: the rule is about
    // credential-*shaped* keys, and widening it would make every export a fight.
    const violations = secretValueViolations([
      {
        name: 'agent.json',
        data: Buffer.from(
          JSON.stringify({
            integrations: {
              gmail: {
                env: { GMAIL_PROFILE: 'work', GMAIL_TOKEN: { secretRef: 'mcp.gmail.token' } },
              },
            },
          }),
        ),
      },
      { name: 'persona.md', data: Buffer.from('My api_key is not a JSON key.') },
    ]);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// "Importing a pack whose schemaVersion exceeds the build's is refused with
//  both numbers in the message"
// ---------------------------------------------------------------------------

describe('a pack from a newer build (M9)', () => {
  function packWithManifest(manifest: PackManifest, definition: AgentDefinition): Buffer {
    return createZip([
      { name: PACK_MANIFEST_FILENAME, data: Buffer.from(JSON.stringify(manifest)) },
      {
        name: `${PACK_AGENT_PREFIX}agent.json`,
        data: Buffer.from(serialiseAgentDefinition(definition)),
      },
      { name: `${PACK_AGENT_PREFIX}persona.md`, data: Buffer.from('Hello.\n') },
    ]);
  }

  it('is refused with the pack version and the build version both named', async () => {
    const definition = loadFixture('coder');
    const bytes = packWithManifest(
      {
        packVersion: PACK_VERSION,
        schemaVersion: AGENT_SCHEMA_VERSION + 1,
        agentId: definition.id,
        exportedAt: '2027-01-01T00:00:00.000Z',
        requiredSecrets: [],
      },
      definition,
    );

    let thrown: unknown;
    try {
      readAgentPack(bytes);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PackSchemaVersionError);
    const error = thrown as PackSchemaVersionError;
    expect(error.message).toContain(String(AGENT_SCHEMA_VERSION + 1));
    expect(error.message).toContain(String(AGENT_SCHEMA_VERSION));
    expect(error.details).toMatchObject({
      field: 'schemaVersion',
      packVersion: AGENT_SCHEMA_VERSION + 1,
      supportedVersion: AGENT_SCHEMA_VERSION,
    });

    // And it never reaches the service, so nothing is written on the way to the
    // refusal.
    await expect(harness.service.importPack(bytes)).rejects.toBeInstanceOf(PackSchemaVersionError);
    expect(agentFolders(harness.libraryRoot)).toEqual([]);
  });

  it('refuses a newer pack container the same way', () => {
    const definition = loadFixture('coder');
    expect(() =>
      readAgentPack(
        packWithManifest(
          {
            packVersion: PACK_VERSION + 1,
            schemaVersion: AGENT_SCHEMA_VERSION,
            agentId: definition.id,
            exportedAt: '2027-01-01T00:00:00.000Z',
            requiredSecrets: [],
          },
          definition,
        ),
      ),
    ).toThrow(new RegExp(`packVersion ${String(PACK_VERSION + 1)}`));
  });

  it('refuses bytes that are not a pack, and a zip that is not one', () => {
    expect(() => readAgentPack(Buffer.from('hello'))).toThrow(InvalidAgentPackError);
    expect(() => readAgentPack(createZip([{ name: 'a.txt', data: Buffer.from('x') }]))).toThrow(
      /no manifest\.json/,
    );
  });

  it('refuses an entry that would escape the agent folder', () => {
    const definition = loadFixture('coder');
    const bytes = createZip([
      {
        name: PACK_MANIFEST_FILENAME,
        data: Buffer.from(
          JSON.stringify({
            packVersion: PACK_VERSION,
            schemaVersion: AGENT_SCHEMA_VERSION,
            agentId: definition.id,
            exportedAt: '2026-08-16T10:00:00.000Z',
            requiredSecrets: [],
          }),
        ),
      },
      {
        name: `${PACK_AGENT_PREFIX}agent.json`,
        data: Buffer.from(serialiseAgentDefinition(definition)),
      },
      { name: `${PACK_AGENT_PREFIX}../../evil.txt`, data: Buffer.from('pwned') },
    ]);
    expect(() => readAgentPack(bytes)).toThrow(/escapes the agent folder/);
  });
});

// ---------------------------------------------------------------------------
// "Preview lists collisions, missing secrets, and skills to be added, and
//  writes nothing"
// ---------------------------------------------------------------------------

describe('the import preview (M9)', () => {
  it('lists collisions, missing secrets and skills, and writes nothing', async () => {
    writeFixtureAgent(harness.libraryRoot, 'email-responder', {
      files: { 'skills/draft-a-reply/SKILL.md': '---\nname: draft-a-reply\n---\n\nBe brief.\n' },
    });
    // The fixture declares `skills.mode: "none"`, so the folder is carried
    // without being declared — which is still a folder the import would add.
    harness.service.load();

    const service = serviceOver(harness, secretsHolding());
    const bytes = service.exportPack('marcus-inbox').bytes;

    const before = harness.events.length;
    const preview = await service.importPack(bytes);

    expect(preview.committed).toBe(false);
    expect(preview.sourceId).toBe('marcus-inbox');
    expect(preview.collision).toBe(true);
    expect(preview.proposedId).toBe('marcus-inbox-2');
    expect(preview.skills).toEqual(['draft-a-reply']);
    expect(preview.missingSecrets).toEqual(['mcp.gmail.token']);
    expect(preview.requiredSecrets).toEqual([
      {
        ref: 'mcp.gmail.token',
        usedBy: 'integrations.gmail.env.GMAIL_TOKEN',
        description: 'GMAIL_TOKEN for the "gmail" MCP server (stdio environment)',
        resolved: false,
      },
    ]);
    expect(preview.warnings.join(' ')).toContain('marcus-inbox-2');
    expect(preview.warnings.join(' ')).toContain('mcp.gmail.token');
    expect(preview.files).toContain('persona.md');

    // Writes nothing: no new folder, no event, and the source is untouched.
    expect(agentFolders(harness.libraryRoot)).toEqual(['marcus-inbox']);
    expect(harness.events.length).toBe(before);
    expect(service.list().agents.map((agent) => agent.definition.id)).toEqual(['marcus-inbox']);
  });

  it('reports a credential this machine does have as resolved', async () => {
    writeFixtureAgent(harness.libraryRoot, 'email-responder');
    harness.service.load();
    const service = serviceOver(harness, secretsHolding('mcp.gmail.token'));

    const preview = await service.importPack(service.exportPack('marcus-inbox').bytes);
    expect(preview.requiredSecrets[0]?.resolved).toBe(true);
    expect(preview.missingSecrets).toEqual([]);
    // The value is nowhere in the response, resolved or not (§10).
    expect(JSON.stringify(preview)).not.toContain('value-of-');
  });

  it('reports no collision when the id is free', async () => {
    const definition = writeRichAgent(harness.libraryRoot);
    harness.service.load();
    const bytes = harness.service.exportPack(definition.id).bytes;
    harness.service.remove(definition.id, { purge: true });

    const preview = await harness.service.importPack(bytes);
    expect(preview.collision).toBe(false);
    expect(preview.proposedId).toBe(definition.id);
    expect(preview.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// "Export → import into a fresh data directory reproduces the agent
//  byte-for-byte except id (on collision) and meta"
// ---------------------------------------------------------------------------

describe('the round trip (M9)', () => {
  it('reproduces the agent byte-for-byte in a fresh data directory', async () => {
    const definition = writeRichAgent(harness.libraryRoot);
    harness.service.load();
    const sourceDir = join(harness.libraryRoot, 'agents', definition.id);
    const bytes = harness.service.exportPack(definition.id).bytes;

    // A genuinely separate data root: its own SQLite, its own library, nothing
    // shared with the exporter but the pack.
    const fresh = makeHarness({ dataRoot: join(temp.path, 'fresh') });
    try {
      fresh.service.load();
      const result = (await fresh.service.importPack(bytes, { commit: true })) as ImportResult;

      expect(result.committed).toBe(true);
      // No collision in a fresh library, so not even the id moves.
      expect(result.proposedId).toBe(definition.id);
      expect(result.agent.definition.id).toBe(definition.id);

      // Everything except `meta` is identical, field for field.
      const { meta: _sourceMeta, ...sourceRest } = definition;
      const { meta: importedMeta, ...importedRest } = result.agent.definition;
      expect(importedRest).toEqual(sourceRest);
      expect(importedMeta.origin).toBe('imported');
      expect(importedMeta.duplicatedFrom).toBeNull();

      // And every authored file is byte-identical.
      const freshDir = join(fresh.libraryRoot, 'agents', definition.id);
      for (const relative of [
        'persona.md',
        'roles/skeptic.md',
        'roles/architect.md',
        'skills/triage-a-stack-trace/SKILL.md',
        'skills/triage-a-stack-trace/reference.md',
      ]) {
        expect(readFileSync(join(freshDir, ...relative.split('/')))).toEqual(
          readFileSync(join(sourceDir, ...relative.split('/'))),
        );
      }

      // The clone is a real registry member: listed, and with its own board row.
      expect(fresh.service.list().agents.map((agent) => agent.definition.id)).toEqual([
        definition.id,
      ]);
      expect(fresh.service.get(definition.id).persona).toBe(
        readFileSync(join(sourceDir, 'persona.md'), 'utf8'),
      );
      // And its plugin manifest was regenerated rather than shipped.
      expect(
        JSON.parse(readFileSync(join(freshDir, '.claude-plugin', 'plugin.json'), 'utf8')) as {
          name: string;
        },
      ).toMatchObject({ name: definition.id });
    } finally {
      fresh.close();
    }
  });

  it('changes only the id when the import collides with the source', async () => {
    const definition = writeRichAgent(harness.libraryRoot);
    harness.service.load();
    const bytes = harness.service.exportPack(definition.id).bytes;

    const result = (await harness.service.importPack(bytes, { commit: true })) as ImportResult;
    const clone = result.agent.definition;

    expect(clone.id).toBe(`${definition.id}-2`);
    const { meta: _cloneMeta, id: _cloneId, ...cloneRest } = clone;
    const { meta: _sourceMeta, id: _sourceId, ...sourceRest } = definition;
    expect(cloneRest).toEqual(sourceRest);

    // The source is untouched, and both are in the registry.
    expect(harness.service.get(definition.id).definition).toEqual(definition);
    expect(
      harness.service
        .list()
        .agents.map((agent) => agent.definition.id)
        .sort(),
    ).toEqual([definition.id, `${definition.id}-2`]);
    expect(
      harness.events.filter(
        (event) =>
          event.type === 'roster.changed' &&
          (event.payload as { reason?: string }).reason === 'imported',
      ),
    ).toHaveLength(1);
  });

  it('carries integration secret refs across and never a value', async () => {
    writeFixtureAgent(harness.libraryRoot, 'email-responder');
    harness.service.load();
    const service = serviceOver(harness, secretsHolding('mcp.gmail.token'));
    const bytes = service.exportPack('marcus-inbox').bytes;

    // The value the exporting machine *can* resolve is not in the bytes.
    expect(bytes.includes(Buffer.from('value-of-mcp.gmail.token'))).toBe(false);

    const result = (await service.importPack(bytes, { commit: true })) as ImportResult;
    expect(result.agent.definition.integrations?.['gmail']).toMatchObject({
      env: { GMAIL_TOKEN: { secretRef: 'mcp.gmail.token' } },
    });
  });
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

describe('the export and import routes (DESIGN §9.1)', () => {
  it('offers the pack as a zip download named after the agent', async () => {
    const definition = writeRichAgent(harness.libraryRoot);
    harness.service.load();
    const routes = createRosterRoutes({ service: harness.service, logger: silentLogger() });

    const answer = await callRoute(routes, 'GET', '/api/roster/agents/:id/export', {
      params: { id: definition.id },
    });
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('application/zip');
    expect(answer.headers['content-disposition']).toContain(`${definition.id}.agentpack`);
    expect(readAgentPack(answer.bytes).manifest.agentId).toBe(definition.id);
  });

  it('answers 200 for a preview and 201 for a commit, and only the commit writes', async () => {
    const definition = writeRichAgent(harness.libraryRoot);
    harness.service.load();
    const routes = createRosterRoutes({ service: harness.service, logger: silentLogger() });
    const bytes = harness.service.exportPack(definition.id).bytes;

    const preview = await callRoute(routes, 'POST', '/api/roster/import', {
      body: bytes,
      contentType: 'application/zip',
    });
    expect(preview.status).toBe(200);
    expect((preview.body as { committed: boolean }).committed).toBe(false);
    expect(agentFolders(harness.libraryRoot)).toEqual([definition.id]);

    const committed = await callRoute(routes, 'POST', '/api/roster/import', {
      body: bytes,
      contentType: 'application/zip',
      query: { commit: 'true' },
    });
    expect(committed.status).toBe(201);
    expect((committed.body as ImportResult).agent.definition.id).toBe(`${definition.id}-2`);
    expect(agentFolders(harness.libraryRoot)).toEqual([definition.id, `${definition.id}-2`]);
  });

  it('accepts the pack as a multipart file part', async () => {
    const definition = writeRichAgent(harness.libraryRoot);
    harness.service.load();
    const routes = createRosterRoutes({ service: harness.service, logger: silentLogger() });
    const bytes = harness.service.exportPack(definition.id).bytes;

    const answer = await callRoute(routes, 'POST', '/api/roster/import', {
      body: multipartBody('packboundary', bytes, {
        filename: 'priya.agentpack',
        contentType: 'application/zip',
      }),
      contentType: 'multipart/form-data; boundary=packboundary',
    });
    expect(answer.status).toBe(200);
    expect((answer.body as { sourceId: string }).sourceId).toBe(definition.id);
  });

  it('refuses a JSON body with a message naming the extension', async () => {
    const routes = createRosterRoutes({ service: harness.service, logger: silentLogger() });
    const answer = await callRoute(routes, 'POST', '/api/roster/import', {
      body: { not: 'a pack' },
    });
    expect(answer.status).toBe(400);
    expect(JSON.stringify(answer.body)).toContain('.agentpack');
  });

  it('is a 404 for exporting an agent that does not exist', async () => {
    const routes = createRosterRoutes({ service: harness.service, logger: silentLogger() });
    const answer = await callRoute(routes, 'GET', '/api/roster/agents/:id/export', {
      params: { id: 'nobody' },
    });
    expect(answer.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('the store’s folder round trip', () => {
  it('reads and rewrites a nested folder, and refuses a traversing path', () => {
    const definition = writeRichAgent(harness.libraryRoot);
    harness.service.load();
    const files = harness.store.readFolderFiles(join(harness.libraryRoot, 'agents', definition.id));

    mkdirSync(join(harness.libraryRoot, 'agents'), { recursive: true });
    harness.store.writeFolderFiles('copy-target', files);
    expect(
      readFileSync(
        join(harness.libraryRoot, 'agents', 'copy-target', 'roles', 'skeptic.md'),
        'utf8',
      ),
    ).toBe('Attack the change you are shown.\n');

    expect(() =>
      harness.store.writeFolderFiles('copy-target', [
        { name: '../escaped.txt', data: Buffer.from('no') },
      ]),
    ).toThrow(/library could not be written/);
    expect(existsSync(join(harness.libraryRoot, 'agents', 'escaped.txt'))).toBe(false);
  });
});
