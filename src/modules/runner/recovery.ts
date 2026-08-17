/**
 * Crash recovery, orphan detection and honest resumability (runner DESIGN §9) —
 * milestone M9.
 *
 * Three things live here, and they are the same subject seen from three sides:
 *
 * 1. {@link Recovery.reconcileOnBoot} — §9.2's boot task, registered through
 *    foundation's `registerBootTask` so it runs after storage is up and **before
 *    any listener binds**. `running → orphaned`, the stale queue sweep, and the
 *    lease release for assignments that are no longer open.
 * 2. {@link Recovery.resumability} — §9.3, which is a list of things that are
 *    *not* resumable and a design that "says so rather than pretending". A
 *    session with no `sdk_session_id`, one whose workspace is gone, and one whose
 *    SDK session file has been deleted are all `resumable: false` with a reason
 *    the UI can render instead of a Continue button that would fail.
 * 3. {@link Recovery.interruption} — the structural detection §9.3 names: "if the
 *    last recorded pair in our transcript is a `tool_use` with no matching
 *    `tool_result`, the resumed session is told so explicitly in its first
 *    message". The SDK cannot tell us this; our own transcript can.
 *
 * ## Why the filesystem is a seam
 *
 * Two of §9.3's three "not resumable" cases are questions about files: the lease
 * path and `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sdk-session-id>.jsonl`.
 * Both are injected as {@link RecoveryFs} so the acceptance test can state
 * "the SDK session file is missing" as a fact rather than by deleting something
 * out of a real Claude config directory.
 *
 * ## The encoded cwd is checked *and* searched
 *
 * SDK-NOTES §10 confirms the layout but not the encoding of `<encoded-cwd>`, and
 * an encoding this file guessed wrong would report every session unresumable —
 * a silent downgrade of the one feature §9 exists for. So the direct path is
 * tried first and a shallow scan of `projects/` is the fallback. Both are cheap:
 * one `stat`, then one `readdir` of a directory with one entry per project the
 * owner has ever run an agent in.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { AssignmentsRepository, Clock } from '../../storage/index.js';

import { emitRunnerEvent } from './events.js';
import type { LogSink } from './launch.js';
import type { RunnerSessionRecord, SessionRepository } from './repository.js';
import { composeSummary } from './summary.js';
import type { TranscriptFactory } from './transcript.js';
import type { TranscriptReader } from './transcriptReader.js';
import type { ExitReason } from './status.js';
import type { EventBus } from '../types.js';

/** The filesystem questions §9.3 asks, injected so a test can answer them. */
export interface RecoveryFs {
  exists(path: string): boolean;
  /** Directory entries, or `[]` when the directory is absent. */
  entries(path: string): readonly string[];
}

export const nodeRecoveryFs: RecoveryFs = {
  exists: (path) => existsSync(path),
  entries(path) {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

/** §9.3's answer, with the reason attached rather than implied. */
export interface Resumability {
  readonly resumable: boolean;
  /** Machine-readable, for the UI's affordance. `undefined` when resumable. */
  readonly code?: 'no_sdk_session' | 'workspace_gone' | 'sdk_session_file_missing' | undefined;
  readonly reason?: string | undefined;
  /** The workspace the session ran in, as its transcript header recorded it. */
  readonly cwd?: string | undefined;
}

/** §9.3's structural detection of the tool call that was in flight. */
export interface Interruption {
  /** The last `tool_use` line with no matching `tool_result`, if there is one. */
  readonly pendingTool?: { readonly toolUseId: string; readonly name: string } | undefined;
  /** The `seq` of the last transcript line, for `session.orphaned`. */
  readonly lastSeq: number;
}

export interface BootReconciliation {
  /** `running` rows from a previous life, now `orphaned` / `core_restart`. */
  readonly orphaned: readonly string[];
  /** Queued rows older than `queueStaleHours`, now `interrupted` / `stale_queue`. */
  readonly stale: readonly string[];
  /** Queued rows carried forward and handed back to the scheduler. */
  readonly requeued: readonly string[];
  /** Lease ids released because their assignment is no longer `open`. */
  readonly leasesReleased: readonly string[];
}

export interface RecoveryDeps {
  readonly sessions: SessionRepository;
  readonly transcripts: TranscriptFactory;
  readonly reader: TranscriptReader;
  readonly assignments: Pick<AssignmentsRepository, 'get'>;
  /** `<dataRoot>/state/claude-config`, foundation §2.3's pinned `CLAUDE_CONFIG_DIR`. */
  readonly claudeConfigDir: string;
  readonly config: {
    readonly queueStaleHours: number;
    readonly transcript: {
      readonly flushLines: number;
      readonly flushMs: number;
      readonly maxMb: number;
    };
  };
  /** §9.2 item 4: projects' `releaseWorkspace`, when projects is on the registry. */
  readonly releaseLease: (leaseId: string) => Promise<unknown>;
  /** Queued rows survive a restart and are re-admitted — the scheduler's pass. */
  readonly admitQueued: () => void;
  readonly bus?: Pick<EventBus, 'emit'> | undefined;
  readonly clock: Clock;
  readonly fs?: RecoveryFs | undefined;
  readonly log?: LogSink | undefined;
}

export interface Recovery {
  reconcileOnBoot(): Promise<BootReconciliation>;
  /** §9.3, for one session. Read-only. */
  resumability(session: RunnerSessionRecord): Resumability;
  /** §9.3's tool-call detection plus the last `seq`. Read-only. */
  interruption(sessionId: string): Interruption;
  /** §9.4 path 2's first user message: what happened, and what was in flight. */
  continuationMessage(session: RunnerSessionRecord, interruption: Interruption): string;
}

/** How a terminal status reads in the continuation message. */
const OUTCOME_PHRASE: Readonly<Record<string, string>> = {
  orphaned: 'was interrupted when AgentManager restarted',
  failed: 'ended with an error',
  interrupted: 'was stopped before it finished',
  done: 'completed',
  paused: 'was paused',
};

export function createRecovery(deps: RecoveryDeps): Recovery {
  const fs = deps.fs ?? nodeRecoveryFs;
  const log: LogSink = deps.log ?? ((): void => {});

  /** The `session.start` header line, which is where the workspace path lives. */
  function header(sessionId: string): Record<string, unknown> | undefined {
    const page = deps.reader.read(sessionId, { limit: 4 });
    if (page.pruned) return undefined;
    for (const line of page.lines) {
      if (line.type === 'session.start') return line;
    }
    return undefined;
  }

  function workspacePathOf(sessionId: string): string | undefined {
    const workspace = header(sessionId)?.['workspace'];
    if (typeof workspace !== 'object' || workspace === null) return undefined;
    const path = (workspace as { path?: unknown }).path;
    return typeof path === 'string' && path !== '' ? path : undefined;
  }

  /**
   * `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sdk-session-id>.jsonl`.
   *
   * The direct path first, a one-level scan second — see the header for why both.
   */
  function sdkSessionFileExists(sdkSessionId: string, cwd: string | undefined): boolean {
    const projects = join(deps.claudeConfigDir, 'projects');
    const file = `${sdkSessionId}.jsonl`;
    if (cwd !== undefined && fs.exists(join(projects, encodeCwd(cwd), file))) return true;
    for (const entry of fs.entries(projects)) {
      if (fs.exists(join(projects, entry, file))) return true;
    }
    return false;
  }

  function resumability(session: RunnerSessionRecord): Resumability {
    const sdkSessionId = session.sdkSessionId;
    if (sdkSessionId === null) {
      return {
        resumable: false,
        code: 'no_sdk_session',
        reason:
          'This session died before the agent reported system/init, so no SDK session id was ever ' +
          'captured and there is no conversation to replay (§9.3). Relaunch it instead.',
      };
    }

    const cwd = workspacePathOf(session.id);
    if (cwd !== undefined && !fs.exists(cwd)) {
      return {
        resumable: false,
        code: 'workspace_gone',
        cwd,
        reason:
          `The workspace this session ran in (${cwd}) no longer exists. SDK session lookup is keyed ` +
          'by the working directory, so the conversation cannot be replayed into it (§9.3).',
      };
    }

    if (!sdkSessionFileExists(sdkSessionId, cwd)) {
      return {
        resumable: false,
        code: 'sdk_session_file_missing',
        ...(cwd === undefined ? {} : { cwd }),
        reason:
          'The SDK stores the conversation as JSONL under CLAUDE_CONFIG_DIR, and this session’s file ' +
          'is not there, so there is nothing to resume from (§9.3).',
      };
    }

    return { resumable: true, ...(cwd === undefined ? {} : { cwd }) };
  }

  function interruption(sessionId: string): Interruption {
    // One bounded read from the end: `seq` is monotonic, and a `tool_result`
    // follows its `tool_use` within a turn, so the tail carries the pair.
    const page = deps.reader.tail(sessionId, { maxBytes: 262_144 });
    let lastSeq = 0;
    const open = new Map<string, string>();
    for (const line of page.lines) {
      if (typeof line.seq === 'number' && line.seq > lastSeq) lastSeq = line.seq;
      if (line.type === 'tool_use') {
        const id = readString(line, 'toolUseId');
        if (id !== undefined) open.set(id, readString(line, 'name') ?? 'a tool');
      } else if (line.type === 'tool_result') {
        const id = readString(line, 'toolUseId');
        if (id !== undefined) open.delete(id);
      }
    }
    const last = [...open.entries()].pop();
    return {
      lastSeq,
      ...(last === undefined ? {} : { pendingTool: { toolUseId: last[0], name: last[1] } }),
    };
  }

  function continuationMessage(session: RunnerSessionRecord, detail: Interruption): string {
    const phrase = OUTCOME_PHRASE[session.status] ?? 'ended';
    const pending = detail.pendingTool;
    const toolClause =
      pending === undefined
        ? ' No tool call was left in flight.'
        : ` A "${pending.name}" call (${pending.toolUseId}) was still running and never returned a ` +
          'result — do not assume it succeeded, and check the working tree before you rely on it.';
    return (
      `The previous session (${session.id}) ${phrase}${
        session.exitReason === null ? '' : ` (${session.exitReason})`
      }. ` +
      'You have the full conversation from it.' +
      toolClause +
      ' Continue from there.'
    );
  }

  /** §9.2 item 1, for one session found `running` from a previous life. */
  function orphan(session: RunnerSessionRecord): void {
    const detail = interruption(session.id);
    const state = resumability(session);
    const summary = composeSummary({
      prompt: deps.sessions.input(session.id)?.prompt ?? '',
      status: 'orphaned',
    });

    if (session.transcriptPath !== null) {
      // Reopened rather than replaced: the file is the record of what the dead
      // process did, and `seq` carries on from its last line (§8.1).
      const transcript = deps.transcripts.open(session.id, {
        flushLines: deps.config.transcript.flushLines,
        flushMs: deps.config.transcript.flushMs,
        maxMb: deps.config.transcript.maxMb,
        at: deps.clock(),
      });
      transcript.append('session.end', {
        status: 'orphaned',
        exitReason: 'core_restart',
        turns: session.turns,
        lastSeq: detail.lastSeq,
        resumable: state.resumable,
        ...(state.code === undefined ? {} : { notResumableCode: state.code }),
        ...(detail.pendingTool === undefined ? {} : { pendingTool: detail.pendingTool }),
        summary,
        message:
          'AgentManager restarted while this session was running, so it was never able to finish. ' +
          'The conversation is preserved; the tool call in flight, if any, is not (§9.3).',
      });
      // `close()` reconciles `transcript_bytes` from `fs.stat` — §8.2's crash
      // half, and the reason the byte count is trustworthy after a hard kill.
      transcript.close();
    } else {
      deps.transcripts.reconcileBytes(session.id);
    }

    const record = deps.sessions.transition(session.id, 'orphaned', {
      exitReason: 'core_restart',
      summary,
      // §2.2: the boot task is the only author of `orphaned`.
      boot: true,
    });

    emitRunnerEvent({
      bus: deps.bus,
      type: 'session.orphaned',
      subject: record,
      payload: {
        lastSeq: detail.lastSeq,
        sdkSessionId: record.sdkSessionId,
        resumable: state.resumable,
        reason: 'core_restart',
        ...(state.code === undefined ? {} : { notResumable: state.code }),
        ...(state.reason === undefined ? {} : { notResumableReason: state.reason }),
        ...(detail.pendingTool === undefined ? {} : { pendingTool: detail.pendingTool }),
        transcriptBytes: record.transcriptBytes,
      },
    });
  }

  /** §9.2 item 2's second half: a queue entry nobody is waiting for any more. */
  function endStale(session: RunnerSessionRecord, exitReason: ExitReason): void {
    const summary = composeSummary({
      prompt: deps.sessions.input(session.id)?.prompt ?? '',
      status: 'interrupted',
    });
    const record = deps.sessions.transition(session.id, 'interrupted', { exitReason, summary });
    emitRunnerEvent({
      bus: deps.bus,
      type: 'session.ended',
      subject: record,
      payload: {
        status: 'interrupted',
        exitReason,
        turns: record.turns,
        permissionDenials: 0,
        summary,
        transcriptBytes: record.transcriptBytes,
        message:
          `This session sat in the queue for more than runner.queueStaleHours ` +
          `(${String(deps.config.queueStaleHours)} h) across a restart and was dropped rather than ` +
          'started. A week-old queue stampeding on boot is its own incident (§9.2).',
      },
    });
  }

  return {
    resumability,
    interruption,
    continuationMessage,

    async reconcileOnBoot(): Promise<BootReconciliation> {
      const orphaned: string[] = [];
      const stale: string[] = [];
      const requeued: string[] = [];
      const leasesReleased: string[] = [];

      // 1. running → orphaned. Anything parked on a question has already been
      //    moved to `paused` by the question reconciler, which runs first — a
      //    session waiting for a human is not a dead one (§9.2 item 3).
      for (const session of deps.sessions.list({ status: 'running' })) {
        try {
          orphan(session);
          orphaned.push(session.id);
        } catch (error) {
          log('error', 'a running session from a previous life could not be orphaned', {
            sessionId: session.id,
            error: describe(error),
          });
        }
      }

      // 2. queued stays queued, unless it is older than queueStaleHours.
      const staleBefore = deps.clock().getTime() - deps.config.queueStaleHours * 3_600_000;
      for (const session of deps.sessions.list({ status: 'queued' })) {
        const queuedAt = session.queuedAt === null ? Number.NaN : Date.parse(session.queuedAt);
        if (Number.isFinite(queuedAt) && queuedAt < staleBefore) {
          endStale(session, 'stale_queue');
          stale.push(session.id);
          continue;
        }
        requeued.push(session.id);
      }

      // 3. paused stays paused. Nothing here — deliberately: "the user may not be
      //    there, and a parked-on-question session already has a resume trigger".

      // 4. Leases for assignments that are no longer `open`. The book is empty in
      //    a fresh process, so the held lease is whatever the rows remember.
      const seen = new Set<string>();
      for (const session of deps.sessions.list()) {
        const leaseId = session.leaseId;
        if (leaseId === null || seen.has(leaseId)) continue;
        seen.add(leaseId);
        if (deps.assignments.get(session.assignmentId)?.status === 'open') continue;
        try {
          await deps.releaseLease(leaseId);
          leasesReleased.push(leaseId);
        } catch (error) {
          // projects' own sweep is the safety net (§9.2 item 4); a lease that
          // will not release is not a reason to fail the boot task.
          log('warn', 'a workspace lease could not be released on boot', {
            leaseId,
            error: describe(error),
          });
        }
      }

      if (requeued.length > 0) deps.admitQueued();

      log('info', 'runner reconciled its sessions after a restart', {
        orphaned: orphaned.length,
        stale: stale.length,
        requeued: requeued.length,
        leasesReleased: leasesReleased.length,
      });

      return { orphaned, stale, requeued, leasesReleased };
    },
  };
}

/**
 * The CLI's `<encoded-cwd>` directory name.
 *
 * Every character that is not a letter or a digit becomes `-`, so
 * `C:\work\repo` becomes `C--work-repo`. Treated as a *hint* rather than a
 * contract — `sdkSessionFileExists` falls back to a scan — because SDK-NOTES
 * confirms the layout without pinning the encoding.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/gu, '-');
}

function readString(line: Record<string, unknown>, key: string): string | undefined {
  const value = line[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
