/**
 * Remote MCP authorisation (WO6 item 3) and the launch-time connector note
 * (item 4's second bullet).
 *
 * Everything here is exercised against plain data, for `initMessage.ts`'s
 * reason: this is the part of the OAuth path that can be proven without a token
 * and without a live authorization server, and a helper that could only be
 * tested against one would be the piece of the flow with no test at all.
 */
import { describe, expect, it, vi } from 'vitest';

import { createMcpAuthCoordinator, mcpLaunchContextNote, type McpAuthEvent } from './mcpAuth.js';

function harness(): {
  events: McpAuthEvent[];
  abort: AbortController;
  authorized: string[];
  coordinator: ReturnType<typeof createMcpAuthCoordinator>;
} {
  const events: McpAuthEvent[] = [];
  const authorized: string[] = [];
  const abort = new AbortController();
  const coordinator = createMcpAuthCoordinator({
    signal: abort.signal,
    emit: (event) => events.push(event),
    onAuthorized: (server) => authorized.push(server),
  });
  return { events, abort, authorized, coordinator };
}

function complete(server: string, id?: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'elicitation_complete',
    mcp_server_name: server,
    ...(id === undefined ? {} : { elicitation_id: id }),
  };
}

describe('a url-mode elicitation (sdk.d.ts:582, :1568)', () => {
  it('raises the authorisation link and waits for the server to confirm the grant', async () => {
    const { events, authorized, coordinator } = harness();

    const answer = coordinator.onElicitation({
      serverName: 'todo',
      message: 'Authorise AgentManager',
      mode: 'url',
      url: 'https://todo.example/authorize?state=abc',
      elicitationId: 'elicit-1',
    });

    // The link is out immediately — the user cannot act on a promise.
    expect(events).toEqual([
      expect.objectContaining({
        code: 'mcp_authorize_url',
        server: 'todo',
        url: 'https://todo.example/authorize?state=abc',
      }),
    ]);
    expect(coordinator.pendingServers()).toEqual([
      { server: 'todo', url: 'https://todo.example/authorize?state=abc' },
    ]);

    // Accepting before the human has opened the page would tell the MCP server
    // the grant existed, so nothing settles until `elicitation_complete`.
    let settled = false;
    void answer.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(coordinator.noteMessage(complete('todo', 'elicit-1'))).toBe(true);
    await expect(answer).resolves.toEqual({ action: 'accept' });
    expect(authorized).toEqual(['todo']);
    expect(events.at(-1)?.code).toBe('mcp_authorized');
    expect(coordinator.pendingServers()).toEqual([]);
  });

  it('correlates on the server name when the build sends no elicitation id', async () => {
    const { coordinator } = harness();
    const answer = coordinator.onElicitation({
      serverName: 'calendar',
      message: 'Authorise',
      mode: 'url',
      url: 'https://cal.example/authorize',
    });
    expect(coordinator.noteMessage(complete('calendar'))).toBe(true);
    await expect(answer).resolves.toEqual({ action: 'accept' });
  });

  it('cancels every waiter when the session aborts, rather than leaving it pending', async () => {
    const { abort, coordinator } = harness();
    const answer = coordinator.onElicitation({
      serverName: 'todo',
      message: 'Authorise',
      mode: 'url',
      url: 'https://todo.example/authorize',
    });
    abort.abort();
    // `OnElicitation`'s contract (sdk.d.ts:1305): an unsettled elicitation stays
    // open until the server times it out, which is a hang nobody can see.
    await expect(answer).resolves.toEqual({ action: 'cancel' });
  });

  it('ignores an unrelated system message', () => {
    const { coordinator } = harness();
    expect(coordinator.noteMessage({ type: 'system', subtype: 'init' })).toBe(false);
    expect(coordinator.noteMessage(undefined)).toBe(false);
  });
});

describe('a form-mode elicitation', () => {
  it('is declined out loud, because a silent decline looks like a broken connector', async () => {
    const { events, coordinator } = harness();
    await expect(
      coordinator.onElicitation({
        serverName: 'todo',
        message: 'What is your workspace id?',
        mode: 'form',
      }),
    ).resolves.toEqual({ action: 'decline' });
    expect(events).toEqual([
      expect.objectContaining({ code: 'mcp_elicitation_declined', server: 'todo' }),
    ]);
    expect(events[0]?.message).toContain('blocked');
  });
});

describe('the launch-time connector note (WO6 item 4)', () => {
  it('is absent when every declared server connected', () => {
    expect(
      mcpLaunchContextNote([
        { name: 'todo', status: 'connected' },
        { name: 'gmail', status: 'connected' },
      ]),
    ).toBeUndefined();
  });

  it('names each down server, its tool prefix, and the sanctioned next move', () => {
    const note = mcpLaunchContextNote([
      { name: 'todo', status: 'needs-auth' },
      { name: 'gmail', status: 'failed' },
      { name: 'fs', status: 'connected' },
    ]);
    expect(note).toBeDefined();
    expect(note).toContain('<system-reminder>');
    expect(note).toContain('todo (mcp__todo__*)');
    expect(note).toContain('not authorised');
    expect(note).toContain('gmail (mcp__gmail__*)');
    expect(note).toContain('failed to start');
    expect(note).not.toContain('fs (mcp__fs__*)');
    // The anti-scavenging half, restated where the agent will read it first.
    expect(note).toContain('report_status');
    expect(note).toContain('Do not search the filesystem');
  });
});

describe('the coordinator never throws out of the SDK callback', () => {
  it('answers a url elicitation raised after the session aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const coordinator = createMcpAuthCoordinator({ signal: abort.signal, emit: vi.fn() });
    await expect(
      coordinator.onElicitation({
        serverName: 'todo',
        message: 'Authorise',
        mode: 'url',
        url: 'https://todo.example/authorize',
      }),
    ).resolves.toEqual({ action: 'cancel' });
  });
});
