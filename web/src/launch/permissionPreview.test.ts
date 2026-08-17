/**
 * The permission preview and the elevation banner (DESIGN §6, §13.5).
 *
 * The preview's route — `POST /api/roster/agents/:id/validate` — is **roster M8**
 * and is not mounted in this build. These are the assertions that make the
 * degrade a designed behaviour rather than an accident: the panel says one honest
 * sentence, the elevation banner is *unaffected* because it reads facts roster
 * does not own, and a real refusal from a mounted route is still reported as a
 * refusal rather than swallowed as "not available".
 */

import { describe, expect, it } from 'vitest';

import { json } from '../../test/harness';
import { ApiClient } from '../api/client';

import {
  elevationBanner,
  fetchPermissionPreview,
  PREVIEW_UNAVAILABLE_NOTE,
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

describe('the roster M8 gap degrades to one sentence, not to a guess', () => {
  it('treats a 404 as "the route is not there yet"', async () => {
    const { client } = clientFor(() =>
      json({ error: 'not_found', message: 'No such route.' }, 404),
    );
    expect(await fetchPermissionPreview(client, 'priya', 'lpm')).toEqual({
      state: 'unavailable',
      note: PREVIEW_UNAVAILABLE_NOTE,
    });
    expect(PREVIEW_UNAVAILABLE_NOTE).toBe('permission preview available soon');
  });

  it('treats a 405 the same way, since a stub may answer method-not-allowed', async () => {
    const { client } = clientFor(() => json({ error: 'method_not_allowed', message: 'No.' }, 405));
    expect((await fetchPermissionPreview(client, 'priya', 'lpm')).state).toBe('unavailable');
  });

  it('never invents an effective set', async () => {
    const { client } = clientFor(() => json({}, 404));
    const preview = await fetchPermissionPreview(client, 'priya', 'lpm');
    expect(preview).not.toHaveProperty('effective');
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
