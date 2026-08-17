/**
 * The clone half of quick-add (DESIGN §8.1, IMPLEMENTATION §7).
 *
 * > "**Clone** calls `POST /api/projects/clone` and returns immediately. The
 * > dialog can be dismissed: the project appears in the rail at once with a
 * > `provisioning` state and an inline progress bar driven by
 * > `project.clone.progress`, flipping to `active` on `completed` or disappearing
 * > with the git stderr shown verbatim on `failed`."
 *
 * The whole of that is a fold over three events, so it is a pure function of the
 * frames and lives here rather than inside a component — which is precisely what
 * makes "survives dismissing the dialog" true rather than hoped for: the state
 * belongs to the app, not to the dialog that started it, so the dialog can
 * unmount without taking the progress bar with it.
 *
 * **Git's stderr is never paraphrased.** projects §2.2 returns it verbatim
 * because the credential helper is the user's and an auth failure names the fix.
 * A friendlier sentence here would delete the one useful fact on the screen.
 */

import type { EventFrame } from '../api/types';

export interface CloneProgress {
  readonly projectId: string;
  /** git's own wording: `Receiving objects`, `Resolving deltas`, `Cloning`. */
  readonly phase: string;
  /** `0`–`100`, or `null` for a phase git reports without one. */
  readonly percent: number | null;
  readonly state: 'running' | 'completed' | 'failed';
  /** git's stderr, verbatim, on failure. */
  readonly stderr: string | null;
}

export type CloneProgressMap = Readonly<Record<string, CloneProgress>>;

export const NO_CLONES: CloneProgressMap = Object.freeze({});

/**
 * Folds one `project.clone.*` frame into the map.
 *
 * A `completed` entry is dropped rather than kept: the project row itself flips
 * to `active` and the rail renders that, so keeping a finished progress bar
 * beside it would be two claims about one fact. A `failed` entry is kept —
 * projects deletes the row, so this map is the only place the message survives,
 * and the user has to be able to read it.
 */
export function applyCloneEvent(current: CloneProgressMap, frame: EventFrame): CloneProgressMap {
  const payload =
    typeof frame.payload === 'object' && frame.payload !== null
      ? (frame.payload as Record<string, unknown>)
      : {};
  const projectId =
    frame.ids['projectId'] ??
    (typeof payload['projectId'] === 'string' ? payload['projectId'] : undefined);
  if (projectId === undefined || projectId === '') return current;

  switch (frame.type) {
    case 'project.clone.progress': {
      const percent = typeof payload['percent'] === 'number' ? payload['percent'] : null;
      return {
        ...current,
        [projectId]: {
          projectId,
          phase: typeof payload['phase'] === 'string' ? payload['phase'] : 'Cloning',
          percent,
          state: 'running',
          stderr: null,
        },
      };
    }
    case 'project.clone.completed': {
      const { [projectId]: _done, ...rest } = current;
      return rest;
    }
    case 'project.clone.failed': {
      return {
        ...current,
        [projectId]: {
          projectId,
          phase: 'Failed',
          percent: null,
          state: 'failed',
          stderr: typeof payload['stderr'] === 'string' ? payload['stderr'] : null,
        },
      };
    }
    default:
      return current;
  }
}

export const CLONE_EVENT_TYPES: readonly string[] = [
  'project.clone.progress',
  'project.clone.completed',
  'project.clone.failed',
];

/** One line under the bar; git's phase, with a percentage only when git gave one. */
export function cloneProgressLabel(progress: CloneProgress): string {
  if (progress.state === 'failed') return 'Clone failed';
  if (progress.percent === null) return progress.phase;
  return `${progress.phase} ${String(progress.percent)}%`;
}
