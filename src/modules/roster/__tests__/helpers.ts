/**
 * Test helpers for the roster element's M2/M3 surface.
 *
 * Every directory these create lives under the OS temp dir — never the
 * developer's real data root and never inside the repository (foundation §1.2),
 * and never the library the running service uses.
 *
 * The harness wires the real store, the real registry, the real SQLite table and
 * the real service, with only two seams substituted: `git` (so a machine
 * without it still runs the suite) and the clock. Everything a test asserts
 * about atomicity, reload behaviour or transactions is therefore asserted about
 * the production path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findInstallRoot } from '../../../config/index.js';
import { openStorage, type EventsRepository, type Storage } from '../../../storage/index.js';
import { createEventBus } from '../../bus.js';
import type { AppEvent, EventBus } from '../../types.js';
import type { GitCommand } from '../bootstrap.js';
import { createRosterService, type RosterService } from '../service.js';
import { createRosterStore, type RosterStore, type StoreHooks } from '../store.js';
import { serialiseAgentDefinition } from '../parse.js';
import type { AgentDefinition } from '../schema.js';
import { createAgentUiStateRepository, type AgentUiStateRepository } from '../uiState.js';

import { loadFixture, type FixtureName } from './fixtures.js';

/** The repository root, which also holds the shipped `migrations/` tree. */
export const repoRoot = findInstallRoot(dirname(fileURLToPath(import.meta.url)));

/** Foundation's numbered set. */
export const migrationsDir = resolve(repoRoot, 'migrations');

/** This element's set, exactly as `moduleMigrationsFor` would compute it. */
export const rosterMigrationsDir = resolve(migrationsDir, 'roster');

export const FIXED_NOW = new Date('2026-08-16T10:00:00.000Z');

export interface TempDir {
  readonly path: string;
  cleanup(): void;
}

export function makeTempDir(prefix = 'agentmanager-roster-'): TempDir {
  const path = mkdtempSync(resolve(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true, maxRetries: 5 }) };
}

/**
 * A temp directory whose name contains a space.
 *
 * M2's acceptance calls for "spaces in the data directory" explicitly, because
 * a quoting bug in a spawned `git` or a `join` written as string concatenation
 * only shows up on a path like `C:\Users\Bob Smith\AppData\…` — which is the
 * *normal* case on Windows, not an exotic one.
 */
export function makeSpacedTempDir(prefix = 'agentmanager roster '): TempDir {
  return makeTempDir(prefix);
}

/** Opens real storage with this element's migration set appended. */
export function openTestStorage(dataRoot: string, libraryRoot?: string): Storage {
  return openStorage({
    dataRoot,
    ...(libraryRoot === undefined ? {} : { libraryRoot }),
    migrationsDir,
    moduleMigrations: [{ moduleId: 'roster', dir: rosterMigrationsDir }],
    tightenAcl: false,
  });
}

/** A git that answers from a table, so a test needs neither git nor a repo. */
export function fakeGit(answers: Readonly<Record<string, { ok: boolean; stdout?: string }>> = {}): {
  git: GitCommand;
  calls: string[][];
} {
  const calls: string[][] = [];
  const git: GitCommand = (args) => {
    calls.push([...args]);
    const answer = answers[args[0] ?? ''] ?? { ok: true };
    return {
      ok: answer.ok,
      stdout: answer.stdout ?? '',
      stderr: answer.ok ? '' : 'fake git failed',
    };
  };
  return { git, calls };
}

/** Collects everything the bus emits, wired to the real `events` repository. */
export function recordingBus(events?: EventsRepository): { bus: EventBus; emitted: AppEvent[] } {
  const emitted: AppEvent[] = [];
  const bus = createEventBus({
    clock: () => FIXED_NOW,
    ...(events === undefined ? {} : { events }),
  });
  bus.subscribe((event) => void emitted.push(event));
  return { bus, emitted };
}

export interface Harness {
  readonly storage: Storage;
  readonly store: RosterStore;
  readonly uiState: AgentUiStateRepository;
  readonly service: RosterService;
  readonly events: AppEvent[];
  readonly libraryRoot: string;
  readonly dataRoot: string;
  close(): void;
}

export interface HarnessOptions {
  readonly dataRoot: string;
  /** Defaults to `<dataRoot>/library`, which is where foundation puts it. */
  readonly libraryRoot?: string;
  readonly hooks?: StoreHooks;
  readonly now?: () => Date;
}

/** Storage + store + ui state + service, wired the way the module wires them. */
export function makeHarness(options: HarnessOptions): Harness {
  const storage = openTestStorage(options.dataRoot, options.libraryRoot);
  const libraryRoot = storage.paths.library;
  const store = createRosterStore({
    root: libraryRoot,
    clock: options.now ?? (() => FIXED_NOW),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  const uiState = createAgentUiStateRepository(storage.db);
  const { bus, emitted } = recordingBus(storage.store.events);
  const service = createRosterService({
    store,
    uiState,
    agents: storage.store.agents,
    sessions: storage.store.sessions,
    bus,
    clock: options.now ?? (() => FIXED_NOW),
  });
  return {
    storage,
    store,
    uiState,
    service,
    events: emitted,
    libraryRoot,
    dataRoot: options.dataRoot,
    close: () => storage.close(),
  };
}

/**
 * Writes an agent folder the way a hand-editing owner or a `git pull` would —
 * bypassing the store entirely, so a test that loads it is testing the loader
 * rather than its own writer.
 */
export function writeAgentFolder(
  libraryRoot: string,
  definition: AgentDefinition,
  options: { readonly persona?: string; readonly files?: Record<string, string> } = {},
): string {
  const dir = join(libraryRoot, 'agents', definition.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.json'), serialiseAgentDefinition(definition), 'utf8');
  writeFileSync(
    join(dir, definition.persona.file),
    options.persona ?? `# ${definition.name}\n\nA fixture persona.\n`,
    'utf8',
  );
  for (const [relative, contents] of Object.entries(options.files ?? {})) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
  return dir;
}

/** Writes one of M1's golden fixtures into a library. */
export function writeFixtureAgent(
  libraryRoot: string,
  name: FixtureName,
  options?: { readonly persona?: string; readonly files?: Record<string, string> },
): AgentDefinition {
  const definition = loadFixture(name);
  writeAgentFolder(libraryRoot, definition, options ?? {});
  return definition;
}

/** A one-pixel PNG — real magic bytes, so the sniffer is exercised, not stubbed. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A one-pixel JPEG header — enough for the sniffer, not a decodable image. */
export const TINY_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 0x20),
]);

/** A minimal RIFF/WEBP container. */
export const TINY_WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'latin1'),
  Buffer.alloc(16, 0),
]);

/** A multipart/form-data body carrying one file part. */
export function multipartBody(
  boundary: string,
  file: Buffer,
  options: { readonly filename?: string; readonly contentType?: string } = {},
): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `content-disposition: form-data; name="avatar"; filename="${options.filename ?? 'face.png'}"\r\n` +
      `content-type: ${options.contentType ?? 'image/png'}\r\n\r\n`,
    'latin1',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1');
  return Buffer.concat([head, file, tail]);
}

/** Sleeps, for the two tests that genuinely have to wait for the filesystem. */
export function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
