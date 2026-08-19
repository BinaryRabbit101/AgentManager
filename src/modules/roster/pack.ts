/**
 * `.agentpack` — the shareable form of an agent (roster DESIGN §9.4,
 * IMPLEMENTATION M9).
 *
 * > "This makes 'here's my code-reviewer agent' a shareable artefact, which is
 * > the point of file-based storage."
 *
 * A pack is a zip holding two things: `manifest.json` at the root, and the whole
 * agent folder under `agent/`. The prefix is deliberate — the manifest is *about*
 * the agent rather than part of it, and a flat layout would make an agent that
 * happened to carry its own `manifest.json` either lossy or ambiguous. Someone
 * who unzips a pack by hand sees the two halves separated, which is also the
 * clearest reading of what they were handed.
 *
 * Four rules this module exists to enforce:
 *
 * 1. **No secret values, ever.** §9.4: "No secret values are ever written into a
 *    pack — only refs and a human-readable manifest of what the importer must
 *    supply." {@link assertNoSecretValues} is the guard, and it runs on the
 *    assembled pack rather than on the definition alone, so a credential that got
 *    into a skill's config file is caught by the same check as one in
 *    `agent.json`. Its limits are stated on the function: it reads structured
 *    files, and prose is beyond what any guard can honestly claim.
 * 2. **A newer schema is refused, not best-effort-parsed.** §9.4, and both
 *    version numbers are in the message — an importer whose only information is
 *    "this pack is too new" cannot tell whether to upgrade or to ask for a
 *    re-export.
 * 3. **Nothing in a pack becomes a path outside the agent folder.** Entry names
 *    are validated before anything is written; a `..` or an absolute path in a
 *    zip is the oldest file-format attack there is, and this is the one place in
 *    the element where a caller-supplied name would otherwise reach the disk.
 * 4. **Import is a read, then a decision, then a write.** This module never
 *    touches the filesystem: it turns bytes into a {@link ReadAgentPack} and back,
 *    and the service decides what to do with it. That is what makes "preview …
 *    writes nothing" (M9) a property of the code rather than a promise.
 * 5. **A pack is self-contained.** A `{ connector }` reference into the library
 *    (§10.3) is *inlined* on export ({@link inlineConnectorRefs}) and refused on
 *    import: a connector id names an entry in the exporting machine's library,
 *    and a pack that depended on the destination having one would either fail at
 *    launch or, worse, resolve to a same-named connector pointing somewhere else.
 */
import { z } from 'zod';

import { createZip, readZip, ZipReadError, type ZipEntry } from '../../http/zip.js';

import { isCredentialShapedKey } from './credentialKeys.js';
import { RosterValidationError } from './errors.js';
import {
  integrationSecretRefs,
  resolveIntegrations,
  type ConnectorLookup,
} from './integrations.js';
import { parseAgentDefinitionJson } from './parse.js';
import { AGENT_SCHEMA_VERSION, isConnectorRef, type AgentDefinition } from './schema.js';
import {
  InvalidAgentPackError,
  PackSchemaVersionError,
  PackSecretValueError,
} from './serviceErrors.js';
import { AGENT_JSON_FILENAME, folderRelativePathProblem, type FolderFile } from './store.js';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** The pack container's own version, bumped when the *layout* changes — which
 *  is a different question from the definition's `schemaVersion` (§9.4). */
export const PACK_VERSION = 1;

/** The download's extension, and the only one `POST /import` advertises. */
export const PACK_EXTENSION = '.agentpack';

/** A zip by construction, so the browser and every unzip tool treat it as one. */
export const PACK_CONTENT_TYPE = 'application/zip';

export const PACK_MANIFEST_FILENAME = 'manifest.json';

/** Everything the agent folder held, under one prefix inside the archive. */
export const PACK_AGENT_PREFIX = 'agent/';

/**
 * One file inside a pack.
 *
 * The store's {@link FolderFile} unchanged, aliased rather than redeclared: a
 * pack *is* an agent folder plus a manifest, and two structurally identical
 * types would invite the two halves to drift.
 */
export type PackFile = FolderFile;

/**
 * §9.4's manifest.
 *
 * `requiredSecrets` is the whole reason it exists: a pack carries refs, so the
 * person importing it has to be told, in words, which credentials they must
 * supply before the agent will launch.
 */
export const requiredSecretSchema = z.strictObject({
  ref: z.string().min(1),
  /** The dotted path into the definition that reads it. */
  usedBy: z.string().min(1),
  description: z.string().min(1),
});
export type RequiredSecret = z.infer<typeof requiredSecretSchema>;

export const packManifestSchema = z.strictObject({
  packVersion: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  agentId: z.string().min(1),
  exportedAt: z.string().min(1),
  requiredSecrets: z.array(requiredSecretSchema),
});
export type PackManifest = z.infer<typeof packManifestSchema>;

// ---------------------------------------------------------------------------
// The secret guard (§9.4)
// ---------------------------------------------------------------------------

/** What {@link assertNoSecretValues} found, before it refuses. */
export interface SecretValueViolation {
  /** The file inside the pack. */
  readonly file: string;
  /** The dotted path to the offending key within that file. */
  readonly path: string;
  readonly key: string;
}

/**
 * Every credential-shaped key in a JSON file that holds a literal instead of a
 * `{ secretRef }`.
 *
 * "Credential-shaped" is `credentialKeys.ts` — §10's one definition of the thing
 * for the whole system, applied here at a third moment (the schema applies it at
 * write time, foundation at config-load time). Using the same predicate is the
 * point: a key that roster refuses to *store* as a literal is the same key it
 * refuses to *ship*.
 *
 * Deliberately scoped to structured files. A token pasted into the middle of a
 * persona paragraph is not detectable by any rule that would not also fire on
 * every sentence containing the word "key", and a guard that cried wolf on prose
 * would be turned off. The honest claim is the one §9.4 makes about the format:
 * a pack's *definition* carries refs, and nothing in the export path resolves
 * one.
 */
export function secretValueViolations(files: readonly PackFile[]): SecretValueViolation[] {
  const violations: SecretValueViolation[] = [];
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.data.toString('utf8')) as unknown;
    } catch {
      // Unparseable JSON is not this guard's problem; the definition parser
      // refuses it, and a stray malformed file is not a leaked credential.
      continue;
    }
    walk(parsed, '', (path, key, value) => {
      if (!isCredentialShapedKey(key)) return;
      if (typeof value !== 'string' || value.length === 0) return;
      violations.push({ file: file.name, path, key });
    });
  }
  return violations;
}

/**
 * A `{ "secretRef": "…" }` and nothing else.
 *
 * The walk stops here rather than descending, and the reason is worth stating:
 * `secretRef` is itself a credential-shaped key by §10's rule (it contains
 * "secret"), and its value is a *key name* rather than a credential. Recursing
 * into a reference would make the guard fire on the very shape it exists to
 * insist on — the one bug this check absolutely must not have.
 */
function isSecretRefShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'secretRef';
}

function walk(
  value: unknown,
  path: string,
  visit: (path: string, key: string, value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(item, `${path}[${String(index)}]`, visit);
    });
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    visit(childPath, key, child);
    if (isSecretRefShape(child)) continue;
    walk(child, childPath, visit);
  }
}

/**
 * §9.4's guard, as a refusal.
 *
 * @throws {PackSecretValueError} naming every offending file and key, so the
 *   owner can go and replace the literal with a `secretRef` rather than being
 *   told only that "something" leaked.
 */
export function assertNoSecretValues(agentId: string, files: readonly PackFile[]): void {
  const violations = secretValueViolations(files);
  if (violations.length > 0) throw new PackSecretValueError(agentId, violations);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** A one-line human description of what a credential is for (§9.4's manifest). */
function describeSecret(integration: string, kind: 'env' | 'headers', key: string): string {
  return kind === 'env'
    ? `${key} for the "${integration}" MCP server (stdio environment)`
    : `${key} for the "${integration}" MCP server (HTTP header)`;
}

/** §9.4's `requiredSecrets`, derived from the definition and from nothing else. */
export function requiredSecretsFor(definition: AgentDefinition): RequiredSecret[] {
  return integrationSecretRefs(definition).map((ref) => ({
    ref: ref.secretRef,
    usedBy: ref.path,
    description: describeSecret(ref.integration, ref.kind, ref.key),
  }));
}

// ---------------------------------------------------------------------------
// Connector references (§10.3): a pack inlines them
// ---------------------------------------------------------------------------

/** {@link inlineConnectorRefs}'s answer: the definition to ship, and the refs
 *  that stopped it from being shippable. */
export interface InlinedDefinition {
  readonly definition: AgentDefinition;
  /** Server names whose `{ connector }` the library does not hold. */
  readonly dangling: readonly { readonly name: string; readonly connector: string }[];
}

/**
 * The definition an export ships: every `{ connector }` replaced by the config
 * the library holds for it.
 *
 * **Inlined, not carried.** A pack is "here's my code-reviewer agent" handed to
 * another machine (§9.4), and a ref names an entry in *this* machine's library.
 * Shipping the ref would produce a pack that imports cleanly and then refuses to
 * launch — or, worse, one that resolves against a same-named connector on the
 * destination and quietly points the agent at a different server. Inlining makes
 * a pack self-contained, which is the property the format exists for.
 *
 * The credential posture is unchanged by this: what is inlined is the library's
 * config, which carries `{ secretRef }` names and no values, so §9.4's guard
 * still finds nothing to refuse.
 */
export function inlineConnectorRefs(
  definition: AgentDefinition,
  connectors?: ConnectorLookup,
): InlinedDefinition {
  if (definition.integrations === undefined) return { definition, dangling: [] };
  const resolved = resolveIntegrations(definition.integrations, connectors);
  if (resolved.dangling.length > 0) {
    return { definition, dangling: resolved.dangling.map((ref) => ({ ...ref })) };
  }
  const inlined: NonNullable<AgentDefinition['integrations']> = {};
  for (const entry of resolved.integrations) inlined[entry.name] = entry.config;
  return { definition: { ...definition, integrations: inlined }, dangling: [] };
}

export interface BuildAgentPackInput {
  readonly definition: AgentDefinition;
  /** The agent folder's contents, relative to the folder. */
  readonly files: readonly PackFile[];
  /** ISO timestamp; injected so a pack is reproducible in a test. */
  readonly exportedAt: string;
}

/** The name the download is offered under. */
export function packFilename(agentId: string): string {
  return `${agentId}${PACK_EXTENSION}`;
}

/**
 * Builds a `.agentpack`.
 *
 * The guard runs on the assembled entry list — manifest included — rather than
 * on the input, so there is no ordering in which a file reaches the archive
 * without having been checked.
 */
export function buildAgentPack(input: BuildAgentPackInput): Buffer {
  const manifest: PackManifest = {
    packVersion: PACK_VERSION,
    schemaVersion: input.definition.schemaVersion,
    agentId: input.definition.id,
    exportedAt: input.exportedAt,
    requiredSecrets: requiredSecretsFor(input.definition),
  };

  const files: PackFile[] = [
    { name: PACK_MANIFEST_FILENAME, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    ...[...input.files]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((file) => ({ name: `${PACK_AGENT_PREFIX}${file.name}`, data: file.data })),
  ];

  assertNoSecretValues(input.definition.id, files);

  const entries: ZipEntry[] = files.map((file) => ({ name: file.name, data: file.data }));
  return createZip(entries);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ReadAgentPack {
  readonly manifest: PackManifest;
  readonly definition: AgentDefinition;
  /** The agent folder's contents, prefix stripped, `agent.json` included. */
  readonly files: readonly PackFile[];
  /** `skills/<name>/` folder names carried by the pack (§9.4's preview). */
  readonly skills: readonly string[];
}

/**
 * Why a pack entry may not become a file in an agent folder, or `undefined`.
 *
 * The store's rule (`folderRelativePathProblem`), applied here so a bad name is
 * refused with the archive still in memory rather than part-way through a write.
 * The store re-applies it anyway — a traversal guard that exists only in the
 * caller is one refactor away from being gone.
 */
export const packEntryProblem = folderRelativePathProblem;

/**
 * Turns pack bytes into a definition and its files, or refuses them.
 *
 * Order matters and is the reverse of intuition: the manifest is read and its
 * versions checked *before* the definition is parsed, because a pack from a newer
 * build is expected to fail definition parsing and the useful message is the one
 * naming both schema versions rather than a list of unknown keys.
 */
export function readAgentPack(bytes: Buffer): ReadAgentPack {
  let entries: ZipEntry[];
  try {
    entries = readZip(bytes);
  } catch (cause) {
    throw new InvalidAgentPackError(
      cause instanceof ZipReadError
        ? `The upload is not a readable ${PACK_EXTENSION}: ${cause.message}`
        : `The upload could not be read as a ${PACK_EXTENSION} archive.`,
      { cause },
    );
  }

  const manifestEntry = entries.find((entry) => entry.name === PACK_MANIFEST_FILENAME);
  if (manifestEntry === undefined) {
    throw new InvalidAgentPackError(
      `The archive has no ${PACK_MANIFEST_FILENAME}, so it is not an ${PACK_EXTENSION}.`,
    );
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestEntry.data.toString('utf8')) as unknown;
  } catch {
    throw new InvalidAgentPackError(`${PACK_MANIFEST_FILENAME} is not valid JSON.`);
  }
  const parsedManifest = packManifestSchema.safeParse(manifestJson);
  if (!parsedManifest.success) {
    throw new InvalidAgentPackError(
      `${PACK_MANIFEST_FILENAME} is not a pack manifest: ` +
        parsedManifest.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
          .join('; '),
    );
  }
  const manifest = parsedManifest.data;

  // §9.4: "An import whose `schemaVersion` is newer than the build is refused
  // with the version numbers named, not best-effort-parsed."
  if (manifest.schemaVersion > AGENT_SCHEMA_VERSION) {
    throw new PackSchemaVersionError('schemaVersion', manifest.schemaVersion, AGENT_SCHEMA_VERSION);
  }
  if (manifest.packVersion > PACK_VERSION) {
    throw new PackSchemaVersionError('packVersion', manifest.packVersion, PACK_VERSION);
  }

  const files: PackFile[] = [];
  for (const entry of entries) {
    if (entry.name === PACK_MANIFEST_FILENAME) continue;
    if (!entry.name.startsWith(PACK_AGENT_PREFIX)) {
      throw new InvalidAgentPackError(
        `"${entry.name}" is outside ${PACK_AGENT_PREFIX}; every file in a pack belongs to the agent folder.`,
      );
    }
    const relative = entry.name.slice(PACK_AGENT_PREFIX.length);
    // A directory entry (trailing slash) carries nothing this writer emits and
    // nothing an import needs — the folders come from the file paths.
    if (relative.endsWith('/')) continue;
    const problem = packEntryProblem(relative);
    if (problem !== undefined) {
      throw new InvalidAgentPackError(`Pack entry "${entry.name}" ${problem}.`);
    }
    files.push({ name: relative, data: entry.data });
  }

  const definitionFile = files.find((file) => file.name === AGENT_JSON_FILENAME);
  if (definitionFile === undefined) {
    throw new InvalidAgentPackError(
      `The pack has no ${PACK_AGENT_PREFIX}${AGENT_JSON_FILENAME}, so it describes no agent.`,
    );
  }

  let definition: AgentDefinition;
  try {
    definition = parseAgentDefinitionJson(
      definitionFile.data.toString('utf8'),
      `${PACK_AGENT_PREFIX}${AGENT_JSON_FILENAME}`,
    );
  } catch (cause) {
    if (cause instanceof RosterValidationError) {
      throw new InvalidAgentPackError(
        `The pack's ${AGENT_JSON_FILENAME} is not a valid agent definition: ${cause.message}`,
        { cause },
      );
    }
    throw cause;
  }

  // §10.3: a pack **inlines** connector references, so one that carries a
  // `{ connector }` was not written by an export — it was hand-assembled, or
  // built by a build that predates the inlining. Refusing is the honest answer
  // either way: the id names a library entry on the *exporting* machine, and
  // resolving it against this one would silently attach a different server.
  const referencing = Object.entries(definition.integrations ?? {})
    .filter(([, attachment]) => isConnectorRef(attachment))
    .map(([name]) => name);
  if (referencing.length > 0) {
    throw new InvalidAgentPackError(
      `The pack's ${AGENT_JSON_FILENAME} references the connector library at ` +
        `${referencing.map((name) => `integrations.${name}`).join(', ')}. Exports inline their ` +
        'connectors — a pack never depends on the destination library (DESIGN §10.3), so this ' +
        'one cannot be imported. Re-export it from a build that inlines.',
    );
  }

  if (definition.id !== manifest.agentId) {
    throw new InvalidAgentPackError(
      `The manifest names agent "${manifest.agentId}" but ${AGENT_JSON_FILENAME} holds ` +
        `"${definition.id}"; the pack disagrees with itself.`,
    );
  }

  const skills = [
    ...new Set(
      files
        .map((file) => /^skills\/([^/]+)\//.exec(file.name)?.[1])
        .filter((name): name is string => name !== undefined),
    ),
  ].sort();

  return { manifest, definition, files, skills };
}
