/**
 * Round-trip and canonical-form tests (roster IMPLEMENTATION M1 acceptance).
 *
 * The property that matters operationally is not "the bytes match the fixture"
 * — a human may write `agent.json` any way they like — but that *roster's own*
 * write of a definition it just read is stable. §2.3 watches the library for
 * external edits; a write that reordered a key would look like an edit, reload,
 * and write again.
 */
import { describe, expect, it } from 'vitest';

import {
  CANONICAL_FIXTURE,
  FIXTURE_NAMES,
  loadFixture,
  readFixture,
} from './__tests__/fixtures.js';
import { RosterValidationError } from './errors.js';
import {
  canonicaliseAgentDefinition,
  parseAgentDefinitionJson,
  serialiseAgentDefinition,
} from './parse.js';

describe('round trip', () => {
  it('parse → serialise → parse → serialise is byte-identical for the canonical fixture', () => {
    const first = loadFixture(CANONICAL_FIXTURE);
    const onceWritten = serialiseAgentDefinition(first);
    const reread = parseAgentDefinitionJson(onceWritten, 'agent.json');
    const twiceWritten = serialiseAgentDefinition(reread);

    expect(twiceWritten).toBe(onceWritten);
    expect(reread).toEqual(first);
  });

  it.each(FIXTURE_NAMES)('is stable for the %s fixture too', (name) => {
    const definition = loadFixture(name);
    const once = serialiseAgentDefinition(definition);
    expect(serialiseAgentDefinition(parseAgentDefinitionJson(once))).toBe(once);
  });

  it('survives a hand edit that reorders keys', () => {
    const definition = loadFixture(CANONICAL_FIXTURE);
    const shuffled = JSON.stringify(
      Object.fromEntries(Object.entries(canonicaliseAgentDefinition(definition)).reverse()),
    );
    expect(serialiseAgentDefinition(parseAgentDefinitionJson(shuffled))).toBe(
      serialiseAgentDefinition(definition),
    );
  });
});

describe('canonical form', () => {
  it('writes keys in schema order, not input order', () => {
    const definition = loadFixture(CANONICAL_FIXTURE);
    expect(Object.keys(canonicaliseAgentDefinition(definition))).toEqual([
      'schemaVersion',
      'id',
      'name',
      'avatar',
      'specialty',
      'tagline',
      'tags',
      'persona',
      'model',
      'permissions',
      'settingSources',
      'skills',
      'capabilities',
      'defaults',
      'meta',
    ]);
  });

  it("sorts records, whose key order is the author's and not meaningful", () => {
    const definition = loadFixture('email-responder');
    const canonical = canonicaliseAgentDefinition(definition) as {
      integrations: Record<string, { env: Record<string, unknown> }>;
    };
    const gmail = canonical.integrations['gmail'];
    expect(gmail).toBeDefined();
    expect(Object.keys(gmail?.env ?? {})).toEqual(['GMAIL_PROFILE', 'GMAIL_TOKEN']);
  });

  it('omits absent optionals but keeps an explicit null', () => {
    const minimal = canonicaliseAgentDefinition(loadFixture('minimal'));
    expect(minimal).not.toHaveProperty('avatar');
    expect(minimal).not.toHaveProperty('integrations');
    const meta = minimal['meta'] as Record<string, unknown>;
    expect(meta).not.toHaveProperty('duplicatedFrom');

    const coder = canonicaliseAgentDefinition(loadFixture(CANONICAL_FIXTURE));
    expect((coder['meta'] as Record<string, unknown>)['duplicatedFrom']).toBeNull();
  });

  it('ends with exactly one LF and uses no CRLF', () => {
    const text = serialiseAgentDefinition(loadFixture(CANONICAL_FIXTURE));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toContain('\r');
  });
});

describe('reading text', () => {
  it('tolerates a UTF-8 BOM, which Windows editors add', () => {
    const text = `\uFEFF${readFixture('minimal')}`;
    expect(parseAgentDefinitionJson(text, 'agent.json').id).toBe('nils');
  });

  it('reports malformed JSON as a document-level issue, not a field', () => {
    try {
      parseAgentDefinitionJson('{ "id": ', 'agent.json');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(RosterValidationError);
      const validation = error as RosterValidationError;
      expect(validation.issues[0]?.path).toBe('');
      expect(validation.source).toBe('agent.json');
      expect(validation.report()).toContain('<document>');
    }
  });
});
