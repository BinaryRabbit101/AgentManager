/**
 * The rejection suite of roster IMPLEMENTATION M1.
 *
 * Every case asserts on the **path** as well as the failure, because §2.3
 * requires an invalid definition to become a diagnostic the UI can display on
 * the board, and "invalid agent" is not something anyone can act on.
 */
import { describe, expect, it } from 'vitest';

import { fixtureObject } from './__tests__/fixtures.js';
import type { RosterIssue } from './errors.js';
import { safeParseAgentDefinition } from './parse.js';
import { PERMISSION_MODES, permissionModeRank } from './schema.js';

/** Parses something that must fail, and returns its issues. */
function issuesFor(raw: unknown): readonly RosterIssue[] {
  const result = safeParseAgentDefinition(raw, 'agent.json');
  if (result.ok) throw new Error('expected the definition to be rejected');
  // The report a diagnostic carries always names the paths it is about.
  for (const issue of result.error.issues) {
    if (issue.path !== '') expect(result.error.report()).toContain(issue.path);
  }
  return result.error.issues;
}

function issueAt(raw: unknown, path: string): RosterIssue {
  const issues = issuesFor(raw);
  const found = issues.find((issue) => issue.path === path);
  if (found === undefined) {
    throw new Error(
      `expected an issue at "${path}", got: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
  }
  return found;
}

function withRoot(mutate: (raw: Record<string, unknown>) => void): Record<string, unknown> {
  const raw = fixtureObject('coder');
  mutate(raw);
  return raw;
}

describe('unknown keys', () => {
  it('rejects an unknown top-level key, naming it', () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['personna'] = { mode: 'append' };
      }),
      'personna',
    );
    expect(issue.message).toContain('unknown key "personna"');
  });

  it('rejects an unknown nested key at its own path', () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['capabilities'] = { overseer: false, roles: [], overser: true };
      }),
      'capabilities.overser',
    );
    expect(issue.message).toContain('unknown key "overser"');
  });
});

describe('agent id', () => {
  it.each([
    ['Priya-Bugfix', 'must be a slug'],
    ['priya bugfix', 'must be a slug'],
    ['priya--bugfix', 'must be a slug'],
    ['-priya', 'must be a slug'],
    ['a', 'at least 2 characters'],
    ['nul', 'is reserved'],
    ['import', 'is reserved'],
    ['agentmanager', 'is reserved'],
  ])('rejects %s', (id, expected) => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['id'] = id;
      }),
      'id',
    );
    expect(issue.message).toContain(expected);
  });
});

describe('settingSources (DESIGN §7.3)', () => {
  it('rejects "user" at the offending index', () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['settingSources'] = ['user'];
      }),
      'settingSources[0]',
    );
    expect(issue.message).toContain('"user" is rejected');
    expect(issue.message).toContain('host machine owner');
  });

  it('rejects "local" even beside a legal source', () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['settingSources'] = ['project', 'local'];
      }),
      'settingSources[1]',
    );
    expect(issue.message).toContain('"local" is rejected');
  });

  it('accepts [] for a hermetic agent', () => {
    const result = safeParseAgentDefinition(
      withRoot((raw) => {
        raw['settingSources'] = [];
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('permission mode (DESIGN §6.1, SDK-NOTES D1)', () => {
  it('rejects bypassPermissions with the reason, not a generic enum error', () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['permissions'] = { mode: 'bypassPermissions' };
      }),
      'permissions.mode',
    );
    expect(issue.message).toContain('"bypassPermissions" is not selectable');
    expect(issue.message).toContain('§6.1');
  });

  it('rejects the SDK\'s "auto" mode, which DESIGN predates', () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['permissions'] = { mode: 'auto' };
      }),
      'permissions.mode',
    );
    expect(issue.message).toContain('"auto" is not selectable');
  });

  it('orders the ladder plan < dontAsk < default < acceptEdits (DESIGN §6.2)', () => {
    expect([...PERMISSION_MODES]).toEqual(['plan', 'dontAsk', 'default', 'acceptEdits']);
    expect(permissionModeRank('plan')).toBeLessThan(permissionModeRank('dontAsk'));
    expect(permissionModeRank('dontAsk')).toBeLessThan(permissionModeRank('default'));
    expect(permissionModeRank('default')).toBeLessThan(permissionModeRank('acceptEdits'));
  });
});

describe('secret references (DESIGN §10)', () => {
  it('rejects a literal under a credential-shaped env key, naming the key', () => {
    const raw = fixtureObject('email-responder');
    const integrations = raw['integrations'] as Record<string, Record<string, unknown>>;
    const gmail = integrations['gmail'] as Record<string, unknown>;
    gmail['env'] = { GMAIL_TOKEN: 'ya29.a0-real-looking-token' };

    const issue = issueAt(raw, 'integrations.gmail.env.GMAIL_TOKEN');
    expect(issue.message).toContain('credential-shaped');
    expect(issue.message).toContain('secretRef');
  });

  it('rejects a literal under a credential-shaped header', () => {
    const raw = fixtureObject('email-responder');
    raw['integrations'] = {
      helpdesk: {
        transport: 'http',
        url: 'https://mcp.example.com/sse',
        headers: { Authorization: 'Bearer hunter2' },
      },
    };
    const issue = issueAt(raw, 'integrations.helpdesk.headers.Authorization');
    expect(issue.message).toContain('credential-shaped');
  });

  it('accepts a literal under an ordinary key', () => {
    const raw = fixtureObject('email-responder');
    const integrations = raw['integrations'] as Record<string, Record<string, unknown>>;
    const gmail = integrations['gmail'] as Record<string, unknown>;
    gmail['env'] = { GMAIL_PROFILE: 'work', GMAIL_TOKEN: { secretRef: 'mcp.gmail.token' } };
    expect(safeParseAgentDefinition(raw).ok).toBe(true);
  });

  it('rejects a secretRef that is not a foundation secret key', () => {
    const raw = fixtureObject('email-responder');
    const integrations = raw['integrations'] as Record<string, Record<string, unknown>>;
    const gmail = integrations['gmail'] as Record<string, unknown>;
    gmail['env'] = { GMAIL_TOKEN: { secretRef: 'mcp gmail token' } };
    const issue = issueAt(raw, 'integrations.gmail.env.GMAIL_TOKEN.secretRef');
    expect(issue.message).toContain('secret key');
  });
});

describe('cross-field rules', () => {
  it('requires "overseer" in roles when capabilities.overseer is set (DESIGN §11)', () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['capabilities'] = { overseer: true, roles: ['reviewer'] };
      }),
      'capabilities.roles',
    );
    expect(issue.message).toContain('must list "overseer"');
  });

  it('rejects skills.mode "declared" with no names', () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['skills'] = { mode: 'declared' };
      }),
      'skills.names',
    );
    expect(issue.message).toContain('requires at least one name');
  });

  it('rejects skills.names beside mode "all"', () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['skills'] = { mode: 'all', names: ['triage-a-stack-trace'] };
      }),
      'skills.names',
    );
    expect(issue.message).toContain('only meaningful with mode "declared"');
  });

  it('requires meta.duplicatedFrom when the origin is "duplicated" (DESIGN §9.2)', () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['meta'] = {
          createdAt: '2026-08-16T10:00:00.000Z',
          updatedAt: '2026-08-16T10:00:00.000Z',
          origin: 'duplicated',
          duplicatedFrom: null,
        };
      }),
      'meta.duplicatedFrom',
    );
    expect(issue.message).toContain('requires meta.duplicatedFrom');
  });
});

describe('field-level validation', () => {
  it("rejects a timestamp that is not foundation's ISO shape", () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['meta'] = {
          createdAt: '2026-08-16T10:00:00Z',
          updatedAt: '2026-08-16T10:00:00.000Z',
          origin: 'seed',
        };
      }),
      'meta.createdAt',
    );
    expect(issue.message).toContain('ISO-8601 UTC');
  });

  it('rejects an unknown specialty (the enum is closed in v1)', () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['specialty'] = 'devops';
      }),
      'specialty',
    );
    expect(issue.message).toBeTruthy();
  });

  it('rejects an avatar file that escapes the agent folder', () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['avatar'] = { kind: 'file', value: '../../secrets.png' };
      }),
      'avatar.value',
    );
    expect(issue.message).toContain('plain file name');
  });

  it('rejects an unbalanced permission rule', () => {
    const issue = issueAt(
      withRoot((raw) => {
        raw['permissions'] = { mode: 'plan', deny: ['Bash(rm *'] };
      }),
      'permissions.deny[0]',
    );
    expect(issue.message).toContain('Tool(pattern)');
  });

  it('rejects an integration name carrying the MCP separator', () => {
    const raw = fixtureObject('email-responder');
    raw['integrations'] = {
      g__mail: { transport: 'stdio', command: 'npx' },
    };
    const issue = issueAt(raw, 'integrations.g__mail');
    expect(issue.message).toContain('__');
  });

  it('accepts an unrecognised model string (warn-not-block, DESIGN §8)', () => {
    const result = safeParseAgentDefinition(
      withRoot((raw) => {
        raw['model'] = { primary: 'claude-something-released-tomorrow' };
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('defaults', () => {
  it('applies the stated persona and settingSources defaults (DESIGN §5, §7.3)', () => {
    const result = safeParseAgentDefinition(fixtureObject('minimal'));
    if (!result.ok) throw result.error;
    expect(result.value.persona).toEqual({ mode: 'append', file: 'persona.md' });
    expect(result.value.settingSources).toEqual(['project']);
  });

  it("leaves permissions, skills and capabilities absent — those are the compiler's call", () => {
    const result = safeParseAgentDefinition(fixtureObject('minimal'));
    if (!result.ok) throw result.error;
    expect(result.value.permissions).toBeUndefined();
    expect(result.value.skills).toBeUndefined();
    expect(result.value.capabilities).toBeUndefined();
  });
});
