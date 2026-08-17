/**
 * The board's filters and sort (DESIGN §5.1, §5.2).
 *
 * Pure functions, so the semantics are pinned without rendering a card — the
 * rendering half is `Board.test.tsx`.
 */

import { describe, expect, it } from 'vitest';

import { anAgent } from '../../test/harness';
import type { Diagnostic } from '../api/types';

import { diagnosticsForAgent, filterAgents, sortAgents } from './filters';
import { applySessionEvent, EMPTY_FLEET_STATUS, type FleetStatusMap } from './fleetStatus';

const DEFAULTS = { specialty: null, workingNow: false, needsAttention: false, archived: false };

function fleet(entries: Readonly<Record<string, string>>): FleetStatusMap {
  let map = EMPTY_FLEET_STATUS;
  for (const [agentId, type] of Object.entries(entries)) {
    map = applySessionEvent(map, {
      ts: '2026-08-17T09:00:00.000Z',
      type,
      ids: { agentId },
      payload: {},
      persist: true,
    });
  }
  return map;
}

const priya = anAgent({ id: 'priya', specialty: 'bug-patching', boardOrder: 2 });
const sam = anAgent({ id: 'sam', name: 'Sam', specialty: 'testing', boardOrder: 1 });
const old = anAgent({ id: 'old', name: 'Old', archivedAt: '2026-07-01T00:00:00.000Z' });

describe('filterAgents (§5.1)', () => {
  it('hides archived agents by default and shows them under the archive filter', () => {
    const all = [priya, sam, old];
    expect(filterAgents(all, DEFAULTS, EMPTY_FLEET_STATUS).map((a) => a.definition.id)).toEqual([
      'priya',
      'sam',
    ]);
    expect(
      filterAgents(all, { ...DEFAULTS, archived: true }, EMPTY_FLEET_STATUS).map(
        (a) => a.definition.id,
      ),
    ).toEqual(['old']);
  });

  it('filters by specialty, using roster’s own word', () => {
    expect(
      filterAgents([priya, sam], { ...DEFAULTS, specialty: 'testing' }, EMPTY_FLEET_STATUS).map(
        (a) => a.definition.id,
      ),
    ).toEqual(['sam']);
  });

  it('"working now" keeps queued and working, and drops idle', () => {
    const status = fleet({ priya: 'session.started', sam: 'session.queued' });
    expect(
      filterAgents([priya, sam, old], { ...DEFAULTS, workingNow: true }, status).map(
        (a) => a.definition.id,
      ),
    ).toEqual(['priya', 'sam']);

    const settled = fleet({ priya: 'session.ended', sam: 'session.queued' });
    expect(
      filterAgents([priya, sam], { ...DEFAULTS, workingNow: true }, settled).map(
        (a) => a.definition.id,
      ),
    ).toEqual(['sam']);
  });

  it('"needs attention" keeps only the agents waiting on a human', () => {
    const status = fleet({ priya: 'session.orphaned', sam: 'session.started' });
    expect(
      filterAgents([priya, sam], { ...DEFAULTS, needsAttention: true }, status).map(
        (a) => a.definition.id,
      ),
    ).toEqual(['priya']);
  });

  it('combines filters rather than replacing them', () => {
    const status = fleet({ priya: 'session.started', sam: 'session.started' });
    expect(
      filterAgents(
        [priya, sam],
        { ...DEFAULTS, workingNow: true, specialty: 'testing' },
        status,
      ).map((a) => a.definition.id),
    ).toEqual(['sam']);
  });
});

describe('sortAgents (§5.2)', () => {
  it('defaults to board order', () => {
    expect(sortAgents([priya, sam], 'board-order').map((a) => a.definition.id)).toEqual([
      'sam',
      'priya',
    ]);
  });

  it('sorts pinned agents ahead of the rest under every sort', () => {
    const pinned = anAgent({ id: 'zed', name: 'Zed', boardOrder: 99, pinned: true });
    for (const sort of ['board-order', 'name', 'recent'] as const) {
      expect(sortAgents([priya, sam, pinned], sort).map((a) => a.definition.id)[0], sort).toBe(
        'zed',
      );
    }
  });

  it('sorts by name and by recency', () => {
    const a = anAgent({ id: 'a', name: 'Ana', lastUsedAt: '2026-08-01T00:00:00.000Z' });
    const b = anAgent({ id: 'b', name: 'Bo', lastUsedAt: '2026-08-17T00:00:00.000Z' });
    expect(sortAgents([b, a], 'name').map((x) => x.definition.id)).toEqual(['a', 'b']);
    expect(sortAgents([a, b], 'recent').map((x) => x.definition.id)).toEqual(['b', 'a']);
  });

  it('never mutates the list it was given', () => {
    const input = [priya, sam];
    sortAgents(input, 'name');
    expect(input.map((a) => a.definition.id)).toEqual(['priya', 'sam']);
  });
});

describe('diagnosticsForAgent (§5.2)', () => {
  it('picks the library-wide diagnostics that name one agent', () => {
    const diagnostics: Diagnostic[] = [
      { level: 'error', code: 'invalid_agent_json', message: 'broken', agentId: 'priya' },
      { level: 'warn', code: 'unknown_model', message: 'odd model', agentId: 'sam' },
      { level: 'error', code: 'unreadable_folder', message: 'library-wide' },
    ];
    expect(diagnosticsForAgent(diagnostics, 'priya').map((d) => d.code)).toEqual([
      'invalid_agent_json',
    ]);
  });
});
