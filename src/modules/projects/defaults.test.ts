/**
 * `defaults_json` / `retention_json` typing (projects DESIGN §1.2, §3.3;
 * IMPLEMENTATION M1).
 *
 * > "`defaults_json` and `retention_json` parse into typed objects with defaults
 * > applied for missing fields."
 *
 * The other property asserted throughout: **no parse throws**. A blob a newer
 * build wrote, or a hand edit in a DB browser, must cost the setting rather than
 * the project row.
 */
import { describe, expect, it } from 'vitest';

import {
  parseProjectDefaults,
  parseRetention,
  serializeProjectDefaults,
  serializeRetention,
  EMPTY_PROJECT_DEFAULTS,
} from './defaults.js';
import { BUILT_IN_RETENTION_DEFAULTS, type RetentionDefaults } from './types.js';

const globals: RetentionDefaults = { transcriptDays: 90, transcriptCapMb: 500, keepPinned: true };

describe('parseProjectDefaults', () => {
  it('defaults every field when the column is null, empty or `{}`', () => {
    for (const blob of [null, undefined, '', '   ', '{}']) {
      expect(parseProjectDefaults(blob)).toEqual(EMPTY_PROJECT_DEFAULTS);
    }
  });

  it('reads a full settings object back in roster’s shape', () => {
    const parsed = parseProjectDefaults(
      JSON.stringify({
        overseerAgentId: 'michael',
        permissions: { allow: ['Read'], deny: ['Bash(git push:*)'], ask: ['Write'], mode: 'plan' },
        permissionElevation: { allow: ['Bash(npm publish:*)'], reason: 'release day' },
        env: [
          { name: 'API_BASE', value: 'http://localhost' },
          { name: 'TOKEN', secretRef: 'p.t' },
        ],
        setupCommand: 'npm ci',
        instructionsPath: 'docs/brief.md',
      }),
    );

    expect(parsed.overseerAgentId).toBe('michael');
    expect(parsed.permissions).toEqual({
      allow: ['Read'],
      deny: ['Bash(git push:*)'],
      ask: ['Write'],
      mode: 'plan',
    });
    expect(parsed.permissionElevation).toEqual({
      allow: ['Bash(npm publish:*)'],
      reason: 'release day',
    });
    expect(parsed.env).toEqual([
      { name: 'API_BASE', value: 'http://localhost' },
      { name: 'TOKEN', secretRef: 'p.t' },
    ]);
    expect(parsed.setupCommand).toBe('npm ci');
    expect(parsed.instructionsPath).toBe('docs/brief.md');
    // Always empty here: the list lives in `project_default_agents` (§1.2).
    expect(parsed.agentIds).toEqual([]);
  });

  it('drops an elevation with no reason rather than honouring it', () => {
    const warnings: string[] = [];
    const parsed = parseProjectDefaults(
      JSON.stringify({ permissionElevation: { allow: ['Bash'], reason: '  ' } }),
      (message) => warnings.push(message),
    );
    expect(parsed.permissionElevation).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('survives a blob that is not JSON at all', () => {
    const warnings: string[] = [];
    expect(parseProjectDefaults('{not json', (m) => warnings.push(m))).toEqual(
      EMPTY_PROJECT_DEFAULTS,
    );
    expect(warnings[0]).toContain('not parseable');
  });

  it.each([['null'], ['[]'], ['"a string"'], ['7']])(
    'survives %s, which is valid JSON but not a settings object',
    (blob) => {
      expect(parseProjectDefaults(blob)).toEqual(EMPTY_PROJECT_DEFAULTS);
    },
  );

  it('drops malformed env entries and keeps the rest', () => {
    const warnings: string[] = [];
    const parsed = parseProjectDefaults(
      JSON.stringify({
        env: [{ value: 'no name' }, { name: 'OK', value: 'yes' }, { name: 'BAD' }],
      }),
      (m) => warnings.push(m),
    );
    expect(parsed.env).toEqual([{ name: 'OK', value: 'yes' }]);
    expect(warnings).toHaveLength(2);
  });
});

describe('serializeProjectDefaults', () => {
  it('omits agentIds, which are stored relationally (§1.2)', () => {
    const json = serializeProjectDefaults({ agentIds: ['a', 'b'], setupCommand: 'npm ci' });
    expect(JSON.parse(json)).toEqual({ setupCommand: 'npm ci' });
  });

  it('round-trips everything else it is given', () => {
    const defaults = {
      agentIds: [],
      overseerAgentId: 'michael',
      permissions: { deny: ['Bash(git push:*)'] },
      env: [{ name: 'TOKEN', secretRef: 'project.x.TOKEN' }],
    };
    expect(parseProjectDefaults(serializeProjectDefaults(defaults))).toEqual(defaults);
  });

  it('writes `{}` for a project with nothing configured', () => {
    expect(serializeProjectDefaults(EMPTY_PROJECT_DEFAULTS)).toBe('{}');
  });
});

describe('parseRetention', () => {
  it('returns null for a NULL column — the inherit-the-globals marker (§3.3)', () => {
    expect(parseRetention(null, globals)).toBeNull();
    expect(parseRetention(undefined, globals)).toBeNull();
    expect(parseRetention('  ', globals)).toBeNull();
  });

  it('fills every field a partial override omits', () => {
    expect(parseRetention('{"transcriptDays":30}', globals)).toEqual({
      transcriptDays: 30,
      transcriptCapMb: 500,
      keepPinned: true,
    });
    expect(parseRetention('{"keepPinned":false}', globals)).toEqual({
      transcriptDays: 90,
      transcriptCapMb: 500,
      keepPinned: false,
    });
  });

  it('takes the globals it is given, not the built-in numbers', () => {
    expect(
      parseRetention('{}', { transcriptDays: 7, transcriptCapMb: 50, keepPinned: false }),
    ).toEqual({ transcriptDays: 7, transcriptCapMb: 50, keepPinned: false });
  });

  it('ignores nonsense values rather than storing them', () => {
    expect(
      parseRetention('{"transcriptDays":-1,"transcriptCapMb":"lots","keepPinned":"yes"}', globals),
    ).toEqual(globals);
  });

  it('falls back to the globals for a blob that is not JSON', () => {
    expect(parseRetention('{oops', globals)).toEqual(globals);
  });
});

describe('serializeRetention', () => {
  it('writes NULL for "inherit"', () => {
    expect(serializeRetention(null)).toBeNull();
    expect(serializeRetention(undefined)).toBeNull();
  });

  it('round-trips an override', () => {
    const settings = { transcriptDays: 14, transcriptCapMb: 100, keepPinned: false };
    const json = serializeRetention(settings);
    expect(json).not.toBeNull();
    expect(parseRetention(json, BUILT_IN_RETENTION_DEFAULTS)).toEqual(settings);
  });
});
