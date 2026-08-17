/**
 * Skills where they meet the library (roster IMPLEMENTATION M5).
 *
 * The four acceptance items that are about the *store and the service* rather
 * than about the compiler: the write-time refusal, the reload diagnostic, the
 * duplicate, and the plugin manifest that has to name the clone.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFixture } from './__tests__/fixtures.js';
import {
  makeHarness,
  makeTempDir,
  writeAgentFolder,
  writeFixtureAgent,
  writeSkillFolder,
  type Harness,
  type TempDir,
} from './__tests__/helpers.js';
import { RosterValidationError } from './errors.js';
import { SKILLS_DIRNAME } from './skills.js';
import { PLUGIN_MANIFEST_DIRNAME, PLUGIN_MANIFEST_FILENAME } from './store.js';

let temp: TempDir;
let harness: Harness;

beforeEach(() => {
  temp = makeTempDir('agentmanager-roster-skills-library-');
  harness = makeHarness({ dataRoot: temp.path });
});

afterEach(() => {
  harness.close();
  temp.cleanup();
});

const agentDirOf = (id: string): string => join(harness.libraryRoot, 'agents', id);

describe('the write-time refusal (§7.2)', () => {
  it('rejects a create whose declared skill has no folder, naming the folder', () => {
    let thrown: unknown;
    try {
      harness.service.create({
        name: 'Priya',
        specialty: 'bug-patching',
        skills: { mode: 'declared', names: ['triage-a-stack-trace'] },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RosterValidationError);
    const error = thrown as RosterValidationError;
    expect(error.issues[0]?.path).toBe('skills.names');
    expect(error.issues[0]?.message).toContain(
      join(agentDirOf('priya'), SKILLS_DIRNAME, 'triage-a-stack-trace'),
    );
    // Refused *before* the folder was written, not rolled back after.
    expect(harness.service.registry.get('priya')).toBeUndefined();
  });

  it('rejects a patch that names a skill the folder does not have', () => {
    const created = harness.service.create({ name: 'Priya', specialty: 'bug-patching' });
    expect(() =>
      harness.service.patch(created.definition.id, {
        skills: { mode: 'declared', names: ['nope'] },
      }),
    ).toThrowError(RosterValidationError);

    // The stored definition is untouched.
    expect(harness.service.get(created.definition.id).definition.skills).toBeUndefined();
  });

  it('accepts the same patch once the folder exists — this is a check, not a ban', () => {
    const created = harness.service.create({ name: 'Priya', specialty: 'bug-patching' });
    writeSkillFolder(agentDirOf(created.definition.id), 'triage-a-stack-trace');

    const patched = harness.service.patch(created.definition.id, {
      skills: { mode: 'declared', names: ['triage-a-stack-trace'] },
    });

    expect(patched.definition.skills).toEqual({
      mode: 'declared',
      names: ['triage-a-stack-trace'],
    });
    expect(patched.diagnostics).toEqual([]);
  });

  it('does not object to mode "all" or "none", which name nothing', () => {
    expect(() =>
      harness.service.create({
        name: 'Everything',
        specialty: 'general',
        skills: { mode: 'all' },
      }),
    ).not.toThrow();
    expect(() =>
      harness.service.create({ name: 'Nothing', specialty: 'general', skills: { mode: 'none' } }),
    ).not.toThrow();
  });
});

describe('a skill folder deleted externally (§7.2)', () => {
  it('produces a diagnostic on reload rather than a broken launch', () => {
    const definition = writeFixtureAgent(harness.libraryRoot, 'coder');
    harness.service.reload();
    expect(harness.service.get(definition.id).diagnostics).toEqual([]);

    rmSync(join(agentDirOf(definition.id), SKILLS_DIRNAME, 'triage-a-stack-trace'), {
      recursive: true,
      force: true,
    });
    harness.service.reload();

    const view = harness.service.get(definition.id);
    // Still loaded, still launchable: the compiler drops the name and starts.
    expect(view.definition.id).toBe(definition.id);
    expect(view.diagnostics).toEqual([
      expect.objectContaining({ level: 'warn', code: 'roster.skills.missing-folder' }),
    ]);
  });

  it('records what is on disk, so the compiler never has to read it again', () => {
    const definition = writeFixtureAgent(harness.libraryRoot, 'coder');
    writeSkillFolder(agentDirOf(definition.id), 'apply-a-patch');
    harness.service.reload();

    expect(harness.service.registry.get(definition.id)?.skills).toEqual([
      'apply-a-patch',
      'triage-a-stack-trace',
    ]);
  });

  it('is a warning, not an eviction — the agent stays in the registry', () => {
    const definition = loadFixture('coder');
    writeAgentFolder(harness.libraryRoot, definition, { skillFolders: false });
    harness.service.reload();

    expect(harness.service.registry.get(definition.id)).toBeDefined();
    expect(harness.service.registry.diagnostics().map((d) => d.code)).toContain(
      'roster.skills.missing-folder',
    );
  });
});

describe('duplicating an agent (§9.2, §7.1)', () => {
  it('copies the skills and names the clone in its own plugin manifest', () => {
    const definition = writeFixtureAgent(harness.libraryRoot, 'coder');
    writeSkillFolder(agentDirOf(definition.id), 'apply-a-patch');
    harness.service.reload();

    const clone = harness.service.duplicate(definition.id, { name: 'Priya Two' });
    const cloneId = clone.definition.id;
    const cloneDir = agentDirOf(cloneId);

    expect(existsSync(join(cloneDir, SKILLS_DIRNAME, 'triage-a-stack-trace', 'SKILL.md'))).toBe(
      true,
    );
    expect(existsSync(join(cloneDir, SKILLS_DIRNAME, 'apply-a-patch', 'SKILL.md'))).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(cloneDir, PLUGIN_MANIFEST_DIRNAME, PLUGIN_MANIFEST_FILENAME), 'utf8'),
    ) as { name: string };
    expect(manifest.name).toBe(cloneId);
    expect(manifest.name).not.toBe(definition.id);

    // The clone declares the same skills and passes the same write-time check,
    // which is only true because the folders came with it.
    expect(clone.definition.skills).toEqual(definition.skills);
    expect(clone.diagnostics).toEqual([]);

    // The source is untouched.
    expect(existsSync(join(agentDirOf(definition.id), SKILLS_DIRNAME))).toBe(true);
  });

  it('leaves a clone of a skill-less agent with no skills folder to copy', () => {
    const definition = writeFixtureAgent(harness.libraryRoot, 'minimal');
    mkdirSync(agentDirOf(definition.id), { recursive: true });
    harness.service.reload();

    const clone = harness.service.duplicate(definition.id, {});
    expect(existsSync(join(agentDirOf(clone.definition.id), SKILLS_DIRNAME))).toBe(false);
    expect(clone.diagnostics).toEqual([]);
  });
});
