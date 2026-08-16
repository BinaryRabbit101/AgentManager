/**
 * Minting an agent id from a name (roster DESIGN §9.1, §9.2).
 *
 * The service test proves the behaviour that has a milestone behind it — "a
 * colliding name yields `-2`, not an error". This file covers the edges that
 * would otherwise only show up as a validation failure at the very end of a
 * create: a name that slugifies to nothing, a name long enough that its suffix
 * pushes the id past the id length limit, and a name whose slug is reserved.
 */
import { describe, expect, it } from 'vitest';

import { AGENT_ID_MAX_LENGTH, isAgentId } from './ids.js';
import { FALLBACK_AGENT_SLUG, mintAgentId, slugifyAgentName, suffixAgentId } from './slug.js';

const free = (): boolean => false;

describe('slugifyAgentName', () => {
  it('lower-cases and hyphenates', () => {
    expect(slugifyAgentName('Priya Bugfix')).toBe('priya-bugfix');
    expect(slugifyAgentName('  Marcus / Inbox  ')).toBe('marcus-inbox');
    expect(slugifyAgentName('Agent 007')).toBe('agent-007');
  });

  it('folds diacritics rather than dropping the letter', () => {
    expect(slugifyAgentName('Renée Zoë')).toBe('renee-zoe');
  });

  it('falls back when a name slugifies to nothing', () => {
    expect(slugifyAgentName('🐛 🚀')).toBe(FALLBACK_AGENT_SLUG);
    expect(slugifyAgentName('   ')).toBe(FALLBACK_AGENT_SLUG);
    // One character is below the id minimum, so it takes the fallback too.
    expect(slugifyAgentName('A')).toBe(FALLBACK_AGENT_SLUG);
  });

  it('never produces a trailing hyphen, even after truncation', () => {
    const long = `${'ada '.repeat(40)}`;
    const slug = slugifyAgentName(long);
    expect(slug.length).toBeLessThanOrEqual(AGENT_ID_MAX_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
    expect(isAgentId(slug)).toBe(true);
  });
});

describe('suffixAgentId', () => {
  it('leaves the first attempt alone', () => {
    expect(suffixAgentId('priya-bugfix', 1)).toBe('priya-bugfix');
  });

  it('appends -2, -3 …', () => {
    expect(suffixAgentId('priya-bugfix', 2)).toBe('priya-bugfix-2');
    expect(suffixAgentId('priya-bugfix', 12)).toBe('priya-bugfix-12');
  });

  it('makes room for the suffix rather than overflowing the length limit', () => {
    const base = 'a'.repeat(AGENT_ID_MAX_LENGTH);
    const suffixed = suffixAgentId(base, 12);
    expect(suffixed.length).toBe(AGENT_ID_MAX_LENGTH);
    expect(suffixed.endsWith('-12')).toBe(true);
    expect(isAgentId(suffixed)).toBe(true);
  });
});

describe('mintAgentId', () => {
  it('returns the plain slug when it is free', () => {
    expect(mintAgentId('Priya Bugfix', free)).toBe('priya-bugfix');
  });

  it('walks the suffixes past every taken id', () => {
    const taken = new Set(['priya', 'priya-2', 'priya-3']);
    expect(mintAgentId('Priya', (id) => taken.has(id))).toBe('priya-4');
  });

  it('suffixes past a reserved slug instead of refusing the name', () => {
    // "Import" is a perfectly reasonable thing to call an agent; `import` is a
    // reserved id because it is an API path segment (ids.ts).
    expect(mintAgentId('Import', free)).toBe('import-2');
    expect(mintAgentId('NUL', free)).toBe('nul-2');
  });

  it('gives up rather than looping forever when the suffix space is exhausted', () => {
    expect(mintAgentId('Priya', () => true)).toBeUndefined();
  });

  it('only ever returns a valid agent id', () => {
    for (const name of ['Priya', '🐛', 'Import', 'Renée', 'x'.repeat(200)]) {
      const id = mintAgentId(name, free);
      expect(id).toBeDefined();
      expect(isAgentId(id as string)).toBe(true);
    }
  });
});
