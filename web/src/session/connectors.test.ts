/**
 * The mid-run connector card (ui §9.2, roster §10, WO6 item 3).
 *
 * One row per server rather than one per event is the whole design, so the
 * assertions are about *folding*: two facts about the same connector must not
 * become two cards, and a later status line must not lose the authorisation
 * link an earlier one raised.
 */
import { describe, expect, it } from 'vitest';

import type { EventFrame } from '../api/types';

import {
  applyConnectorDiagnostic,
  openConnectorNotices,
  NO_CONNECTOR_NOTICES,
  type ConnectorNotices,
} from './connectors';

function frame(payload: Record<string, unknown>): EventFrame {
  return {
    type: 'session.diagnostic',
    ts: '2026-08-19T10:00:00.000Z',
    ids: { sessionId: 's1' },
    persist: true,
    payload,
  };
}

function fold(...payloads: readonly Record<string, unknown>[]): ConnectorNotices {
  return payloads.reduce<ConnectorNotices>(
    (current, payload) => applyConnectorDiagnostic(current, frame(payload)),
    NO_CONNECTOR_NOTICES,
  );
}

describe('folding the diagnostics of one server', () => {
  it('turns needs-auth plus an authorize URL into one row with an action', () => {
    const notices = fold(
      {
        code: 'mcp_needs_auth',
        server: 'todo',
        message: 'The MCP server "todo" needs authorising…',
        relaunchRequired: false,
      },
      {
        code: 'mcp_authorize_url',
        server: 'todo',
        message: 'Open the authorisation link…',
        authorizeUrl: 'https://todo.example/authorize?state=abc',
      },
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      server: 'todo',
      state: 'needs-auth',
      authorizeUrl: 'https://todo.example/authorize?state=abc',
    });
  });

  it('keeps the link when a later needs-auth line arrives for the same server', () => {
    const notices = fold(
      { code: 'mcp_authorize_url', server: 'todo', message: 'x', authorizeUrl: 'https://a/b' },
      { code: 'mcp_needs_auth', server: 'todo', message: 'still needs auth' },
    );
    expect(notices[0]?.authorizeUrl).toBe('https://a/b');
  });

  it('goes quiet once the grant lands', () => {
    const notices = fold(
      { code: 'mcp_needs_auth', server: 'todo', message: 'needs auth' },
      { code: 'mcp_authorized', server: 'todo', message: 'authorised; reconnecting' },
    );
    expect(notices[0]?.state).toBe('authorized');
    expect(openConnectorNotices(notices)).toEqual([]);
  });

  it('says relaunch plainly when reconnection is not available or failed', () => {
    for (const code of ['mcp_reconnect_unavailable', 'mcp_reconnect_failed']) {
      const notices = fold(
        { code: 'mcp_needs_auth', server: 'todo', message: 'needs auth' },
        {
          code,
          server: 'todo',
          message: 'Relaunch the turn to pick it up.',
          relaunchRequired: true,
        },
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ state: 'relaunch-required', relaunchRequired: true });
      expect(openConnectorNotices(notices)).toHaveLength(1);
    }
  });

  it('carries runner’s relaunchRequired through from the needs-auth card', () => {
    const notices = fold({
      code: 'mcp_needs_auth',
      server: 'todo',
      message: 'authorise it and relaunch the turn',
      relaunchRequired: true,
    });
    expect(notices[0]?.relaunchRequired).toBe(true);
  });
});

describe('what it ignores', () => {
  it('ignores a diagnostic with no server, and a code it does not know', () => {
    expect(fold({ code: 'mcp_needs_auth', message: 'no server named' })).toEqual([]);
    expect(fold({ code: 'plugins_not_loaded', server: 'todo', message: 'x' })).toEqual([]);
    expect(fold({ code: 'mcp_authorize_url', server: 'todo', message: 'x' })).toEqual([]);
  });

  it('keeps one row per server and not one per event', () => {
    const notices = fold(
      { code: 'mcp_needs_auth', server: 'todo', message: 'a' },
      { code: 'mcp_failed', server: 'gmail', message: 'b' },
      { code: 'mcp_needs_auth', server: 'todo', message: 'c' },
    );
    expect(notices.map((notice) => notice.server)).toEqual(['todo', 'gmail']);
    expect(notices[0]?.message).toBe('c');
  });
});
