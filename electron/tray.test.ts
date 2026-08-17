/**
 * The tray menu of §1.5 #3, and the count half of ui IMPLEMENTATION §6's
 * criterion 6 ("the tray label and the taskbar badge match the inbox count").
 *
 * The *matching* is asserted in `shell.test.ts`, where one number drives both.
 * Here it is the wording, which has to be right for a label that is read at a
 * glance and never clicked.
 */
import { describe, expect, it } from 'vitest';

import { questionsLabel, trayMenu, trayTooltip } from './tray.js';

const NOOP = {
  openApp: () => undefined,
  openQuestions: () => undefined,
  stopBackgroundService: () => undefined,
  quit: () => undefined,
};

describe('the questions row', () => {
  it('reads as the neutral label until something has said', () => {
    // The same rule the rail badge follows: a tray claiming "no questions
    // waiting" before the inbox has been read is claiming something unknown.
    expect(questionsLabel(null)).toBe('Questions');
    expect(trayTooltip(null)).toBe('AgentManager');
  });

  it('counts in words, singular and plural', () => {
    expect(questionsLabel(0)).toBe('No questions waiting');
    expect(questionsLabel(1)).toBe('1 question waiting');
    expect(questionsLabel(4)).toBe('4 questions waiting');
    expect(trayTooltip(4)).toBe('AgentManager — 4 questions waiting');
  });

  it('is disabled when there is nothing to open, but still shown', () => {
    expect(trayMenu(0, NOOP).find((row) => row.id === 'questions')?.enabled).toBe(false);
    expect(trayMenu(2, NOOP).find((row) => row.id === 'questions')?.enabled).toBe(true);
  });
});

describe('the four rows of §1.5 #3', () => {
  it('are exactly Open, questions, Stop background service and Quit, in that order', () => {
    expect(trayMenu(3, NOOP).map((row) => row.id)).toEqual([
      'open',
      'questions',
      'stop-core',
      'quit',
    ]);
  });

  it('keeps stopping the core and quitting the app distinct and separately labelled', () => {
    // foundation §4.1: closing or quitting never stops the core. Two rows, two
    // labels, and the destructive one is not the one under the thumb.
    const menu = trayMenu(1, NOOP);
    expect(menu.find((row) => row.id === 'stop-core')?.label).toBe('Stop background service');
    expect(menu.find((row) => row.id === 'quit')?.label).toBe('Quit');
  });

  it('wires each row to its own action', () => {
    const called: string[] = [];
    const menu = trayMenu(1, {
      openApp: () => called.push('open'),
      openQuestions: () => called.push('questions'),
      stopBackgroundService: () => called.push('stop'),
      quit: () => called.push('quit'),
    });
    for (const row of menu) row.click?.();
    expect(called).toEqual(['open', 'questions', 'stop', 'quit']);
  });
});
