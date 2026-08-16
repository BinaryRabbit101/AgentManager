import { describe, expect, it } from 'vitest';

import { fixtureObject } from './__tests__/fixtures.js';
import { RosterValidationError } from './errors.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { AGENT_SCHEMA_VERSION } from './schema.js';
import { safeParseAgentDefinition } from './parse.js';

describe('migrate', () => {
  it('is the identity in v1', () => {
    const raw = fixtureObject('coder');
    expect(migrate(raw)).toEqual(raw);
    expect(MIGRATIONS).toHaveLength(0);
  });

  it('refuses a future schema version, naming both numbers (DESIGN §9.4)', () => {
    const raw = fixtureObject('coder');
    raw['schemaVersion'] = AGENT_SCHEMA_VERSION + 1;

    const result = safeParseAgentDefinition(raw, 'agent.json');
    if (result.ok) throw new Error('expected a rejection');
    const issue = result.error.issues[0];
    expect(issue?.path).toBe('schemaVersion');
    expect(issue?.message).toContain(String(AGENT_SCHEMA_VERSION + 1));
    expect(issue?.message).toContain(String(AGENT_SCHEMA_VERSION));
    expect(result.error.source).toBe('agent.json');
  });

  it('rejects a document that is not an object at all', () => {
    expect(() => migrate([1, 2, 3])).toThrow(RosterValidationError);
    const result = safeParseAgentDefinition('not an agent');
    if (result.ok) throw new Error('expected a rejection');
    expect(result.error.issues[0]?.path).toBe('');
  });

  it('leaves a missing or unusable schemaVersion to the schema', () => {
    const raw = fixtureObject('coder');
    delete raw['schemaVersion'];
    expect(() => migrate(raw)).not.toThrow();

    const result = safeParseAgentDefinition(raw);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.error.issues.some((issue) => issue.path === 'schemaVersion')).toBe(true);
  });
});
