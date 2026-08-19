/**
 * The golden fixtures of roster IMPLEMENTATION M1: "a coder, an email responder
 * (persona `replace`, one integration), an overseer, a minimal agent with every
 * optional field omitted."
 *
 * Beyond "they parse", each is asserted on the property it exists to cover, so
 * a future edit that quietly turns the minimal fixture into an ordinary one
 * fails here rather than silently reducing the suite's coverage.
 */
import { describe, expect, it } from 'vitest';

import { FIXTURE_NAMES, loadFixture } from './__tests__/fixtures.js';
import { diagnosticSchema, effectivePermissionsSchema } from './contracts.js';
import { isConnectorRef, isSecretRef } from './schema.js';

describe('golden fixtures', () => {
  it.each(FIXTURE_NAMES)('%s parses', (name) => {
    expect(loadFixture(name).schemaVersion).toBe(1);
  });

  it('the coder is a full definition using every optional field', () => {
    const coder = loadFixture('coder');
    expect(coder.id).toBe('priya-bugfix');
    expect(coder.persona.mode).toBe('append');
    expect(coder.permissions?.mode).toBe('acceptEdits');
    expect(coder.skills).toEqual({ mode: 'declared', names: ['triage-a-stack-trace'] });
    expect(coder.capabilities?.overseer).toBe(false);
    expect(coder.model).toEqual({ primary: 'sonnet', fallback: 'haiku', effort: 'high' });
    expect(coder.defaults?.maxBudgetUsd).toBe(2.5);
  });

  it('the email responder replaces the persona and carries one integration', () => {
    const marcus = loadFixture('email-responder');
    expect(marcus.persona.mode).toBe('replace');
    expect(marcus.settingSources).toEqual([]);

    const gmail = marcus.integrations?.['gmail'];
    // An attachment is a config or a library reference (§10.3); this fixture
    // declares its server inline, which is what the rest of this test reads.
    if (gmail === undefined || isConnectorRef(gmail)) {
      throw new Error('expected an inline integration');
    }
    expect(gmail.transport).toBe('stdio');
    if (gmail.transport !== 'stdio') throw new Error('expected the stdio transport');

    const token = gmail.env?.['GMAIL_TOKEN'];
    expect(token).toBeDefined();
    expect(token !== undefined && isSecretRef(token)).toBe(true);
    // The definition carries the ref and never the value (§10).
    expect(JSON.stringify(marcus)).not.toContain('ya29.');
    expect(gmail.env?.['GMAIL_PROFILE']).toBe('work');
  });

  it('the overseer carries the flag and the matching role (DESIGN §11)', () => {
    const iris = loadFixture('overseer');
    expect(iris.capabilities?.overseer).toBe(true);
    expect(iris.capabilities?.roles).toContain('overseer');
    expect(iris.permissions?.allow).toContain('mcp__agentmanager__*');
    // §11: an overseer is a coordinator, not an editor.
    expect(iris.permissions?.deny).toEqual(
      expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']),
    );
  });

  it('the minimal agent omits every optional field', () => {
    const nils = loadFixture('minimal');
    for (const key of [
      'avatar',
      'tagline',
      'tags',
      'model',
      'permissions',
      'skills',
      'integrations',
      'capabilities',
      'defaults',
    ] as const) {
      expect(nils[key]).toBeUndefined();
    }
    expect(nils.meta.duplicatedFrom).toBeUndefined();
  });
});

describe('contract shapes', () => {
  it('accepts an effective permission set with an applied elevation', () => {
    const effective = effectivePermissionsSchema.parse({
      mode: 'dontAsk',
      allow: ['Read'],
      deny: ['Bash(rm *)'],
      ask: [],
      elevation: { allow: ['Bash(npm run *)'], reason: 'sandbox project' },
    });
    expect(effective.elevation?.reason).toBe('sandbox project');
  });

  it('requires elevation to be stated, null included', () => {
    expect(
      effectivePermissionsSchema.safeParse({ mode: 'plan', allow: [], deny: [], ask: [] }).success,
    ).toBe(false);
  });

  it('requires an elevation to carry its reason (DESIGN §6.2)', () => {
    expect(
      effectivePermissionsSchema.safeParse({
        mode: 'plan',
        allow: [],
        deny: [],
        ask: [],
        elevation: { allow: ['Edit'] },
      }).success,
    ).toBe(false);
  });

  it('takes a diagnostic with a dotted code and an agent id', () => {
    const diagnostic = diagnosticSchema.parse({
      level: 'warn',
      code: 'roster.integration-without-allow-rule',
      message: 'gmail has no mcp__gmail__* allow rule',
      agentId: 'marcus-inbox',
      path: 'integrations.gmail',
    });
    expect(diagnostic.level).toBe('warn');
  });

  it('rejects a free-text diagnostic code', () => {
    expect(
      diagnosticSchema.safeParse({ level: 'error', code: 'Not a code!', message: 'x' }).success,
    ).toBe(false);
  });
});
