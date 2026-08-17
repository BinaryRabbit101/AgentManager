/**
 * The mailbox and its delivery semantics (DESIGN §5; the M4-1/M4-7 slice M5 and
 * M6 require — see `messages.ts`'s header).
 *
 * §5.1's table is the specification and is asserted row by row, because the
 * honesty of the model is the feature: "'I sent it and they ignored me' and 'I
 * sent it and they never saw it' are different failures and only one of them is
 * the agent's fault".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Storage } from '../../storage/index.js';

import { createMailboxRepository, MAX_BODY_BYTES, type MailboxRepository } from './messages.js';
import { InvalidRequestError } from './errors.js';
import { makeTempDir, openTestStorage, type TempDir } from './__tests__/helpers.js';

let dir: TempDir;
let storage: Storage;
let mailbox: MailboxRepository;
let assignmentId: string;
let otherAssignmentId: string;
let tick = 0;

beforeEach(() => {
  dir = makeTempDir('agentmanager-orchestrator-mail-');
  storage = openTestStorage(dir.path);
  const project = storage.store.projects.create({ slug: 'p', name: 'P' });
  assignmentId = storage.store.assignments.create({ projectId: project.id, pattern: 'pair' }).id;
  otherAssignmentId = storage.store.assignments.create({
    projectId: project.id,
    pattern: 'pair',
  }).id;
  tick = 0;
  mailbox = createMailboxRepository({
    db: storage.db,
    messages: storage.store.messages,
    // Distinct timestamps, so "oldest first" is a real ordering rather than a
    // tie broken by insertion luck.
    clock: () => {
      tick += 1;
      return new Date(Date.UTC(2026, 7, 16, 10, 0, tick));
    },
  });
});

afterEach(() => {
  storage.close();
  dir.cleanup();
});

describe('sending', () => {
  it('writes a direct message and reports it undelivered until someone sees it', () => {
    const sent = mailbox.send({
      assignmentId,
      fromAgentId: 'ada',
      toAgentId: 'sam',
      kind: 'handoff',
      body: 'Draft is at docs/x/DESIGN.md.',
    });
    expect(sent).toMatchObject({ toAgentId: 'sam', kind: 'handoff', delivery: 'undelivered' });
    expect(mailbox.unreadCount('sam', assignmentId)).toBe(1);
    // The sender's own post is never in the sender's mailbox.
    expect(mailbox.unreadCount('ada', assignmentId)).toBe(0);
  });

  it('refuses a message with no recipient and no broadcast flag', () => {
    expect(() =>
      mailbox.send({ assignmentId, fromAgentId: 'ada', kind: 'note', body: 'hi' }),
    ).toThrow(InvalidRequestError);
  });

  it('refuses an oversized body rather than truncating it', () => {
    expect(() =>
      mailbox.send({
        assignmentId,
        fromAgentId: 'ada',
        toAgentId: 'sam',
        kind: 'note',
        body: 'x'.repeat(MAX_BODY_BYTES + 1),
      }),
    ).toThrow(/limited to/u);
  });

  it('refuses a kind outside §5’s vocabulary', () => {
    expect(() =>
      mailbox.send({
        assignmentId,
        fromAgentId: 'ada',
        toAgentId: 'sam',
        kind: 'gossip' as 'note',
        body: 'hi',
      }),
    ).toThrow(/kind/u);
  });
});

describe('scoping', () => {
  it('never returns a message from another assignment', () => {
    mailbox.send({
      assignmentId,
      fromAgentId: 'ada',
      toAgentId: 'sam',
      kind: 'note',
      body: 'mine',
    });
    mailbox.send({
      assignmentId: otherAssignmentId,
      fromAgentId: 'ada',
      toAgentId: 'sam',
      kind: 'note',
      body: 'someone else’s',
    });
    const mine = mailbox.mailbox('sam', { assignmentId });
    expect(mine.map((message) => message.body)).toEqual(['mine']);
  });

  it('gives a broadcast to every co-member except its sender', () => {
    mailbox.send({
      assignmentId,
      fromAgentId: 'ada',
      broadcast: true,
      kind: 'status',
      body: 'starting round 2',
    });
    expect(mailbox.mailbox('sam', { assignmentId })).toHaveLength(1);
    expect(mailbox.mailbox('kim', { assignmentId })).toHaveLength(1);
    expect(mailbox.mailbox('ada', { assignmentId })).toHaveLength(0);
  });
});

describe('read state (§5.1, §2.1)', () => {
  it('marks a direct message read on the row itself', () => {
    const sent = mailbox.send({
      assignmentId,
      fromAgentId: 'ada',
      toAgentId: 'sam',
      kind: 'note',
      body: 'hi',
    });
    mailbox.markRead(sent.id, 'sam');
    expect(mailbox.mailbox('sam', { assignmentId })).toHaveLength(0);
    expect(
      mailbox.listByAssignment(assignmentId).find((message) => message.id === sent.id),
    ).toMatchObject({ delivery: 'read' });
  });

  it('keeps broadcast read state per recipient, because it has no sole recipient', () => {
    const sent = mailbox.send({
      assignmentId,
      fromAgentId: 'ada',
      broadcast: true,
      kind: 'status',
      body: 'ping',
    });
    mailbox.markRead(sent.id, 'sam');
    // Sam has read it; Kim has not, and the row's own `read_at` is still null.
    expect(mailbox.mailbox('sam', { assignmentId })).toHaveLength(0);
    expect(mailbox.mailbox('kim', { assignmentId })).toHaveLength(1);
    expect(storage.store.messages.get(sent.id)?.readAt).toBeNull();
    expect(
      storage.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM message_reads WHERE message_id = ?',
        )
        .get(sent.id)?.n,
    ).toBe(1);
  });
});

describe('prompt-time inlining (§3.2 section 4, §5.1)', () => {
  function fill(count: number): void {
    for (let index = 0; index < count; index += 1) {
      mailbox.send({
        assignmentId,
        fromAgentId: 'ada',
        toAgentId: 'sam',
        kind: 'note',
        body: `message ${String(index)}`,
      });
    }
  }

  it('inlines up to inlineMax, oldest first, and counts the rest honestly', () => {
    fill(12);
    const inlined = mailbox.inlineFor('sam', assignmentId, {
      inlineMax: 10,
      inlineMaxBytes: 8192,
    });
    expect(inlined.messages).toHaveLength(10);
    expect(inlined.messages[0]?.body).toBe('message 0');
    expect(inlined.remaining).toBe(2);
  });

  it('stops at the byte budget as well as the count', () => {
    fill(5);
    const inlined = mailbox.inlineFor('sam', assignmentId, { inlineMax: 10, inlineMaxBytes: 20 });
    expect(inlined.messages.length).toBeLessThan(5);
    expect(inlined.remaining).toBe(5 - inlined.messages.length);
  });

  it('still inlines one message that alone exceeds the byte budget', () => {
    mailbox.send({
      assignmentId,
      fromAgentId: 'ada',
      toAgentId: 'sam',
      kind: 'note',
      body: 'x'.repeat(4000),
    });
    const inlined = mailbox.inlineFor('sam', assignmentId, { inlineMax: 10, inlineMaxBytes: 100 });
    expect(inlined.messages).toHaveLength(1);
    expect(inlined.remaining).toBe(0);
  });

  it('marks what it inlined delivered but not read — the agent has not answered it', () => {
    fill(1);
    const inlined = mailbox.inlineFor('sam', assignmentId, { inlineMax: 10, inlineMaxBytes: 8192 });
    const id = inlined.messages[0]?.id ?? '';
    expect(storage.store.messages.get(id)?.deliveredAt).not.toBeNull();
    expect(storage.store.messages.get(id)?.readAt).toBeNull();
    expect(
      mailbox.listByAssignment(assignmentId).find((message) => message.id === id)?.delivery,
    ).toBe('inlined');
    // Still unread, so a second launch would inline it again rather than losing it.
    expect(mailbox.unreadCount('sam', assignmentId)).toBe(1);
  });
});
