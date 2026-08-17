/**
 * Skills packaging (roster DESIGN §7, IMPLEMENTATION M5) — the pure half.
 *
 * The folder listing, the exact-name check in both of its moments, the enable
 * set, and the plugin config. The store/service/compiler wiring is asserted in
 * their own suites; what is here is the logic all three share.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFixture } from './__tests__/fixtures.js';
import { makeTempDir, writeSkillFolder, type TempDir } from './__tests__/helpers.js';
import type { AgentDefinition } from './schema.js';
import {
  SKILLS_DIRNAME,
  SKILL_TOOL,
  isAbsoluteAgentDir,
  listSkillNames,
  missingSkillFolders,
  pluginConfigFor,
  skillsEnableSet,
  validateSkills,
} from './skills.js';

let temp: TempDir;
let agentDir: string;

beforeEach(() => {
  temp = makeTempDir('agentmanager-roster-skills-');
  agentDir = join(temp.path, 'priya-bugfix');
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  temp.cleanup();
});

function declaring(names: string[]): Pick<AgentDefinition, 'id' | 'skills'> {
  return { id: 'priya-bugfix', skills: { mode: 'declared', names } };
}

describe('listing what is on disk (§7.1)', () => {
  it('returns the folder names under skills/, sorted', () => {
    writeSkillFolder(agentDir, 'triage-a-stack-trace');
    writeSkillFolder(agentDir, 'apply-a-patch');
    expect(listSkillNames(agentDir)).toEqual(['apply-a-patch', 'triage-a-stack-trace']);
  });

  it('is empty, not a throw, when the agent has no skills/ folder at all', () => {
    expect(listSkillNames(agentDir)).toEqual([]);
    expect(listSkillNames(join(temp.path, 'no-such-agent'))).toEqual([]);
  });

  it('ignores dot-folders and loose files', () => {
    writeSkillFolder(agentDir, 'triage-a-stack-trace');
    mkdirSync(join(agentDir, SKILLS_DIRNAME, '.git'), { recursive: true });
    writeFileSync(join(agentDir, SKILLS_DIRNAME, 'README.md'), 'not a skill', 'utf8');
    expect(listSkillNames(agentDir)).toEqual(['triage-a-stack-trace']);
  });
});

describe('the exact-name check (§7.2)', () => {
  it('names the missing folder, with its full path', () => {
    writeSkillFolder(agentDir, 'apply-a-patch');
    const diagnostics = validateSkills(
      declaring(['apply-a-patch', 'triage-a-stack-trace']),
      listSkillNames(agentDir),
      agentDir,
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.level).toBe('error');
    expect(diagnostics[0]?.code).toBe('roster.skills.missing-folder');
    expect(diagnostics[0]?.message).toContain(
      join(agentDir, SKILLS_DIRNAME, 'triage-a-stack-trace'),
    );
    expect(diagnostics[0]?.agentId).toBe('priya-bugfix');
  });

  it('says nothing about an agent whose declared skills are all present', () => {
    writeSkillFolder(agentDir, 'triage-a-stack-trace');
    expect(validateSkills(loadFixture('coder'), listSkillNames(agentDir), agentDir)).toEqual([]);
  });

  it('does not apply to mode "all" or "none" — there is nothing to be exact about', () => {
    expect(missingSkillFolders({ mode: 'all' }, [])).toEqual([]);
    expect(missingSkillFolders({ mode: 'none' }, [])).toEqual([]);
    expect(missingSkillFolders(undefined, [])).toEqual([]);
  });
});

describe('the enable set (§7.2)', () => {
  it('maps declared → the exact names, all → "all", none → []', () => {
    expect(skillsEnableSet(declaring(['a']), ['a']).skills).toEqual(['a']);
    expect(skillsEnableSet({ id: 'x', skills: { mode: 'all' } }, []).skills).toBe('all');
    expect(skillsEnableSet({ id: 'x', skills: { mode: 'none' } }, []).skills).toEqual([]);
  });

  it('yields an empty enable set and no Skill grant for mode "none"', () => {
    const result = skillsEnableSet({ id: 'x', skills: { mode: 'none' } }, ['a']);
    expect(result.skills).toEqual([]);
    expect(result.enabled).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it('treats an agent with no skills block at all as "none"', () => {
    const result = skillsEnableSet(loadFixture('minimal'), undefined);
    expect(result.skills).toEqual([]);
    expect(result.enabled).toBe(false);
  });

  it('drops a skill whose folder has gone, with a diagnostic, rather than breaking the launch', () => {
    const result = skillsEnableSet(declaring(['present', 'deleted']), ['present']);

    expect(result.skills).toEqual(['present']);
    expect(result.enabled).toBe(true);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.level).toBe('warn');
    expect(result.diagnostics[0]?.code).toBe('roster.skills.missing-folder');
    expect(result.diagnostics[0]?.message).toContain('deleted');
  });

  it('takes declared names on trust when the caller does not know the listing', () => {
    const result = skillsEnableSet(declaring(['whatever']), undefined);
    expect(result.skills).toEqual(['whatever']);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('the plugin config (§7.1, SDK-NOTES §4)', () => {
  it('is a local plugin at the absolute agent folder, with MCP discovery skipped', () => {
    const { plugin, diagnostics } = pluginConfigFor('priya-bugfix', agentDir);
    expect(diagnostics).toEqual([]);
    expect(plugin).toEqual({ type: 'local', path: agentDir, skipMcpDiscovery: true });
  });

  it('refuses a path the SDK would silently skip, and says why', () => {
    const relative = pluginConfigFor('priya-bugfix', join('.', 'agents', 'priya-bugfix'));
    expect(relative.plugin).toBeUndefined();
    expect(relative.diagnostics[0]?.code).toBe('roster.skills.relative-plugin-path');

    const tilde = pluginConfigFor('priya-bugfix', '~/library/agents/priya-bugfix');
    expect(tilde.plugin).toBeUndefined();
    expect(tilde.diagnostics[0]?.message).toContain('~');

    const absent = pluginConfigFor('priya-bugfix', undefined);
    expect(absent.plugin).toBeUndefined();
    expect(absent.diagnostics[0]?.code).toBe('roster.skills.no-agent-directory');
  });

  it('accepts a Windows path on any host, so the check is not a test of the runner', () => {
    expect(isAbsoluteAgentDir('C:\\library\\agents\\priya-bugfix')).toBe(true);
    expect(isAbsoluteAgentDir('/var/lib/agentmanager/agents/priya')).toBe(true);
    expect(isAbsoluteAgentDir('agents/priya')).toBe(false);
  });
});

describe('the Skill tool', () => {
  it('is spelled the way a permission rule spells it', () => {
    expect(SKILL_TOOL).toBe('Skill');
  });
});

describe('a skill folder deleted externally', () => {
  it('changes the listing, which is what makes the reload diagnostic possible', () => {
    writeSkillFolder(agentDir, 'triage-a-stack-trace');
    expect(listSkillNames(agentDir)).toEqual(['triage-a-stack-trace']);

    rmSync(join(agentDir, SKILLS_DIRNAME, 'triage-a-stack-trace'), {
      recursive: true,
      force: true,
    });

    expect(listSkillNames(agentDir)).toEqual([]);
    expect(skillsEnableSet(declaring(['triage-a-stack-trace']), listSkillNames(agentDir))).toEqual({
      skills: [],
      enabled: false,
      diagnostics: [expect.objectContaining({ code: 'roster.skills.missing-folder' })],
    });
  });
});
