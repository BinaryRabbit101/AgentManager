/**
 * The file store (roster DESIGN §2.1, IMPLEMENTATION M2).
 *
 * Acceptance covered here:
 * - "A killed process mid-write leaves either the old or the new `agent.json`,
 *   never a truncated one (simulated by asserting writes go through
 *   temp+rename)";
 * - "Windows path handling verified: spaces in the data directory, long paths,
 *   no POSIX-only assumptions";
 * - "Corrupting one `agent.json` on disk removes exactly that agent […] and
 *   leaves the others loadable" — the per-folder half; the registry test owns
 *   the rest;
 * - generation of `.claude-plugin/plugin.json` (§7.1).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFixture } from './__tests__/fixtures.js';
import {
  makeSpacedTempDir,
  makeTempDir,
  writeAgentFolder,
  type TempDir,
} from './__tests__/helpers.js';
import { serialiseAgentDefinition } from './parse.js';
import {
  AGENT_JSON_FILENAME,
  archiveStamp,
  createRosterStore,
  libraryPaths,
  parseArchiveFolder,
  parseArchiveStamp,
  pluginManifest,
  writeFileAtomic,
  type RosterStore,
} from './store.js';

const NOW = new Date('2026-08-16T10:35:00.000Z');

let temp: TempDir;
let store: RosterStore;

function libraryAt(root: string): RosterStore {
  mkdirSync(join(root, 'agents'), { recursive: true });
  return createRosterStore({ root, clock: () => NOW });
}

beforeEach(() => {
  temp = makeTempDir('agentmanager-roster-store-');
  store = libraryAt(temp.path);
});

afterEach(() => {
  temp.cleanup();
});

describe('atomic writes (§2.3)', () => {
  it('writes through a temp sibling and renames it into place', () => {
    const target = join(temp.path, 'agent.json');
    writeFileSync(target, 'old bytes', 'utf8');

    const seen: { temp: string; target: string; tempBytes: string; targetBytes: string }[] = [];
    writeFileAtomic(target, 'new bytes', {
      beforeRename: (tempPath, targetPath) => {
        seen.push({
          temp: tempPath,
          target: targetPath,
          tempBytes: readFileSync(tempPath, 'utf8'),
          targetBytes: readFileSync(targetPath, 'utf8'),
        });
      },
    });

    // The one moment worth asserting about: the new bytes are complete in the
    // temp file, and the target has not been touched at all.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tempBytes).toBe('new bytes');
    expect(seen[0]?.targetBytes).toBe('old bytes');
    expect(seen[0]?.temp).not.toBe(seen[0]?.target);
    expect(seen[0]?.temp.startsWith(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('new bytes');
  });

  it('leaves the old agent.json intact when the process dies before the rename', () => {
    const definition = loadFixture('coder');
    writeAgentFolder(temp.path, definition, { persona: 'original persona' });
    const path = join(temp.path, 'agents', definition.id, AGENT_JSON_FILENAME);
    const before = readFileSync(path, 'utf8');

    const dying = createRosterStore({
      root: temp.path,
      clock: () => NOW,
      hooks: {
        beforeRename: () => {
          throw new Error('process killed');
        },
      },
    });

    expect(() =>
      dying.write({ ...definition, name: 'Renamed' }, 'a different persona'),
    ).toThrowError(/could not be written/);

    // Old bytes, whole and parseable — not a truncation, and not the new value.
    expect(readFileSync(path, 'utf8')).toBe(before);
    const outcome = store.load(definition.id);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.agent.definition.name).toBe(definition.name);
  });

  it('leaves no temp file behind when a write fails', () => {
    const definition = loadFixture('minimal');
    writeAgentFolder(temp.path, definition);
    const dying = createRosterStore({
      root: temp.path,
      hooks: {
        beforeRename: () => {
          throw new Error('process killed');
        },
      },
    });

    expect(() => dying.write(definition, 'x')).toThrow();
    const litter = readdirSync(join(temp.path, 'agents', definition.id)).filter((name) =>
      name.includes('.tmp-'),
    );
    expect(litter).toEqual([]);
  });
});

describe('loading a folder (§2.3)', () => {
  it('reads the definition, the persona and the folder path', () => {
    const definition = loadFixture('coder');
    writeAgentFolder(temp.path, definition, { persona: 'Reproduce first.\n' });

    const outcome = store.load(definition.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.agent.definition).toEqual(definition);
    expect(outcome.agent.persona).toBe('Reproduce first.\n');
    expect(outcome.agent.dir).toBe(join(temp.path, 'agents', definition.id));
    expect(outcome.agent.archivedAt).toBeNull();
    expect(outcome.agent.diagnostics).toEqual([]);
  });

  it('turns a corrupt agent.json into a diagnostic rather than a throw', () => {
    const definition = loadFixture('coder');
    writeAgentFolder(temp.path, definition);
    writeFileSync(
      join(temp.path, 'agents', definition.id, AGENT_JSON_FILENAME),
      '{ this is not json',
      'utf8',
    );

    const outcome = store.load(definition.id);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]?.level).toBe('error');
    expect(outcome.diagnostics[0]?.code).toBe('roster.invalid-definition');
    expect(outcome.diagnostics[0]?.agentId).toBe(definition.id);
  });

  it('refuses a folder whose definition carries a different id', () => {
    const definition = loadFixture('coder');
    const dir = join(temp.path, 'agents', 'someone-else');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, AGENT_JSON_FILENAME), serialiseAgentDefinition(definition), 'utf8');

    const outcome = store.load('someone-else');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.code).toBe('roster.id-mismatch');
    expect(outcome.diagnostics[0]?.message).toContain(definition.id);
  });

  it('warns, but still loads, when persona.md is missing', () => {
    const definition = loadFixture('minimal');
    const dir = join(temp.path, 'agents', definition.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, AGENT_JSON_FILENAME), serialiseAgentDefinition(definition), 'utf8');

    const outcome = store.load(definition.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.agent.persona).toBe('');
    expect(outcome.agent.diagnostics[0]?.code).toBe('roster.persona-missing');
  });

  it('lists only directories, skipping dot-folders and stray files', () => {
    writeAgentFolder(temp.path, loadFixture('coder'));
    writeAgentFolder(temp.path, loadFixture('minimal'));
    mkdirSync(join(temp.path, 'agents', '.git-ish'), { recursive: true });
    writeFileSync(join(temp.path, 'agents', 'README.md'), 'not an agent', 'utf8');

    expect(store.folderNames()).toEqual(['nils', 'priya-bugfix']);
  });

  it('changes its content hash when the persona changes and not otherwise', () => {
    const definition = loadFixture('coder');
    writeAgentFolder(temp.path, definition, { persona: 'one' });
    const first = store.load(definition.id);
    // A second read of untouched bytes must hash the same, or every reload
    // would look like a change (§2.3).
    const again = store.load(definition.id);
    writeAgentFolder(temp.path, definition, { persona: 'two' });
    const third = store.load(definition.id);

    expect(first.ok && again.ok && first.agent.contentHash === again.agent.contentHash).toBe(true);
    expect(first.ok && third.ok && first.agent.contentHash === third.agent.contentHash).toBe(false);
  });
});

describe('the plugin manifest (§7.1)', () => {
  it('is generated on write, naming the agent id and meta.updatedAt', () => {
    const definition = loadFixture('coder');
    store.write(definition, 'persona');

    const path = join(temp.path, 'agents', definition.id, '.claude-plugin', 'plugin.json');
    expect(readFileSync(path, 'utf8')).toBe(pluginManifest(definition));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      name: definition.id,
      version: definition.meta.updatedAt,
    });
  });

  it('is regenerated on load when a hand-copied folder has none', () => {
    const definition = loadFixture('coder');
    writeAgentFolder(temp.path, definition);
    const path = join(temp.path, 'agents', definition.id, '.claude-plugin', 'plugin.json');
    expect(existsSync(path)).toBe(false);

    const outcome = store.load(definition.id);
    expect(outcome.ok).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(outcome.ok && outcome.agent.diagnostics).toEqual([]);
  });

  it('is left alone on a second load, so a reload is not a write', () => {
    const definition = loadFixture('coder');
    writeAgentFolder(temp.path, definition);
    store.load(definition.id);
    const path = join(temp.path, 'agents', definition.id, '.claude-plugin', 'plugin.json');
    const stamp = statSync(path).mtimeMs;

    store.load(definition.id);
    expect(statSync(path).mtimeMs).toBe(stamp);
  });
});

describe('archive and purge (§9.3)', () => {
  it('moves the folder to .archive/<id>-<stamp>/ and reads it back by id', () => {
    const definition = loadFixture('coder');
    writeAgentFolder(temp.path, definition, { persona: 'archived persona' });

    const entry = store.archive(definition.id);
    expect(entry.folder).toBe(`${definition.id}-${archiveStamp(NOW)}`);
    expect(entry.archivedAt).toBe(NOW.toISOString());
    expect(existsSync(join(temp.path, 'agents', definition.id))).toBe(false);

    const entries = store.archiveEntries();
    expect(entries).toHaveLength(1);
    const outcome = store.loadArchived(entries[0]!);
    expect(outcome.ok && outcome.agent.definition.id).toBe(definition.id);
    expect(outcome.ok && outcome.agent.archivedAt).toBe(NOW.toISOString());
    expect(outcome.ok && outcome.agent.persona).toBe('archived persona');
  });

  it('uses a stamp with no characters Windows forbids in a path', () => {
    const stamp = archiveStamp(NOW);
    expect(stamp).toBe('20260816T103500000Z');
    expect(stamp).not.toMatch(/[:*?"<>|\\/]/);
    expect(parseArchiveStamp(stamp)).toBe(NOW.toISOString());
    expect(parseArchiveFolder(`priya-bugfix-${stamp}`)).toEqual({
      id: 'priya-bugfix',
      archivedAt: NOW.toISOString(),
    });
  });

  it('ignores a foreign folder inside .archive/', () => {
    mkdirSync(join(temp.path, '.archive', 'notes'), { recursive: true });
    expect(store.archiveEntries()).toEqual([]);
  });

  it('purge removes the live folder and every archived copy', () => {
    const definition = loadFixture('coder');
    writeAgentFolder(temp.path, definition);
    store.archive(definition.id);
    writeAgentFolder(temp.path, definition);

    store.purge(definition.id);
    expect(store.hasFolder(definition.id)).toBe(false);
    expect(store.archiveEntries()).toEqual([]);
  });
});

describe('copyFolder (§9.2)', () => {
  it('copies persona, roles, skills and avatar, and refuses an existing target', () => {
    const definition = loadFixture('coder');
    writeAgentFolder(temp.path, definition, {
      persona: 'the original',
      files: {
        'roles/skeptic.md': 'be sceptical',
        'skills/triage-a-stack-trace/SKILL.md': '# triage',
        'avatar.png': 'not really a png',
      },
    });

    store.copyFolder(definition.id, 'priya-bugfix-2');
    const clone = join(temp.path, 'agents', 'priya-bugfix-2');
    expect(readFileSync(join(clone, 'persona.md'), 'utf8')).toBe('the original');
    expect(readFileSync(join(clone, 'roles', 'skeptic.md'), 'utf8')).toBe('be sceptical');
    expect(
      readFileSync(join(clone, 'skills', 'triage-a-stack-trace', 'SKILL.md'), 'utf8'),
    ).toContain('triage');
    expect(existsSync(join(clone, 'avatar.png'))).toBe(true);

    expect(() => store.copyFolder(definition.id, 'priya-bugfix-2')).toThrowError(
      /could not be written/,
    );
  });
});

describe('Windows path handling (M2)', () => {
  it('works from a library root containing spaces', () => {
    const spaced = makeSpacedTempDir();
    try {
      const spacedStore = libraryAt(spaced.path);
      const definition = loadFixture('coder');
      const written = spacedStore.write(definition, 'persona in a spaced path');

      expect(written.dir).toContain(' ');
      expect(spacedStore.load(definition.id).ok).toBe(true);
      expect(readFileSync(join(written.dir, AGENT_JSON_FILENAME), 'utf8')).toContain(definition.id);
    } finally {
      spaced.cleanup();
    }
  });

  it('works from a library root well past the 260-character legacy limit', () => {
    // Each component stays inside the 255-character per-component limit; it is
    // the *total* that goes long, which is the case that breaks code assuming
    // MAX_PATH.
    const deep = join(
      temp.path,
      ...Array.from({ length: 8 }, (_, i) => `level-${String(i)}-${'x'.repeat(24)}`),
    );
    mkdirSync(join(deep, 'agents'), { recursive: true });
    const deepStore = createRosterStore({ root: deep, clock: () => NOW });

    const definition = loadFixture('coder');
    const written = deepStore.write(definition, 'persona at depth');

    expect(written.dir.length).toBeGreaterThan(260);
    expect(deepStore.load(definition.id).ok).toBe(true);
    expect(readFileSync(join(written.dir, 'persona.md'), 'utf8')).toBe('persona at depth');
  });

  it('composes every path with node:path rather than a separator literal', () => {
    const paths = libraryPaths(temp.path);
    for (const value of Object.values({ ...paths })) {
      // On Windows every one of these must be backslash-separated; on POSIX
      // every one must be forward-slash. Either way, nothing mixes.
      expect(value.startsWith(temp.path)).toBe(true);
    }
    expect(paths.agents).toBe(join(temp.path, 'agents'));
    expect(paths.archive).toBe(join(temp.path, '.archive'));
  });
});
