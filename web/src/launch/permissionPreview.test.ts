/**
 * The permission preview and the elevation banner (DESIGN §6, §13.5).
 *
 * The preview's route — `POST /api/roster/agents/:id/validate` — was roster M8
 * and was not mounted when ui M3 shipped, so the panel degraded to one sentence.
 * **ui M8 closes that**: the route exists, both callers (§6's launch flow and
 * §7.3's agent page) come through this one accessor, and every non-`200` is now a
 * refusal reported with the server's own message rather than a "not available
 * yet".
 *
 * The elevation banner is unchanged and always was: it reads facts roster does
 * not own, which is why it never depended on the route landing.
 */

import { describe, expect, it } from 'vitest';

import { json } from '../../test/harness';
import { ApiClient } from '../api/client';

import {
  elevationBanner,
  fetchPermissionPreview,
  PREVIEW_MALFORMED_NOTE,
} from './permissionPreview';

function clientFor(respond: () => Response): { client: ApiClient; calls: string[] } {
  const calls: string[] = [];
  const client = new ApiClient({
    fetch: ((url: string) => {
      calls.push(url);
      return Promise.resolve(respond());
    }) as unknown as typeof globalThis.fetch,
    tokens: { get: () => null, set: () => undefined },
  });
  return { client, calls };
}

const EFFECTIVE = {
  mode: 'acceptEdits',
  allow: ['Read', 'Edit', 'Bash(npm test:*)'],
  deny: ['Bash(rm:*)'],
  ask: ['Bash(git push:*)'],
  elevation: null,
};

describe('the preview asks roster and renders what roster says (§4)', () => {
  it('posts the project id to /validate and returns the compiled set', async () => {
    const { client, calls } = clientFor(() => json({ effective: EFFECTIVE, diagnostics: [] }));
    const preview = await fetchPermissionPreview(client, 'priya', 'lpm');

    expect(calls).toEqual(['/api/roster/agents/priya/validate']);
    expect(preview.state).toBe('ready');
    if (preview.state !== 'ready') throw new Error('unreachable');
    // Read, never composed: the UI has no compiler to disagree with roster's.
    expect(preview.effective).toEqual(EFFECTIVE);
  });

  it('reports a real refusal as a failure, with the server’s message', async () => {
    const { client } = clientFor(() =>
      json({ error: 'unknown_project', message: 'No project "ghost" exists.' }, 400),
    );
    const preview = await fetchPermissionPreview(client, 'priya', 'ghost');
    expect(preview).toEqual({ state: 'failed', message: 'No project "ghost" exists.' });
  });
});

describe('the degrade is closed: every failure is a failure (ui M8)', () => {
  it('reports a 404 as a refusal with the server’s message, not as "coming soon"', async () => {
    const { client } = clientFor(() =>
      json({ error: 'not_found', message: 'No such agent.' }, 404),
    );
    expect(await fetchPermissionPreview(client, 'ghost', 'lpm')).toEqual({
      state: 'failed',
      message: 'No such agent.',
    });
  });

  it('never invents an effective set, whatever comes back', async () => {
    const { client } = clientFor(() => json({}, 404));
    const preview = await fetchPermissionPreview(client, 'priya', 'lpm');
    expect(preview).not.toHaveProperty('effective');
  });

  it('treats a 200 with no effective set as a contract break, and says so', async () => {
    // Not a state the UI models around — roster's `validate.test.ts` pins that
    // the route answers `{ effective, diagnostics }`, so this can only be a bug.
    const { client } = clientFor(() => json({ diagnostics: [] }));
    expect(await fetchPermissionPreview(client, 'priya', 'lpm')).toEqual({
      state: 'failed',
      message: PREVIEW_MALFORMED_NOTE,
    });
  });
});

describe('the elevation banner does not depend on roster (§6)', () => {
  const elevation = {
    allow: ['Bash(git push:*)'],
    reason: 'the deploy script needs to push tags',
  };

  it('shows the widened rules and the mandatory reason', () => {
    const banner = elevationBanner(elevation, true, 'project');
    expect(banner.elevation).toEqual(elevation);
    expect(banner.permitted).toBe(true);
    expect(banner.disabledReason).toBeNull();
  });

  it('renders disabled with the work-edition reason when policy forbids it', () => {
    const banner = elevationBanner(elevation, false, 'config-file');
    expect(banner.permitted).toBe(false);
    expect(banner.disabledReason).toBe('not permitted on this machine (work edition)');
    // §13.5: shown disabled **with the layer that set it**.
    expect(banner.layer).toBe('config-file');
    // Disabled, not hidden: the rules and the reason are still there to read.
    expect(banner.elevation).toEqual(elevation);
  });

  it('has nothing to show when the project declares no elevation', () => {
    expect(elevationBanner(undefined, true, undefined).elevation).toBeNull();
  });
});
