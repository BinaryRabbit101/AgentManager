/**
 * Slug generation (projects DESIGN §1.1; IMPLEMENTATION M1).
 *
 * > "Slug collisions produce `app`, `app-2`, `app-3`; slugs never exceed 24
 * > chars and match `^[a-z0-9-]+$`."
 *
 * The invariant worth being strict about is that the 24-character cap holds
 * *after* the dedup suffix is added, because §4.4 spends the rest of the budget
 * on `%LOCALAPPDATA%\AgentManager\worktrees\<slug>\<id8>` and a branch name.
 */
import { describe, expect, it } from 'vitest';

import { SlugExhaustedError } from './errors.js';
import {
  dedupeSlug,
  isSlug,
  slugify,
  FALLBACK_SLUG,
  MAX_SLUG_LENGTH,
  SLUG_PATTERN,
} from './slug.js';

/** A `isTaken` predicate over a fixed set. */
function taken(...slugs: string[]): (slug: string) => boolean {
  const set = new Set(slugs);
  return (slug) => set.has(slug);
}

describe('slugify', () => {
  it.each([
    ['App', 'app'],
    ['My App', 'my-app'],
    ['My App (v2)', 'my-app-v2'],
    ['  spaced  out  ', 'spaced-out'],
    ['UPPER_snake.case', 'upper-snake-case'],
    ['---dashes---', 'dashes'],
    ['agent_manager', 'agent-manager'],
  ])('reduces %j to %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('folds diacritics rather than dropping the letters they sit on', () => {
    // `caf` would be the result of simply deleting anything non-ASCII.
    expect(slugify('Café Münster')).toBe('cafe-munster');
  });

  it('falls back when a name reduces to nothing sluggable', () => {
    expect(slugify('工程')).toBe(FALLBACK_SLUG);
    expect(slugify('!!!')).toBe(FALLBACK_SLUG);
  });

  it('caps at 24 characters and never ends on a dash', () => {
    const slug = slugify('a-really-very-extremely long project name');
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug).toMatch(SLUG_PATTERN);
  });
});

describe('dedupeSlug', () => {
  it('produces app, app-2, app-3 as collisions accumulate', () => {
    expect(dedupeSlug('App', taken())).toBe('app');
    expect(dedupeSlug('App', taken('app'))).toBe('app-2');
    expect(dedupeSlug('App', taken('app', 'app-2'))).toBe('app-3');
    expect(dedupeSlug('App', taken('app', 'app-2', 'app-3'))).toBe('app-4');
  });

  it('keeps the suffix inside the 24-character cap by shortening the stem', () => {
    const long = 'an-extremely-long-project-name-indeed';
    const base = dedupeSlug(long, taken());
    expect(base.length).toBe(MAX_SLUG_LENGTH);

    const second = dedupeSlug(long, taken(base));
    expect(second.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(second.endsWith('-2')).toBe(true);
    expect(second).toMatch(SLUG_PATTERN);
    // The suffix ate into the stem rather than extending past the cap.
    expect(second).not.toBe(`${base}-2`);
  });

  it('never emits a double dash when truncation lands on one', () => {
    // `…-` + `-2` is the shape a naive implementation produces.
    const slug = dedupeSlug('abcdefghij-klmnopqrst-uvw', (candidate) => candidate.length === 24);
    expect(slug).toMatch(SLUG_PATTERN);
    expect(slug).not.toContain('--');
  });

  it('every slug it produces satisfies the stored shape', () => {
    const used = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const slug = dedupeSlug('My App!!', (candidate) => used.has(candidate));
      expect(isSlug(slug)).toBe(true);
      expect(slug).toMatch(SLUG_PATTERN);
      expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
      used.add(slug);
    }
    expect(used.size).toBe(50);
  });

  it('gives up with a typed error rather than looping forever', () => {
    expect(() => dedupeSlug('app', () => true)).toThrow(SlugExhaustedError);
  });
});

describe('isSlug', () => {
  it.each([
    ['app', true],
    ['app-2', true],
    ['a'.repeat(MAX_SLUG_LENGTH), true],
    ['a'.repeat(MAX_SLUG_LENGTH + 1), false],
    ['App', false],
    ['my_app', false],
    ['my app', false],
    ['', false],
  ])('%j → %s', (value, expected) => {
    expect(isSlug(value)).toBe(expected);
  });
});
