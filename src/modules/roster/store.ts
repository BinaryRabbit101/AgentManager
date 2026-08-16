/**
 * The file store (roster DESIGN §2.1, §2.3; IMPLEMENTATION M2).
 *
 * One folder per agent under `<libraryRoot>/agents/`, `agent.json` as **the**
 * definition, and the folder as the unit of copy, export and version control.
 * This module is the only place in the element that knows that layout; the
 * registry above it deals in {@link ResolvedAgent}s and never in paths.
 *
 * Three properties everything else leans on:
 *
 * 1. **Writes are atomic.** Every authored file goes through
 *    {@link writeFileAtomic}: a temp sibling, then a rename. A process killed
 *    mid-write leaves either the old bytes or the new ones, never a truncated
 *    `agent.json` — which matters more here than in most stores because the
 *    library is a git repository the owner is invited to hand-edit, and a
 *    half-written definition would look like *their* mistake.
 * 2. **A bad folder costs exactly one agent.** Loading is per-folder and never
 *    throws: a definition that fails validation comes back as a
 *    {@link Diagnostic} the board can display (§2.3), and its neighbours load.
 * 3. **Paths are composed, never concatenated.** `node:path` throughout, no
 *    POSIX separators in string literals, and no `:` in a name that becomes a
 *    path component — the archive stamp of §9.3 is compacted for exactly that
 *    reason (Windows forbids `:` in a file name).
 *
 * Everything here is synchronous. The rest of the element's state is
 * synchronous too — an in-memory `Map` and better-sqlite3 — so an async store
 * would add interleaving to a single-owner service without removing a single
 * blocking call, and atomicity arguments about temp-then-rename are far easier
 * to make when nothing can run between the two.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { isoTimestamp, type Clock } from '../../storage/time.js';

import type { Diagnostic } from './contracts.js';
import { RosterValidationError } from './errors.js';
import { parseAgentDefinitionJson, serialiseAgentDefinition } from './parse.js';
import type { AgentDefinition, AgentId } from './schema.js';
import { LibraryWriteError } from './serviceErrors.js';

// ---------------------------------------------------------------------------
// Layout (§2.1)
// ---------------------------------------------------------------------------

/** `agents/` — one folder per agent, the folder name being the id. */
export const AGENTS_DIRNAME = 'agents';
/** `.archive/` — soft-deleted agents, `<id>-<timestamp>/` (§9.3). */
export const ARCHIVE_DIRNAME = '.archive';
/** Roster-level metadata: `schemaVersion`, `seededAt` (§2.1). */
export const ROSTER_JSON_FILENAME = 'roster.json';
export const GITIGNORE_FILENAME = '.gitignore';
/** The structured definition. */
export const AGENT_JSON_FILENAME = 'agent.json';
/** Generated, never hand-edited: it makes the folder a local plugin (§7.1). */
export const PLUGIN_MANIFEST_DIRNAME = '.claude-plugin';
export const PLUGIN_MANIFEST_FILENAME = 'plugin.json';
/** The one name an uploaded avatar is ever stored under (§9.5). */
export const AVATAR_FILENAME = 'avatar.png';
/** Optional per-collaboration-role persona addenda (§4). */
export const ROLES_DIRNAME = 'roles';
/** Per-agent skills, in plugin layout (§7). */
export const SKILLS_DIRNAME = 'skills';

/** The prefix every in-flight atomic write uses, and `.gitignore` excludes. */
export const TEMP_PREFIX = '.tmp-';

/** Absolute paths to everything the library root owns. */
export interface LibraryPaths {
  readonly root: string;
  readonly agents: string;
  readonly archive: string;
  readonly rosterJson: string;
  readonly gitignore: string;
  readonly gitDir: string;
}

/** Resolves the §2.1 layout. Purely arithmetic — touches no disk. */
export function libraryPaths(root: string): LibraryPaths {
  const absolute = resolve(root);
  return {
    root: absolute,
    agents: join(absolute, AGENTS_DIRNAME),
    archive: join(absolute, ARCHIVE_DIRNAME),
    rosterJson: join(absolute, ROSTER_JSON_FILENAME),
    gitignore: join(absolute, GITIGNORE_FILENAME),
    gitDir: join(absolute, '.git'),
  };
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

/**
 * Test seams. Absent in production, and the only way to observe the inside of
 * an atomic write.
 *
 * "A killed process mid-write leaves either the old or the new `agent.json`,
 * never a truncated one" (M2) is a claim about a moment that no test can reach
 * from outside: by the time a write returns, the rename has happened.
 * {@link StoreHooks.beforeRename} *is* that moment — a test asserts there that
 * the temp file holds the new bytes while the target still holds the old, and
 * a hook that throws is a process that died at exactly the wrong instant.
 */
export interface StoreHooks {
  beforeRename?(tempPath: string, targetPath: string): void;
}

let writeCounter = 0;

/**
 * Writes `data` to `path` through a temp sibling and a rename.
 *
 * The temp file is a *sibling* rather than a file in the OS temp directory
 * because `rename` is only atomic within a volume, and a relocated library
 * (config `library.root`) is very often on a different drive from `%TEMP%`.
 * `renameSync` replaces an existing target on Windows as well as POSIX, so
 * there is no unlink-then-rename window where the file does not exist at all.
 */
export function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  hooks: StoreHooks = {},
): void {
  writeCounter += 1;
  const temp = `${path}${TEMP_PREFIX}${String(process.pid)}-${String(writeCounter)}`;
  try {
    writeFileSync(temp, data);
    hooks.beforeRename?.(temp, path);
    renameSync(temp, path);
  } catch (cause) {
    // A failed write must not leave litter that the next `git status` reports.
    try {
      rmSync(temp, { force: true });
    } catch {
      // The original failure is the one worth reporting.
    }
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// Archive stamps (§9.3)
// ---------------------------------------------------------------------------

const ARCHIVE_STAMP_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;

/**
 * `2026-08-16T10:35:00.000Z` → `20260816T103500000Z`.
 *
 * Windows forbids `:` in a path component and `.` before the extension is
 * conventional, so the ISO form cannot be used verbatim in a folder name. The
 * compacted form keeps the lexicographic ordering that made ISO worth using.
 */
export function archiveStamp(at: Date): string {
  return isoTimestamp(at).replace(/[-:.]/g, '');
}

/** The inverse of {@link archiveStamp}, or `undefined` for a foreign folder. */
export function parseArchiveStamp(stamp: string): string | undefined {
  const match = ARCHIVE_STAMP_PATTERN.exec(stamp);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, ms] = match;
  return `${year ?? ''}-${month ?? ''}-${day ?? ''}T${hour ?? ''}:${minute ?? ''}:${second ?? ''}.${ms ?? ''}Z`;
}

/** Splits `priya-bugfix-20260816T103500000Z` back into its two halves. */
export function parseArchiveFolder(
  folder: string,
): { readonly id: string; readonly archivedAt: string } | undefined {
  const cut = folder.lastIndexOf('-');
  if (cut <= 0) return undefined;
  const archivedAt = parseArchiveStamp(folder.slice(cut + 1));
  if (archivedAt === undefined) return undefined;
  return { id: folder.slice(0, cut), archivedAt };
}

// ---------------------------------------------------------------------------
// What a loaded folder is
// ---------------------------------------------------------------------------

/**
 * An agent as the registry holds it: the definition, the persona text it points
 * at, and where both came from.
 *
 * The persona is carried in memory rather than read on demand because every
 * consumer needs it — `GET /agents/:id` returns it (§9.1), and M4's compiler
 * composes it into `systemPrompt` (§5) — and a per-launch disk read would make
 * the registry a cache that can disagree with itself.
 */
export interface ResolvedAgent {
  readonly definition: AgentDefinition;
  /** `persona.md`'s contents, verbatim. Empty when the file is missing. */
  readonly persona: string;
  /** Absolute path to the agent folder. Never leaves the server (§3.2). */
  readonly dir: string;
  /** sha-256 over the authored bytes — what makes a reload a no-op (§2.3). */
  readonly contentHash: string;
  /** ISO timestamp when this was read out of `.archive/`, else `null` (§9.3). */
  readonly archivedAt: string | null;
  /** Non-fatal findings: a missing persona, an unwritable plugin manifest. */
  readonly diagnostics: readonly Diagnostic[];
}

/** The result of reading one folder. Never a throw (§2.3). */
export type LoadOutcome =
  | { readonly ok: true; readonly agent: ResolvedAgent }
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

export interface RosterStoreOptions {
  /** Foundation's `library.root` (§2.1) — resolved from config, never from env. */
  readonly root: string;
  /** Injectable, so tests are not time-dependent (foundation §6.1). */
  readonly clock?: Clock;
  readonly hooks?: StoreHooks;
}

export interface ArchiveEntry {
  readonly id: AgentId;
  readonly folder: string;
  readonly dir: string;
  readonly archivedAt: string;
}

export interface RosterStore {
  readonly paths: LibraryPaths;
  /** Absolute path to a live agent's folder; the folder need not exist. */
  agentDir(id: string): string;
  /** Folder names directly under `agents/`, dot-folders excluded. */
  folderNames(): readonly string[];
  /** True when `agents/<id>/` exists, valid definition or not. */
  hasFolder(id: string): boolean;
  load(id: string): LoadOutcome;
  /** Every `.archive/<id>-<stamp>/`, newest last. */
  archiveEntries(): readonly ArchiveEntry[];
  loadArchived(entry: ArchiveEntry): LoadOutcome;
  /**
   * Writes `agent.json` (and `persona.md`, when text is supplied), regenerates
   * the plugin manifest, and reads the folder back.
   */
  write(definition: AgentDefinition, persona?: string): ResolvedAgent;
  writePersona(id: string, text: string): void;
  writeAvatar(id: string, bytes: Uint8Array): void;
  removeAvatar(id: string): boolean;
  /**
   * The avatar file's bytes, or `undefined` when there is none on disk.
   *
   * Takes the folder rather than the id because an archived agent's folder is
   * under `.archive/<id>-<stamp>/`, and §9.3 keeps an archived definition
   * displayable — avatar included.
   */
  readAvatar(dir: string, filename: string): Buffer | undefined;
  /** Deep-copies a whole agent folder — persona, roles, skills, avatar (§9.2). */
  copyFolder(fromId: string, toId: string): void;
  /** Moves the folder under `.archive/<id>-<stamp>/` and returns where (§9.3). */
  archive(id: string): ArchiveEntry;
  /** Removes the live folder and every archived copy of the id (§9.3). */
  purge(id: string): void;
}

export function createRosterStore(options: RosterStoreOptions): RosterStore {
  const paths = libraryPaths(options.root);
  const clock: Clock = options.clock ?? ((): Date => new Date());
  const hooks = options.hooks ?? {};

  const agentDir = (id: string): string => join(paths.agents, id);

  function readFolder(dir: string, expectedId: string, archivedAt: string | null): LoadOutcome {
    const definitionPath = join(dir, AGENT_JSON_FILENAME);

    let text: string;
    try {
      text = readFileSync(definitionPath, 'utf8');
    } catch (cause) {
      return {
        ok: false,
        id: expectedId,
        dir,
        diagnostics: [
          {
            level: 'error',
            code: 'roster.unreadable-definition',
            message: `${AGENT_JSON_FILENAME} could not be read: ${describe(cause)}`,
            agentId: expectedId,
            path: definitionPath,
          },
        ],
      };
    }

    let definition: AgentDefinition;
    try {
      definition = parseAgentDefinitionJson(text, definitionPath);
    } catch (cause) {
      if (cause instanceof RosterValidationError) {
        return { ok: false, id: expectedId, dir, diagnostics: [cause.toDiagnostic(expectedId)] };
      }
      throw cause;
    }

    // The folder name *is* the id (§2.1). A disagreement is not a detail to
    // paper over: the folder decides where files live and the field decides
    // what every other element joins on, and picking one silently would make
    // duplicate, export and archive disagree about which agent this is.
    if (definition.id !== expectedId) {
      return {
        ok: false,
        id: expectedId,
        dir,
        diagnostics: [
          {
            level: 'error',
            code: 'roster.id-mismatch',
            message:
              `folder "${expectedId}" holds a definition with id "${definition.id}"; ` +
              'the folder name is the agent id (DESIGN §2.1). Rename one to match the other.',
            agentId: expectedId,
            path: definitionPath,
          },
        ],
      };
    }

    const diagnostics: Diagnostic[] = [];

    const personaPath = join(dir, definition.persona.file);
    let persona = '';
    try {
      persona = readFileSync(personaPath, 'utf8');
    } catch {
      diagnostics.push({
        level: 'warn',
        code: 'roster.persona-missing',
        message: `${definition.persona.file} is missing; this agent will launch with no persona body (DESIGN §4).`,
        agentId: definition.id,
        path: personaPath,
      });
    }

    let avatarBytes: Buffer | undefined;
    if (definition.avatar?.kind === 'file') {
      const avatarPath = join(dir, definition.avatar.value);
      try {
        avatarBytes = readFileSync(avatarPath);
      } catch {
        diagnostics.push({
          level: 'warn',
          code: 'roster.avatar-missing',
          message: `${definition.avatar.value} is missing; the board will show a generated placeholder (DESIGN §3.2).`,
          agentId: definition.id,
          path: avatarPath,
        });
      }
    }

    // Archived folders are read-only history: regenerating a manifest inside
    // one would rewrite a deleted agent (§9.3).
    if (archivedAt === null) {
      const manifest = ensurePluginManifest(dir, definition, hooks);
      if (manifest !== undefined) diagnostics.push(manifest);
    }

    return {
      ok: true,
      agent: {
        definition,
        persona,
        dir,
        contentHash: contentHash(text, persona, avatarBytes),
        archivedAt,
        diagnostics,
      },
    };
  }

  function folderNames(): readonly string[] {
    let entries;
    try {
      entries = readdirSync(paths.agents, { withFileTypes: true });
    } catch {
      // No `agents/` yet is an empty roster, not a failure: bootstrap creates
      // it, and a library that has just been `git clone`d may not have one.
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  }

  function archiveEntries(): readonly ArchiveEntry[] {
    let entries;
    try {
      entries = readdirSync(paths.archive, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: ArchiveEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const parsed = parseArchiveFolder(entry.name);
      if (parsed === undefined) continue;
      out.push({
        id: parsed.id,
        folder: entry.name,
        dir: join(paths.archive, entry.name),
        archivedAt: parsed.archivedAt,
      });
    }
    return out.sort((a, b) =>
      a.archivedAt < b.archivedAt ? -1 : a.archivedAt > b.archivedAt ? 1 : 0,
    );
  }

  return {
    paths,
    agentDir,
    folderNames,
    archiveEntries,

    hasFolder(id) {
      try {
        return statSync(agentDir(id)).isDirectory();
      } catch {
        return false;
      }
    },

    load(id) {
      return readFolder(agentDir(id), id, null);
    },

    loadArchived(entry) {
      return readFolder(entry.dir, entry.id, entry.archivedAt);
    },

    write(definition, persona) {
      const dir = agentDir(definition.id);
      try {
        mkdirSync(dir, { recursive: true });
        // Persona first: `agent.json` is what makes a folder an agent, so a
        // watcher that wakes between the two writes must never see a definition
        // whose persona is not there yet.
        if (persona !== undefined) {
          writeFileAtomic(join(dir, definition.persona.file), persona, hooks);
        }
        writeFileAtomic(
          join(dir, AGENT_JSON_FILENAME),
          serialiseAgentDefinition(definition),
          hooks,
        );
      } catch (cause) {
        throw new LibraryWriteError(`writing agent "${definition.id}"`, { cause });
      }

      const outcome = readFolder(dir, definition.id, null);
      if (!outcome.ok) {
        // Unreachable short of a concurrent hand-edit landing between the write
        // and the read: what was written came from the validated schema.
        throw new LibraryWriteError(
          `agent "${definition.id}" did not read back after being written: ` +
            outcome.diagnostics.map((d) => d.message).join('; '),
        );
      }
      return outcome.agent;
    },

    writePersona(id, text) {
      const outcome = readFolder(agentDir(id), id, null);
      const file = outcome.ok ? outcome.agent.definition.persona.file : 'persona.md';
      try {
        writeFileAtomic(join(agentDir(id), file), text, hooks);
      } catch (cause) {
        throw new LibraryWriteError(`writing the persona of "${id}"`, { cause });
      }
    },

    writeAvatar(id, bytes) {
      try {
        writeFileAtomic(join(agentDir(id), AVATAR_FILENAME), bytes, hooks);
      } catch (cause) {
        throw new LibraryWriteError(`writing the avatar of "${id}"`, { cause });
      }
    },

    removeAvatar(id) {
      const path = join(agentDir(id), AVATAR_FILENAME);
      try {
        unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    },

    readAvatar(dir, filename) {
      // The name comes from the definition, which the schema constrains to a
      // plain file name inside the folder — no separators, no `..`. Re-checked
      // here anyway: this function turns a stored string into a file read.
      if (basename(filename) !== filename || filename.includes('..')) return undefined;
      try {
        return readFileSync(join(dir, filename));
      } catch {
        return undefined;
      }
    },

    copyFolder(fromId, toId) {
      try {
        // Everything: persona, roles, skills and the avatar. Skills are copied
        // rather than linked, which is what keeps the folder the self-contained
        // unit export and git-versioning depend on (§9.2).
        cpSync(agentDir(fromId), agentDir(toId), {
          recursive: true,
          errorOnExist: true,
          force: false,
          filter: (source) => !basename(source).includes(TEMP_PREFIX),
        });
      } catch (cause) {
        throw new LibraryWriteError(`copying agent "${fromId}" to "${toId}"`, { cause });
      }
    },

    archive(id) {
      const stamp = archiveStamp(clock());
      const folder = `${id}-${stamp}`;
      const dir = join(paths.archive, folder);
      try {
        mkdirSync(paths.archive, { recursive: true });
        renameSync(agentDir(id), dir);
      } catch (cause) {
        throw new LibraryWriteError(`archiving agent "${id}"`, { cause });
      }
      return {
        id,
        folder,
        dir,
        archivedAt: parseArchiveStamp(stamp) ?? isoTimestamp(clock()),
      };
    },

    purge(id) {
      try {
        rmSync(agentDir(id), { recursive: true, force: true, maxRetries: 5 });
        for (const entry of archiveEntries()) {
          if (entry.id === id) rmSync(entry.dir, { recursive: true, force: true, maxRetries: 5 });
        }
      } catch (cause) {
        throw new LibraryWriteError(`purging agent "${id}"`, { cause });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The plugin manifest (§7.1)
// ---------------------------------------------------------------------------

/** What `.claude-plugin/plugin.json` holds: "name = agent id, version =
 *  `meta.updatedAt`" (§7.1). */
export function pluginManifest(definition: AgentDefinition): string {
  return `${JSON.stringify(
    {
      name: definition.id,
      version: definition.meta.updatedAt,
      description: definition.tagline ?? `${definition.name} — an AgentManager roster agent.`,
    },
    null,
    2,
  )}\n`;
}

/**
 * Writes the manifest when it is missing or stale.
 *
 * §7.1: "Roster generates `.claude-plugin/plugin.json` … on every write; it is
 * not hand-edited and is regenerated if missing." Regenerating on *load* as
 * well is what makes that true for a folder that arrived by `git pull` or by
 * being copied in by hand — the two ways an agent gets into the library without
 * roster having written it.
 *
 * The content is compared before writing so a load is a no-op on a healthy
 * folder: an unconditional write would touch a file on every reload, and the
 * watcher would then have a reason to reload again.
 *
 * A failure is a `warn` rather than a fatal: the agent is still perfectly
 * loadable, it just will not carry its skills until the library is writable
 * (which the diagnostic says).
 */
export function ensurePluginManifest(
  dir: string,
  definition: AgentDefinition,
  hooks: StoreHooks = {},
): Diagnostic | undefined {
  const manifestDir = join(dir, PLUGIN_MANIFEST_DIRNAME);
  const path = join(manifestDir, PLUGIN_MANIFEST_FILENAME);
  const wanted = pluginManifest(definition);

  try {
    if (existsSync(path) && readFileSync(path, 'utf8') === wanted) return undefined;
  } catch {
    // Unreadable is as good a reason to rewrite it as absent.
  }

  try {
    mkdirSync(manifestDir, { recursive: true });
    writeFileAtomic(path, wanted, hooks);
    return undefined;
  } catch (cause) {
    return {
      level: 'warn',
      code: 'roster.plugin-manifest',
      message:
        `${PLUGIN_MANIFEST_DIRNAME}/${PLUGIN_MANIFEST_FILENAME} could not be generated ` +
        `(${describe(cause)}); this agent's skills will not load (DESIGN §7.1).`,
      agentId: definition.id,
      path,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The hash a reload compares against.
 *
 * Over the authored bytes only — definition, persona, avatar. The generated
 * plugin manifest is deliberately excluded: it is derived from the definition,
 * so including it would make a manifest repair look like an agent change and
 * emit a `roster.changed` nobody made.
 */
function contentHash(definitionText: string, persona: string, avatar?: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(definitionText, 'utf8');
  hash.update('\0');
  hash.update(persona, 'utf8');
  hash.update('\0');
  if (avatar !== undefined) hash.update(avatar);
  return hash.digest('hex');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
