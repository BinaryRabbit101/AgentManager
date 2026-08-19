/**
 * The mid-run connector card (ui DESIGN §9.2; roster §10; WO6 item 3).
 *
 * Runner emits five `session.diagnostic` codes about MCP servers, and the shape
 * they make on screen is *one row per server* rather than one row per event:
 * a connector that reports `needs-auth` at init and then raises an
 * authorisation link a minute later is one problem with two facts about it, and
 * rendering two cards would make the user wonder which to act on.
 *
 * So this reduces the stream to a map keyed by server name, and each incoming
 * diagnostic **refines** the row rather than replacing it:
 *
 * | code | what it adds |
 * |---|---|
 * | `mcp_needs_auth` | the row exists, and whether a relaunch will be needed |
 * | `mcp_authorize_url` | the link — this is the **Authenticate…** action |
 * | `mcp_authorized` | the grant landed; the row goes quiet |
 * | `mcp_reconnect_failed` / `mcp_reconnect_unavailable` | authorised, but this turn must be relaunched |
 * | `mcp_failed` | the server did not start at all; there is nothing to authorise |
 *
 * Pure, and separate from the block list, for the reason the header comment in
 * `SessionView.tsx` gives: these diagnostics carry no `seq`, so `applyEvent`
 * would drop them — and an action that scrolls away with the transcript is not
 * an action.
 */

import type { EventFrame } from '../api/types';

export type ConnectorNoticeState = 'needs-auth' | 'failed' | 'authorized' | 'relaunch-required';

export interface ConnectorNotice {
  readonly server: string;
  readonly state: ConnectorNoticeState;
  readonly message: string;
  /** The page the human opens. Present once the server has raised it. */
  readonly authorizeUrl?: string;
  /** True when completing the grant will not help this turn (runner said so). */
  readonly relaunchRequired: boolean;
}

/** Server name → its current row, in arrival order. */
export type ConnectorNotices = readonly ConnectorNotice[];

export const NO_CONNECTOR_NOTICES: ConnectorNotices = [];

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function upsert(
  current: ConnectorNotices,
  server: string,
  next: (previous: ConnectorNotice | undefined) => ConnectorNotice,
): ConnectorNotices {
  const index = current.findIndex((notice) => notice.server === server);
  if (index === -1) return [...current, next(undefined)];
  const updated = [...current];
  updated[index] = next(current[index]);
  return updated;
}

/**
 * Fold one `session.diagnostic` frame in. Frames about anything else are
 * ignored, which is most of them.
 */
export function applyConnectorDiagnostic(
  current: ConnectorNotices,
  frame: EventFrame,
): ConnectorNotices {
  const payload = frame.payload as Record<string, unknown> | undefined;
  const code = str(payload?.['code']);
  const server = str(payload?.['server']);
  if (code === undefined || server === undefined) return current;
  const message = str(payload?.['message']) ?? '';
  const relaunch = payload?.['relaunchRequired'] === true;

  switch (code) {
    case 'mcp_needs_auth':
      return upsert(current, server, (previous) => ({
        server,
        state: 'needs-auth',
        message,
        relaunchRequired: relaunch,
        // A link raised earlier is not lost by a later status line.
        ...(previous?.authorizeUrl === undefined ? {} : { authorizeUrl: previous.authorizeUrl }),
      }));

    case 'mcp_authorize_url': {
      const url = str(payload?.['authorizeUrl']);
      if (url === undefined) return current;
      return upsert(current, server, (previous) => ({
        server,
        // The link is the actionable state, so it outranks a plain `needs-auth`
        // — but never demotes a row that already succeeded.
        state: previous?.state === 'authorized' ? 'authorized' : 'needs-auth',
        message,
        authorizeUrl: url,
        relaunchRequired: previous?.relaunchRequired ?? false,
      }));
    }

    case 'mcp_authorized':
      return upsert(current, server, (previous) => ({
        server,
        state: 'authorized',
        message,
        relaunchRequired: previous?.relaunchRequired ?? false,
      }));

    case 'mcp_reconnect_failed':
    case 'mcp_reconnect_unavailable':
      // The honest half of WO6 item 3: the grant is done and this turn still
      // cannot use it. Saying that plainly is the whole requirement.
      return upsert(current, server, () => ({
        server,
        state: 'relaunch-required',
        message,
        relaunchRequired: true,
      }));

    case 'mcp_failed':
      return upsert(current, server, () => ({
        server,
        state: 'failed',
        message,
        relaunchRequired: false,
      }));

    default:
      return current;
  }
}

/** Rows worth showing: an authorised connector needs no card once it is working. */
export function openConnectorNotices(notices: ConnectorNotices): ConnectorNotices {
  return notices.filter((notice) => notice.state !== 'authorized');
}
