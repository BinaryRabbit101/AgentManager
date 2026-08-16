/**
 * The golden agent definitions (roster IMPLEMENTATION M1).
 *
 * Four definitions that between them use every field the schema has, kept as
 * real `agent.json` files rather than object literals: M2 loads a library
 * directory from disk, M9 packs and unpacks these bytes, and a fixture that is
 * only ever a JavaScript object cannot catch a defect in either path.
 *
 * They are formatted by Prettier, like every other file in the repo, which is
 * *not* the canonical form `serialiseAgentDefinition` writes (Prettier keeps
 * short arrays on one line; the canonical writer does not). The round-trip test
 * asserts stability of the canonical form itself, not of these bytes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseAgentDefinitionJson } from '../parse.js';
import type { AgentDefinition } from '../schema.js';

export const FIXTURE_NAMES = ['coder', 'email-responder', 'overseer', 'minimal'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

/** The definition IMPLEMENTATION M1 calls "canonical" — the one every field
 *  ends up in, and the one the round-trip test uses. */
export const CANONICAL_FIXTURE: FixtureName = 'coder';

export function fixturePath(name: FixtureName): string {
  return fileURLToPath(new URL(`../__fixtures__/${name}.json`, import.meta.url));
}

export function readFixture(name: FixtureName): string {
  return readFileSync(fixturePath(name), 'utf8');
}

export function loadFixture(name: FixtureName): AgentDefinition {
  return parseAgentDefinitionJson(readFixture(name), `${name}.json`);
}

/** The parsed fixture as a mutable plain object, for tests that need to break
 *  one field and assert on the message. */
export function fixtureObject(name: FixtureName): Record<string, unknown> {
  return JSON.parse(readFixture(name)) as Record<string, unknown>;
}
