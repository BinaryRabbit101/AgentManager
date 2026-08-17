/**
 * Clone progress, as a fold (ui IMPLEMENTATION §7, criterion 1).
 *
 * > "Cloning a repo shows progress, survives dismissing the dialog, flips the
 * > card to `active` on completion, and on failure shows git's own message and
 * > removes the row."
 *
 * "Survives dismissing the dialog" is the reason this is a pure function over the
 * store rather than component state: the dialog is only where the clone was asked
 * for, and nothing about the progress belongs to it.
 */
import { describe, expect, it } from 'vitest';

import type { EventFrame } from '../api/types';

import { applyCloneEvent, cloneProgressLabel, NO_CLONES, type CloneProgress } from './clone';

function frame(type: string, payload: unknown, projectId = 'p1'): EventFrame {
  return { ts: '2026-08-17T09:00:00.000Z', type, ids: { projectId }, payload, persist: true };
}

describe('progress', () => {
  it('records git’s own phase and percentage', () => {
    const map = applyCloneEvent(
      NO_CLONES,
      frame('project.clone.progress', { phase: 'Receiving objects', percent: 47 }),
    );
    expect(map['p1']).toEqual({
      projectId: 'p1',
      phase: 'Receiving objects',
      percent: 47,
      state: 'running',
      stderr: null,
    });
    expect(cloneProgressLabel(map['p1'] as CloneProgress)).toBe('Receiving objects 47%');
  });

  it('carries a phase with no percentage without inventing one', () => {
    // git reports several phases without a number; a fabricated 0% would be a
    // progress bar that lies about being stuck.
    const map = applyCloneEvent(
      NO_CLONES,
      frame('project.clone.progress', { phase: 'Cloning', percent: null }),
    );
    expect(map['p1']?.percent).toBeNull();
    expect(cloneProgressLabel(map['p1'] as CloneProgress)).toBe('Cloning');
  });

  it('tracks two clones independently', () => {
    let map = applyCloneEvent(NO_CLONES, frame('project.clone.progress', { percent: 10 }, 'a'));
    map = applyCloneEvent(map, frame('project.clone.progress', { percent: 90 }, 'b'));
    expect(Object.keys(map).sort()).toEqual(['a', 'b']);
  });
});

describe('completion drops the row', () => {
  it('leaves the project record to say `active` on its own', () => {
    // Two claims about one fact is one too many: the rail already renders the
    // project's own `status`, which flips to `active`.
    let map = applyCloneEvent(NO_CLONES, frame('project.clone.progress', { percent: 99 }));
    map = applyCloneEvent(map, frame('project.clone.completed', { projectId: 'p1' }));
    expect(map).toEqual({});
  });
});

describe('failure keeps git’s own message', () => {
  it('keeps the row so the stderr can be read after the row is deleted', () => {
    // projects deletes the project row on a failed clone, so this map is the
    // only place the message survives.
    const map = applyCloneEvent(
      NO_CLONES,
      frame('project.clone.failed', {
        projectId: 'p1',
        stderr: "fatal: could not read Username for 'https://example.invalid': No such device",
      }),
    );
    expect(map['p1']?.state).toBe('failed');
    expect(map['p1']?.stderr).toBe(
      "fatal: could not read Username for 'https://example.invalid': No such device",
    );
    expect(cloneProgressLabel(map['p1'] as CloneProgress)).toBe('Clone failed');
  });

  it('says so plainly when git wrote nothing', () => {
    const map = applyCloneEvent(NO_CLONES, frame('project.clone.failed', { projectId: 'p1' }));
    expect(map['p1']?.stderr).toBeNull();
  });
});

describe('anything else is left alone', () => {
  it('ignores an unrelated event and a frame with no project id', () => {
    const map = applyCloneEvent(NO_CLONES, frame('session.started', {}));
    expect(map).toBe(NO_CLONES);
    expect(
      applyCloneEvent(NO_CLONES, {
        ts: '',
        type: 'project.clone.progress',
        ids: {},
        payload: {},
        persist: true,
      }),
    ).toBe(NO_CLONES);
  });
});
