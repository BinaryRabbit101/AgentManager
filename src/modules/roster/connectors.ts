/**
 * The connector library (roster DESIGN §10.3; work order WO3, 2026-08-19).
 *
 * > "New connections should be created on a Connectors page and then assigned to
 * > agents — this is currently very manually entered and work has a lot of
 * > connectors."
 *
 * §10's decision that *the attachment belongs to the identity* is untouched:
 * agents still declare which connectors they carry. What changes is that the
 * **definition** of one can live in the library once and be referenced, so N
 * agents sharing a mailbox stop holding N hand-typed copies of the same server.
 *
 * Four decisions, each of them a way this could have gone worse:
 *
 * 1. **It is a file in the library, like everything else.**
 *    `connectors/<id>/connector.json`, a sibling of `agents/` and `templates/`,
 *    loaded and watched by exactly the mechanism they are (§2.1, §2.3). Same
 *    reasons, unchanged: shareable, diffable, `git pull`-able, hand-editable.
 * 2. **The config field is `integrationConfigSchema` itself**, not a copy of it.
 *    A connector that could express something an inline integration cannot would
 *    be a second dialect of the same thing, and the day the two disagreed would
 *    be the day an agent compiled differently depending on where its server was
 *    written down. The credential posture comes along wholesale: literals or
 *    `{ secretRef }`, credential-shaped keys must be refs, no values on disk.
 * 3. **The id is an integration name.** `connectorIdProblem` (schema.ts) is
 *    `integrationNameProblem` plus the reserved set, because the id is what the
 *    editor offers as the default server name — and a library entry that could
 *    not be attached under its own name would be a strange thing to have.
 * 4. **A bad connector costs exactly one connector.** Loading is per-folder and
 *    never throws, as §2.3 requires of a bad `agent.json`: the failure comes back
 *    as a {@link Diagnostic} the board can display, and its neighbours load.
 *
 * What lives elsewhere, deliberately: *resolution* is `integrations.ts`'s (a ref
 * becomes a config before secrets are resolved, and a dangling one is a launch
 * refusal), and the CRUD surface is `service.ts`'s. This module is the file
 * format, the store and the index — nothing that knows about HTTP or secrets.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import type { Diagnostic } from './contracts.js';
import { RosterValidationError, issuesFromZod } from './errors.js';
import type { ConnectorLookup } from './integrations.js';
import { canonicalIntegration } from './parse.js';
import { connectorIdProblem, connectorIdSchema, integrationConfigSchema } from './schema.js';
import { CONNECTORS_DIRNAME, writeFileAtomic, type StoreHooks } from './store.js';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** `connectors/` — declared with the rest of the library layout in `store.ts`,
 *  and re-exported here so a reader of this module sees the whole shape. */
export { CONNECTORS_DIRNAME };

/** The structured definition, the way `agent.json` is an agent's. */
export const CONNECTOR_JSON_FILENAME = 'connector.json';

/** The `schemaVersion` this build writes and is the newest it can read. */
export const CONNECTOR_SCHEMA_VERSION = 1;

/** Re-exported from the schema, where the ref variant needs it too. */
export { connectorIdProblem, connectorIdSchema };

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

/**
 * `connector.json`, schema version 1.
 *
 * `strictObject` throughout for §3's reason: a connector written against a newer
 * build fails loudly here rather than silently losing the field that made it
 * work.
 *
 * Note what is **absent**: no per-agent anything. A connector describes a
 * server, not an attachment — which agent carries it, and under which local
 * name, is the agent's `integrations` record and stays there.
 */
export const connectorSchema = z.strictObject({
  schemaVersion: z.literal(CONNECTOR_SCHEMA_VERSION),
  id: connectorIdSchema,
  /** A display line for the picker: "Gmail (work)". The id is what compiles. */
  label: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  /** Exactly §10's integration config — see decision 2 in the module note. */
  config: integrationConfigSchema,
  meta: z.strictObject({
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  }),
});

export type Connector = z.infer<typeof connectorSchema>;

// ---------------------------------------------------------------------------
// Parsing — the same two guarantees `parse.ts` gives a definition
// ---------------------------------------------------------------------------

export type ConnectorParseResult =
  | { readonly ok: true; readonly value: Connector }
  | { readonly ok: false; readonly error: RosterValidationError };

/** Validates a raw document. Never throws — one bad file costs one connector. */
export function safeParseConnector(raw: unknown, source?: string): ConnectorParseResult {
  const result = connectorSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: new RosterValidationError(
      'connector is not valid',
      issuesFromZod(result.error.issues),
      source,
    ),
  };
}

/** {@link safeParseConnector}, throwing {@link RosterValidationError}. */
export function parseConnector(raw: unknown, source?: string): Connector {
  const result = safeParseConnector(raw, source);
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * Parses the text of a `connector.json`.
 *
 * A leading byte-order mark is stripped for `parse.ts`'s reason: the library is
 * meant to be hand-edited on Windows, several editors write one, and a BOM would
 * otherwise fail as a syntax error pointing at character 0 of a file that looks
 * perfectly fine.
 */
export function parseConnectorJson(text: string, source?: string): Connector {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch (error) {
    throw new RosterValidationError(
      'connector is not valid JSON',
      [{ path: '', message: error instanceof Error ? error.message : String(error) }],
      source,
    );
  }
  return parseConnector(raw, source);
}

/** The bytes written to `connector.json`: schema order, two-space indent, LF. */
export function serialiseConnector(connector: Connector): string {
  const ordered: Record<string, unknown> = {
    schemaVersion: connector.schemaVersion,
    id: connector.id,
    label: connector.label,
    description: connector.description,
    // The definition's own canonical form (`parse.ts`), because this is
    // literally the same object an inline integration holds: two orderings of
    // one shape would produce diffs that say nothing.
    config: canonicalIntegration(connector.config),
    meta: { createdAt: connector.meta.createdAt, updatedAt: connector.meta.updatedAt },
  };
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ordered)) {
    if (value !== undefined) compact[key] = value;
  }
  return `${JSON.stringify(compact, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// What a loaded folder is
// ---------------------------------------------------------------------------

export interface ResolvedConnector {
  readonly connector: Connector;
  /** Absolute path to the connector folder. Never leaves the server (§3.2). */
  readonly dir: string;
  /** sha-256 over the authored bytes — what makes a reload a no-op (§2.3). */
  readonly contentHash: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** The result of reading one folder. Never a throw. */
export type ConnectorLoadOutcome =
  | { readonly ok: true; readonly connector: ResolvedConnector }
  | {
      readonly ok: false;
      /** The folder name, which is what the id *should* have been. */
      readonly id: string;
      readonly dir: string;
      readonly diagnostics: readonly Diagnostic[];
    };

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface ConnectorStoreOptions {
  /** The library root — `connectors/` is resolved beneath it. */
  readonly root: string;
  readonly hooks?: StoreHooks;
}

export interface ConnectorStore {
  /** `<libraryRoot>/connectors`. */
  readonly dir: string;
  /** Absolute path to one connector's folder; the folder need not exist. */
  connectorDir(id: string): string;
  /** Folder names directly under `connectors/`, dot-folders excluded. */
  folderNames(): readonly string[];
  hasFolder(id: string): boolean;
  load(id: string): ConnectorLoadOutcome;
  /** Writes `connector.json` atomically and reads the folder back. */
  write(connector: Connector): ResolvedConnector;
  /** Deletes one connector's folder. A folder that is not there is a no-op. */
  remove(id: string): void;
}

export function createConnectorStore(options: ConnectorStoreOptions): ConnectorStore {
  const dir = join(resolve(options.root), CONNECTORS_DIRNAME);
  const hooks = options.hooks ?? {};
  const connectorDir = (id: string): string => join(dir, id);

  function readFolder(folder: string, expectedId: string): ConnectorLoadOutcome {
    const path = join(folder, CONNECTOR_JSON_FILENAME);

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (cause) {
      return {
        ok: false,
        id: expectedId,
        dir: folder,
        diagnostics: [
          {
            level: 'error',
            code: 'roster.unreadable-connector',
            message: `${CONNECTOR_JSON_FILENAME} could not be read: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            path,
          },
        ],
      };
    }

    let connector: Connector;
    try {
      connector = parseConnectorJson(text, path);
    } catch (cause) {
      if (cause instanceof RosterValidationError) {
        return {
          ok: false,
          id: expectedId,
          dir: folder,
          // The same diagnostic *shape* a malformed `agent.json` produces, under
          // its own code so the board can say which kind of file to open.
          diagnostics: [
            {
              level: 'error',
              code: 'roster.invalid-connector',
              message: cause.report(),
              path,
            },
          ],
        };
      }
      throw cause;
    }

    // The folder name *is* the id, exactly as it is for an agent (§2.1). A
    // disagreement is not a detail to paper over: the folder decides where the
    // file lives and the field decides what an agent's `{ connector }` resolves
    // against.
    if (connector.id !== expectedId) {
      return {
        ok: false,
        id: expectedId,
        dir: folder,
        diagnostics: [
          {
            level: 'error',
            code: 'roster.connector-id-mismatch',
            message:
              `folder "${expectedId}" holds a connector with id "${connector.id}"; ` +
              'the folder name is the connector id (DESIGN §10.3). Rename one to match the other.',
            path,
          },
        ],
      };
    }

    return {
      ok: true,
      connector: {
        connector,
        dir: folder,
        contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
        diagnostics: [],
      },
    };
  }

  return {
    dir,
    connectorDir,

    folderNames() {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // No `connectors/` yet is an empty library, not a failure: bootstrap
        // creates it, and a library that arrived by `git clone` may not have one.
        return [];
      }
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort();
    },

    hasFolder: (id) => existsSync(connectorDir(id)),

    load: (id) => readFolder(connectorDir(id), id),

    write(connector) {
      const folder = connectorDir(connector.id);
      // Composed with `node:path`, never concatenated — `store.ts`'s rule.
      mkdirSync(folder, { recursive: true });
      writeFileAtomic(join(folder, CONNECTOR_JSON_FILENAME), serialiseConnector(connector), hooks);
      const outcome = readFolder(folder, connector.id);
      if (!outcome.ok) {
        // Unreachable in practice — the bytes were just serialised from a parsed
        // connector — but a silent `undefined` here would be a connector that
        // "wrote" and then vanished from the index.
        throw new RosterValidationError(
          `the connector "${connector.id}" could not be read back after writing`,
          outcome.diagnostics.map((diagnostic) => ({ path: '', message: diagnostic.message })),
          folder,
        );
      }
      return outcome.connector;
    },

    remove(id) {
      // The same retry posture the test helpers use everywhere on Windows — an
      // editor or the watcher holding a handle briefly must not turn a
      // deliberate delete into a crash.
      rmSync(connectorDir(id), { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface ConnectorRegistryChange {
  readonly changed: boolean;
  /** Ids that appeared, vanished, or whose authored bytes differ. Sorted. */
  readonly connectorIds: readonly string[];
}

export interface ConnectorRegistry {
  list(): readonly ResolvedConnector[];
  get(id: string): ResolvedConnector | undefined;
  /** Everything wrong across `connectors/`, for the board's banner (§2.3). */
  diagnostics(): readonly Diagnostic[];
  reloadAll(): ConnectorRegistryChange;
  /** Rereads one folder — the watcher's per-folder path. */
  reload(id: string): ConnectorRegistryChange;
}

/**
 * The in-memory index, shaped exactly like the template registry's.
 *
 * Failures are remembered rather than discarded for the same reason they are
 * there: a folder whose `connector.json` is corrupt is not a connector —
 * nothing lists it and no ref resolves to it — but the index still knows the id
 * exists, and the board still gets to say so.
 */
export function createConnectorRegistry(store: ConnectorStore): ConnectorRegistry {
  const live = new Map<string, ResolvedConnector>();
  const failed = new Map<string, readonly Diagnostic[]>();

  function absorb(id: string, touched: Set<string>): void {
    const outcome = store.load(id);
    const previous = live.get(id);

    if (outcome.ok) {
      failed.delete(id);
      live.set(id, outcome.connector);
      if (previous === undefined || previous.contentHash !== outcome.connector.contentHash) {
        touched.add(id);
      }
      return;
    }

    live.delete(id);
    const before = failed.get(id);
    failed.set(id, outcome.diagnostics);
    // A folder that was a connector and now is not is a change the board must
    // see; one that was already broken in the same way is not, or every
    // keystroke in an editor on a malformed file would be an event.
    if (previous !== undefined || before === undefined || !same(before, outcome.diagnostics)) {
      touched.add(id);
    }
  }

  function change(ids: Iterable<string>): ConnectorRegistryChange {
    const connectorIds = [...new Set(ids)].sort();
    return connectorIds.length === 0
      ? { changed: false, connectorIds: [] }
      : { changed: true, connectorIds };
  }

  return {
    list: () => [...live.values()].sort((a, b) => (a.connector.id < b.connector.id ? -1 : 1)),
    get: (id) => live.get(id),

    diagnostics() {
      const out: Diagnostic[] = [];
      for (const diagnostics of failed.values()) out.push(...diagnostics);
      for (const entry of live.values()) out.push(...entry.diagnostics);
      return out;
    },

    reloadAll() {
      const touched = new Set<string>();
      const seen = new Set(store.folderNames());
      for (const id of seen) absorb(id, touched);
      for (const id of [...live.keys()]) {
        if (!seen.has(id)) {
          live.delete(id);
          touched.add(id);
        }
      }
      for (const id of [...failed.keys()]) {
        if (!seen.has(id)) failed.delete(id);
      }
      return change(touched);
    },

    reload(id) {
      const touched = new Set<string>();
      if (!store.hasFolder(id)) {
        const wasLive = live.delete(id);
        const wasFailed = failed.delete(id);
        if (wasLive || wasFailed) touched.add(id);
        return change(touched);
      }
      absorb(id, touched);
      return change(touched);
    },
  };
}

/** Two diagnostic lists that would render identically on the board. */
function same(a: readonly Diagnostic[], b: readonly Diagnostic[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    return right !== undefined && left.code === right.code && left.message === right.message;
  });
}

// ---------------------------------------------------------------------------
// Resolution (the seam every consumer of a ref goes through)
// ---------------------------------------------------------------------------

/**
 * The {@link ConnectorLookup} a registry answers with.
 *
 * A function rather than the registry itself, for the reason `compileSession`
 * exists as a pure function at all (§13): the compiler must not reach into a
 * service registry, and a test must be able to compile against a connector it
 * declared inline. It is also what makes "editing the library changes the next
 * compile of every referencing agent" true without a cache to invalidate — the
 * lookup runs at compile time, against whatever the registry holds then.
 */
export function connectorLookup(registry: ConnectorRegistry): ConnectorLookup {
  return (id) => registry.get(id)?.connector.config;
}
