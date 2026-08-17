/**
 * The live-region audit and the motion budget (IMPLEMENTATION §11).
 *
 * > "A screen reader announces status transitions, arriving questions and drag
 * > events — and does **not** announce streaming assistant text."
 *
 * > "`prefers-reduced-motion: reduce` removes both looping indicators and all
 * > transitions."
 *
 * The second one is asserted against the stylesheet rather than by animating
 * anything: jsdom evaluates no media queries and runs no animations, so what can
 * honestly be checked here is that the rule exists, that it covers **both**
 * loops by name, and that no component opts out of it. The visual half is on the
 * manual list (`M1-reduced-motion`), where it has been since M1.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { announcementFor } from './Announcer';
import { mountAt } from '../../test/routes';

const webSrc = resolve(process.cwd(), 'web', 'src');

afterEach(cleanup);

describe('what the app says out loud (§15)', () => {
  const nameOf = (id: string): string => (id === 'ada' ? 'Ada' : id);
  const frame = (
    type: string,
    ids: Record<string, string> = {},
  ): Parameters<typeof announcementFor>[0] => ({
    ts: '2026-08-17T09:00:00.000Z',
    type,
    ids,
    payload: undefined,
    persist: true,
  });

  it('announces status transitions, in the words §15 uses', () => {
    expect(announcementFor(frame('session.ended', { agentId: 'ada' }), nameOf)).toBe(
      "Ada's session finished.",
    );
    expect(announcementFor(frame('session.started', { agentId: 'ada' }), nameOf)).toContain(
      'started working',
    );
    expect(announcementFor(frame('session.paused', { agentId: 'ada' }), nameOf)).toContain(
      'paused',
    );
  });

  it('announces an arriving question', () => {
    expect(announcementFor(frame('assignment.question.raised'), nameOf)).toBe(
      'A question is waiting for you.',
    );
  });

  it('says nothing at all for streaming assistant text', () => {
    // The three types §3.3 keeps off the global feed entirely, and the ones
    // §15 names as the thing that must never be announced.
    for (const type of [
      'session.delta',
      'session.message',
      'session.tool.started',
      'session.tool.finished',
      'session.usage',
    ]) {
      expect(announcementFor(frame(type, { agentId: 'ada' }), nameOf), type).toBeUndefined();
    }
  });

  it('has one polite region for the whole app, and it starts empty', async () => {
    mountAt('/');
    await waitFor(() => expect(screen.getByRole('link', { name: 'Ada' })).toBeInTheDocument());
    const regions = [...document.querySelectorAll('[data-announcer="true"]')];
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveAttribute('aria-live', 'polite');
    expect(regions[0]?.textContent).toBe('');
  }, 20_000);

  it('speaks when an event arrives, and only then', async () => {
    const mounted = mountAt('/');
    await waitFor(() => expect(screen.getByRole('link', { name: 'Ada' })).toBeInTheDocument());
    const region = (): HTMLElement => document.querySelector('[data-announcer="true"]')!;

    mounted.stream.emit({ type: 'session.delta', ids: { agentId: 'ada' } });
    expect(region().textContent).toBe('');

    mounted.stream.emit({ type: 'session.ended', id: 'e1', ids: { agentId: 'ada' } });
    await waitFor(() => expect(region().textContent).toContain("Ada's session finished."));
  }, 20_000);

  it('leaves the transcript silent (§9.2, §15)', async () => {
    mountAt('/sessions/ses_1');
    const list = await waitFor(() => {
      const found = document.querySelector('.session__blocks');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(list).toHaveAttribute('aria-live', 'off');
  }, 20_000);

  it('uses assertive only for drag events, which are the user’s own gesture', async () => {
    mountAt('/');
    await waitFor(() => expect(screen.getByRole('link', { name: 'Ada' })).toBeInTheDocument());
    const assertive = [...document.querySelectorAll('[aria-live="assertive"]')];
    // dnd-kit's, and no other: an assertive region interrupts, and nothing else
    // in this app is urgent enough to interrupt a screen reader mid-sentence.
    expect(assertive.length).toBeGreaterThan(0);
    for (const region of assertive) {
      expect(region.id.startsWith('DndLiveRegion') || region.hasAttribute('data-dnd')).toBe(true);
    }
  }, 20_000);
});

describe('the motion budget under prefers-reduced-motion (§14.1, §15)', () => {
  const tokens = readFileSync(join(webSrc, 'theme', 'tokens.css'), 'utf8');

  it('disables every animation and transition, globally, in one rule', () => {
    const reduced = tokens.slice(tokens.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('--duration: 0ms');
    expect(reduced).toContain('animation-duration: 0.01ms !important');
    expect(reduced).toContain('animation-iteration-count: 1 !important');
    expect(reduced).toContain('transition-duration: 0.01ms !important');
    // The selector is the universal one, so a component added later is covered
    // without opting in.
    expect(reduced).toMatch(/\*,\s*\n\s*\*::before,\s*\n\s*\*::after/u);
  });

  it('has exactly the two looping indicators §14.1 budgets for, and both loop', () => {
    const sheets = ['styles.css', 'core-loop.css', 'pages.css', 'collaboration.css'].map((name) =>
      readFileSync(join(webSrc, name), 'utf8'),
    );
    const loops = sheets.flatMap((css) => [
      ...css.matchAll(/animation:\s*([^;]*infinite[^;]*);/gu),
    ]);
    expect(loops).toHaveLength(2);
    // The `working` pulse and the streaming caret — by name, so a third one
    // cannot be added without this failing.
    const names = loops.map((match) => match[1]?.trim().split(/\s+/u)[0]).sort();
    expect(names).toEqual(['caret', 'pulse']);
    // `animation-iteration-count: 1` in the reduce block is what stops both.
    expect(sheets.some((css) => css.includes('@keyframes pulse'))).toBe(true);
    expect(sheets.some((css) => css.includes('@keyframes caret'))).toBe(true);
  });
});
