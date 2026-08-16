import { describe, expect, it } from 'vitest';

import { AGENT_ID_MAX_LENGTH, RESERVED_AGENT_IDS, agentIdProblem, isAgentId } from './ids.js';
import { immutableFieldViolations } from './schema.js';
import { loadFixture } from './__tests__/fixtures.js';

describe('agent id slugs', () => {
  it.each(['priya-bugfix', 'iris', 'a1', 'agent-2', '2nd-opinion'])('accepts %s', (id) => {
    expect(isAgentId(id)).toBe(true);
  });

  it.each([
    '',
    'a',
    'Priya',
    'priya_bugfix',
    'priya bugfix',
    'priya--bugfix',
    '-priya',
    'priya-',
    'priya.bugfix',
    'priya/../etc',
    'x'.repeat(AGENT_ID_MAX_LENGTH + 1),
  ])('rejects %s', (id) => {
    expect(isAgentId(id)).toBe(false);
    expect(agentIdProblem(id)).toBeTypeOf('string');
  });

  it('reserves Windows device names, because the id is a folder name', () => {
    for (const device of ['con', 'prn', 'aux', 'nul', 'com1', 'lpt9']) {
      expect(RESERVED_AGENT_IDS.has(device)).toBe(true);
      expect(agentIdProblem(device)).toContain('reserved');
    }
  });

  it('reserves the names roster uses for itself and in its routes', () => {
    for (const name of ['agents', 'import', 'draft', 'board-order', 'agentmanager']) {
      expect(agentIdProblem(name)).toContain('reserved');
    }
  });

  it('every reserved id would otherwise be a legal slug', () => {
    // A reserved id that could not be typed anyway would be dead weight in the
    // list and would hide a real one going missing.
    for (const reserved of RESERVED_AGENT_IDS) {
      expect(agentIdProblem(reserved)).toContain('reserved');
    }
  });
});

describe('immutability (DESIGN §3, §9.3)', () => {
  it('reports nothing for an ordinary edit', () => {
    const previous = loadFixture('coder');
    const next = { ...previous, name: 'Priya P.' };
    expect(immutableFieldViolations(previous, next)).toEqual([]);
  });

  it('reports id and meta.createdAt when they move', () => {
    const previous = loadFixture('coder');
    const next = {
      ...previous,
      id: 'priya-bugfix-2',
      meta: { ...previous.meta, createdAt: '2020-01-01T00:00:00.000Z' },
    };
    expect(immutableFieldViolations(previous, next)).toEqual(['id', 'meta.createdAt']);
  });
});
