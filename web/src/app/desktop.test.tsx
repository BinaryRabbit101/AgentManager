/**
 * The renderer's half of the Electron shell (ui IMPLEMENTATION §6).
 *
 * Two criteria live here because only the page can satisfy them:
 *
 * - **"A question raised while the window is unfocused produces a toast"** — the
 *   page is the side that holds the event feed and that can see whether the
 *   window has focus. The shell owns the toast itself and what clicking it does
 *   (`electron/shell.test.ts`).
 * - **"The tray label and the taskbar badge match the inbox count"** — one
 *   number, pushed from here, drawn in both places by the shell.
 *
 * The third thing asserted here is the M5 degrade this milestone closes: the
 * badge count is `GET /api/orchestrator/status`'s `questions.open`, not a tally
 * of frames since boot. The difference shows on a **cold load** with questions
 * already open, which is the case counting could never get right.
 */

import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../App';
import { json, mount, type Responder } from '../../test/harness';
import { useAppStore } from '../state/store';

import type { DesktopBridge, DesktopNotification } from './bridge';

afterEach(() => useAppStore.getState().reset());

function serving(openQuestions: number): Responder {
  return (url) => {
    const path = url.split('?')[0] ?? url;
    if (path === '/api/orchestrator/status') {
      return json({
        agents: [],
        assignments: { open: 0, halted: 0, awaitingUser: 0 },
        questions: { open: openQuestions, oldestOpenedAt: null },
      });
    }
    if (path === '/api/roster/agents') return json({ agents: [], diagnostics: [] });
    if (path === '/api/projects') return json({ projects: [] });
    if (path === '/api/questions') return json({ questions: [] });
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
}

interface Recording extends DesktopBridge {
  readonly notified: DesktopNotification[];
  readonly badges: number[];
}

function recordingBridge(): Recording {
  const notified: DesktopNotification[] = [];
  const badges: number[] = [];
  return {
    isElectron: true,
    notified,
    badges,
    notify: (request) => {
      notified.push(request);
      return Promise.resolve(true);
    },
    setBadge: (count) => {
      badges.push(count);
      return Promise.resolve(true);
    },
  };
}

describe('the badge is read from the server, not counted from zero (M5’s degrade, closed)', () => {
  it('shows the open count on a cold load, before any event has arrived', async () => {
    mount(<App />, { respond: serving(3) });

    // Counting `assignment.question.raised` frames since boot would read zero
    // here, which is the case that made the degrade a degrade.
    const badge = await screen.findByText('3');
    expect(badge).toHaveAttribute('data-badge', 'questions');
  });

  it('pushes that same number to the shell for the tray and the taskbar', async () => {
    const bridge = recordingBridge();
    mount(<App />, { respond: serving(3), bridge });

    await waitFor(() => expect(bridge.badges).toContain(3));
  });

  it('says nothing to the shell until something has said', async () => {
    // `null` means unknown. A `0` pushed for "unknown" would make the tray claim
    // there is nothing waiting before the app has looked.
    const bridge = recordingBridge();
    mount(<App />, {
      respond: () => json({ error: 'boom', message: 'the core is unwell' }, 500),
      bridge,
    });

    await new Promise((settle) => setTimeout(settle, 20));
    expect(bridge.badges).toEqual([]);
  });

  it('bumps live, ahead of the refetch, when a card is raised', async () => {
    // §11.1 wants the badge inside a second; a refetch round-trip is not that.
    const bridge = recordingBridge();
    const mounted = mount(<App />, { respond: serving(1), bridge });
    await screen.findByText('1');

    mounted.stream.emit({
      id: 'e1',
      type: 'assignment.question.raised',
      ids: { assignmentId: 'as1' },
      payload: { questionId: 'q1', prompt: 'DB or disk?', kind: 'question' },
    });

    await waitFor(() => expect(bridge.badges).toContain(2));
  });
});

describe('desktop toasts (§1.5 #6)', () => {
  const raised = {
    id: 'e1',
    type: 'assignment.question.raised' as const,
    ids: { assignmentId: 'as1' },
    payload: {
      questionId: 'q-42',
      prompt: 'Store transcripts in the DB or on disk?',
      kind: 'question',
    },
  };

  it('asks the shell for a toast when the window is unfocused, with the card’s deep link', async () => {
    const bridge = recordingBridge();
    // jsdom reports the document as focused; the shell only ever sees the
    // renderer's answer, so this is the seam the design's "and the window is not
    // focused" clause lives on.
    const mounted = mount(<App />, { respond: serving(0), bridge });
    document.hasFocus = () => false;

    mounted.stream.emit(raised);

    await waitFor(() => expect(bridge.notified).toHaveLength(1));
    expect(bridge.notified[0]).toEqual({
      title: 'An agent is asking',
      body: 'Store transcripts in the DB or on disk?',
      route: '/questions/q-42',
    });
  });

  it('stays quiet when the window is focused', async () => {
    const bridge = recordingBridge();
    const mounted = mount(<App />, { respond: serving(0), bridge });
    document.hasFocus = () => true;

    mounted.stream.emit(raised);

    await new Promise((settle) => setTimeout(settle, 20));
    // A toast for something already on screen is noise, and noise is how
    // notifications get turned off.
    expect(bridge.notified).toEqual([]);
  });

  it('does nothing at all in a browser, where there is no bridge', () => {
    // There is no browser push in v1 (§11.4) and the UI must not imply there is.
    const mounted = mount(<App />, { respond: serving(0) });
    document.hasFocus = () => false;
    expect(() => mounted.stream.emit(raised)).not.toThrow();
  });
});
