/**
 * `agent_ui_state` (roster DESIGN §2.2, §9.5; IMPLEMENTATION M3).
 *
 * Acceptance covered here, minus the HTTP and restart halves which the module
 * test owns: "`PUT /api/roster/board-order` rewrites every row in one
 * transaction […] replaying the same body is a no-op; an unknown agent id is a
 * 400 and leaves the previous order intact."
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Storage } from '../../storage/index.js';

import { makeTempDir, openTestStorage, type TempDir } from './__tests__/helpers.js';
import { createAgentUiStateRepository, type AgentUiStateRepository } from './uiState.js';

let temp: TempDir;
let storage: Storage;
let uiState: AgentUiStateRepository;

beforeEach(() => {
  temp = makeTempDir('agentmanager-roster-uistate-');
  storage = openTestStorage(temp.path);
  uiState = createAgentUiStateRepository(storage.db);
});

afterEach(() => {
  storage.close();
  temp.cleanup();
});

function order(): string[] {
  return uiState.list().map((row) => row.agentId);
}

describe('the element migration', () => {
  it('created the table under module "roster"', () => {
    expect(storage.setVersions['roster']).toBe(1);
    const rows = storage.db
      .prepare<[], { module: string; version: number }>(
        "SELECT module, version FROM schema_migrations WHERE module = 'roster'",
      )
      .all();
    expect(rows).toEqual([{ module: 'roster', version: 1 }]);
  });
});

describe('ensure', () => {
  it('appends new agents to the end of the board and is idempotent', () => {
    uiState.ensure('ada');
    uiState.ensure('linus');
    uiState.ensure('ada');

    expect(order()).toEqual(['ada', 'linus']);
    expect(uiState.get('ada')).toEqual({
      agentId: 'ada',
      boardOrder: 0,
      pinned: false,
      lastUsedAt: null,
    });
    expect(uiState.get('linus')?.boardOrder).toBe(1);
  });
});

describe('setBoardOrder (§9.5)', () => {
  beforeEach(() => {
    for (const id of ['ada', 'grace', 'linus']) uiState.ensure(id);
  });

  it('rewrites every row so the listed order is the board order', () => {
    uiState.setBoardOrder(['linus', 'ada', 'grace']);
    expect(order()).toEqual(['linus', 'ada', 'grace']);
    expect(uiState.list().map((row) => row.boardOrder)).toEqual([0, 1, 2]);
  });

  it('replays the same body as a no-op', () => {
    uiState.setBoardOrder(['linus', 'ada', 'grace']);
    const first = uiState.list();
    uiState.setBoardOrder(['linus', 'ada', 'grace']);
    expect(uiState.list()).toEqual(first);
  });

  it('keeps omitted ids in their relative order, after the listed ones', () => {
    uiState.setBoardOrder(['grace', 'ada', 'linus']);
    // `linus` and `ada` were 2 and 1; omitting both must keep linus after ada.
    uiState.setBoardOrder(['grace']);
    expect(order()).toEqual(['grace', 'ada', 'linus']);
  });

  it('preserves pinning, which is a different field entirely', () => {
    uiState.patch('ada', { pinned: true });
    uiState.setBoardOrder(['linus', 'grace', 'ada']);
    expect(uiState.get('ada')?.pinned).toBe(true);
  });

  it('creates a row for an id the board has not seen before', () => {
    uiState.setBoardOrder(['newcomer', 'ada']);
    expect(order().slice(0, 2)).toEqual(['newcomer', 'ada']);
  });
});

describe('patch', () => {
  it('sets pinned and last-used without touching board order', () => {
    uiState.ensure('ada');
    uiState.ensure('grace');
    uiState.setBoardOrder(['grace', 'ada']);

    const patched = uiState.patch('ada', {
      pinned: true,
      lastUsedAt: '2026-08-16T10:35:00.000Z',
    });

    expect(patched).toEqual({
      agentId: 'ada',
      boardOrder: 1,
      pinned: true,
      lastUsedAt: '2026-08-16T10:35:00.000Z',
    });
    expect(order()).toEqual(['grace', 'ada']);
  });
});

describe('reconcile', () => {
  it('adds rows for new agents and drops rows for ids that are gone', () => {
    uiState.ensure('ada');
    uiState.ensure('linus');

    uiState.reconcile(['ada', 'grace']);
    expect(order()).toEqual(['ada', 'grace']);
  });

  it('keeps the row of an agent that is merely failing to load', () => {
    uiState.ensure('ada');
    uiState.ensure('broken');
    uiState.setBoardOrder(['broken', 'ada']);

    // `broken` is out of the registry but its folder is still there, so its
    // board position must survive the owner fixing the typo.
    uiState.reconcile(['ada'], (id) => id === 'ada' || id === 'broken');
    expect(order()).toEqual(['broken', 'ada']);
  });
});

describe('durability', () => {
  it('survives closing and reopening the database', () => {
    for (const id of ['ada', 'grace', 'linus']) uiState.ensure(id);
    uiState.setBoardOrder(['linus', 'grace', 'ada']);
    uiState.patch('linus', { pinned: true });
    storage.close();

    storage = openTestStorage(temp.path);
    uiState = createAgentUiStateRepository(storage.db);

    expect(order()).toEqual(['linus', 'grace', 'ada']);
    expect(uiState.get('linus')?.pinned).toBe(true);
  });
});
