/**
 * Desktop toasts and the taskbar badge (DESIGN §1.5 #6, §2.2).
 *
 * > "Desktop toast notifications when a question is raised and the window is not
 * > focused — this is the job orchestrator §10 explicitly assigns to the Electron
 * > shell. Clicking the toast focuses the window on that question."
 *
 * The split of responsibility is deliberate and is the only reason this file is
 * in the renderer at all: **the page knows *whether* to ask** — it is the side
 * that holds the event feed and that can see whether the window has focus — and
 * **the shell owns the toast and what clicking it does**. Neither half can do the
 * other's job, and neither needs to know the other's mode: in a browser
 * `bridge.notify` is simply absent and nothing happens, which is correct (there
 * is no browser push in v1, §11.4, and the UI must not imply otherwise).
 *
 * The badge is pushed on every change rather than polled, so the tray label, the
 * taskbar badge and the rail badge are the same number by construction.
 */

import { useEffect } from 'react';

import type { EventStream } from '../events/EventStream';
import { useAppStore } from '../state/store';

import type { DesktopBridge } from './bridge';

/** The event that wakes the desktop, and the only one (orchestrator §10). */
export const QUESTION_RAISED = 'assignment.question.raised';

export interface RaisedQuestion {
  readonly questionId: string;
  readonly prompt: string;
  readonly kind: string;
}

/** Reads the raised-question payload; `undefined` when it is not one. */
export function raisedQuestionOf(payload: unknown): RaisedQuestion | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const questionId = record['questionId'];
  if (typeof questionId !== 'string' || questionId === '') return undefined;
  return {
    questionId,
    prompt: typeof record['prompt'] === 'string' ? record['prompt'] : '',
    kind: typeof record['kind'] === 'string' ? record['kind'] : 'question',
  };
}

/**
 * The toast's words.
 *
 * The prompt goes in the body because on the desktop it *is* deliverable — this
 * is a local OS notification, not the ntfy push of §11.4, whose payload is
 * deliberately a generic wake-up. The two must not be confused, and the place
 * that would confuse them is here.
 */
export function toastFor(question: RaisedQuestion): { title: string; body: string; route: string } {
  const title =
    question.kind === 'approval_gate'
      ? 'AgentManager needs your approval'
      : question.kind === 'budget_halt'
        ? 'An assignment hit its budget'
        : 'An agent is asking';
  return {
    title,
    body: question.prompt === '' ? 'Open the inbox to answer.' : question.prompt,
    route: `/questions/${encodeURIComponent(question.questionId)}`,
  };
}

export interface DesktopBridgeOptions {
  /** Defaults to the document's own focus state; injected so a test can say. */
  readonly hasFocus?: () => boolean;
}

export function useDesktopBridge(
  bridge: DesktopBridge,
  events: EventStream,
  options: DesktopBridgeOptions = {},
): void {
  const openQuestions = useAppStore((store) => store.openQuestions);
  const hasFocus = options.hasFocus;

  useEffect(() => {
    const notify = bridge.notify;
    if (notify === undefined) return undefined;
    const focused = hasFocus ?? ((): boolean => document.hasFocus());

    return events.on((frame) => {
      if (frame.type !== QUESTION_RAISED) return;
      // "…and the window is not focused". A toast for something already on
      // screen is noise, and noise is how notifications get turned off.
      if (focused()) return;
      const question = raisedQuestionOf(frame.payload);
      if (question === undefined) return;
      void notify(toastFor(question));
    });
  }, [bridge, events, hasFocus]);

  useEffect(() => {
    const setBadge = bridge.setBadge;
    // `null` means nothing has said yet — the same rule the rail badge follows.
    // Pushing a `0` for "unknown" would make the tray claim there is nothing
    // waiting before the app has looked.
    if (setBadge === undefined || openQuestions === null) return;
    void setBadge(openQuestions);
  }, [bridge, openQuestions]);
}
