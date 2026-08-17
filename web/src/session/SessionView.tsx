/**
 * The session view (DESIGN §9) — watch, steer, and stop.
 *
 * The open sequence is §9.4's, in order and for its stated reasons:
 *
 * 1. `GET /api/sessions/:id` → the record, its usage rollup, its queue position.
 * 2. `GET /api/sessions/:id/transcript?tail=<bytes>` → the last whole lines plus
 *    `from` / `next`. One request regardless of transcript size, which is what
 *    `tail` exists for; **Load earlier** then walks backwards with `?from=`.
 * 3. If the session is live, open the per-session feed and merge on `seq`.
 *
 * Steps 2 and 3 overlap rather than race, because `seq` is the join key and
 * `blocks.ts` collapses duplicates by it. That is also the whole of the reconnect
 * story: on a drop the client keeps its byte offset, and on reopen it re-tails
 * `?from=<offset>` instead of refetching — "a tailnet drop must not cost the user
 * their place and must not trigger a full refetch" (§3.3).
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';

import { queryKeys, useRoster, useSession } from '../api/queries';
import { failureOf, type ApiFailure } from '../api/result';
import type {
  EventFrame,
  SessionControlResult,
  SessionUsageTotals,
  TranscriptPage,
} from '../api/types';
import { useServices } from '../app/AppContext';
import { Avatar } from '../board/Avatar';
import { Icon } from '../icons/Sprite';
import { useAppStore } from '../state/store';

import {
  applyAnswered,
  applyEvent,
  applyPage,
  BLOCK_CAP,
  EMPTY_TRANSCRIPT,
  type StartBlock,
  type TranscriptState,
} from './blocks';
import { CONTROL_PATHS, controlStates, isAwaitingAnswer } from './controls';
import { SessionBlock } from './SessionBlock';
import { SessionStream } from './sessionStream';
import { UsageRail } from './UsageRail';

/** §9.4: one request on open, whatever the transcript's size. */
export const OPEN_TAIL_BYTES = 64 * 1024;
/** How far **Load earlier** walks back each press. */
export const EARLIER_CHUNK_BYTES = 64 * 1024;

export function SessionView(): ReactElement {
  const { id = '' } = useParams();
  const { client, events, sessionTransport } = useServices();
  const queryClient = useQueryClient();
  const detail = useSession(client, id);
  const roster = useRoster(client);
  const pushToast = useAppStore((store) => store.pushToast);

  const [transcript, setTranscript] = useState<TranscriptState>(EMPTY_TRANSCRIPT);
  const [liveUsage, setLiveUsage] = useState<SessionUsageTotals | null>(null);
  const [steerText, setSteerText] = useState('');
  const [interrupt, setInterrupt] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | undefined>();
  const [controlState, setControlState] = useState<SessionControlResult | undefined>();
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const session = detail.data?.session;
  const status = controlState?.status ?? session?.status;
  const exitReason = controlState?.exitReason ?? session?.exitReason ?? null;

  /** The byte offset the live stream resumes from — §9.4's contract. */
  const nextOffset = useRef(0);
  nextOffset.current = transcript.next;

  const readPage = useCallback(
    async (query: Record<string, string>): Promise<TranscriptPage | undefined> => {
      const result = await client.request<TranscriptPage>(
        `/sessions/${encodeURIComponent(id)}/transcript`,
        { query },
      );
      if (result.kind !== 'ok') {
        setFailure(result);
        return undefined;
      }
      return result.value;
    },
    [client, id],
  );

  // Step 2, on open: `?tail=`. One request.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const page = await readPage({ tail: String(OPEN_TAIL_BYTES) });
      if (page === undefined || cancelled) return;
      setTranscript((current) => applyPage(current, page));
    })();
    return () => {
      cancelled = true;
    };
  }, [readPage]);

  // Step 3: the per-session feed, open only while this view is (§3.3).
  useEffect(() => {
    if (id === '') return undefined;
    let opened = 0;
    const stream = new SessionStream({
      client,
      sessionId: id,
      ...(sessionTransport === undefined ? {} : { transport: sessionTransport }),
      onFrame: (frame: EventFrame) => {
        if (frame.type === 'session.question.answered') {
          setTranscript((current) => applyAnswered(current, frame));
          return;
        }
        if (frame.type === 'session.usage') {
          const payload = frame.payload as
            { sessionTotals?: SessionUsageTotals | null } | undefined;
          if (payload?.sessionTotals != null) setLiveUsage(payload.sessionTotals);
          return;
        }
        if (
          frame.type === 'session.ended' ||
          frame.type === 'session.paused' ||
          frame.type === 'session.resumed' ||
          frame.type === 'session.started'
        ) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.session(id) });
          return;
        }
        setTranscript((current) => applyEvent(current, frame));
      },
      onStateChange: (open) => {
        if (!open) return;
        opened += 1;
        // §9.4: a reconnect re-tails from the stored byte offset. Never a full
        // refetch — the request count is the assertion.
        if (opened > 1) {
          void (async () => {
            const page = await readPage({ from: String(nextOffset.current) });
            if (page !== undefined) setTranscript((current) => applyPage(current, page));
          })();
        }
      },
    });
    stream.start();
    return () => stream.stop();
  }, [client, id, queryClient, readPage, sessionTransport]);

  // Lifecycle facts also arrive on the global feed; the record follows them.
  useEffect(
    () =>
      events.on((frame) => {
        if (frame.ids['sessionId'] !== id) return;
        if (!frame.type.startsWith('session.')) return;
        void queryClient.invalidateQueries({ queryKey: queryKeys.session(id) });
      }),
    [events, id, queryClient],
  );

  const loadEarlier = useCallback(async () => {
    setLoadingEarlier(true);
    const from = Math.max(0, transcript.from - EARLIER_CHUNK_BYTES);
    const page = await readPage({ from: String(from) });
    setLoadingEarlier(false);
    if (page !== undefined) setTranscript((current) => applyPage(current, page));
  }, [readPage, transcript.from]);

  async function control(control: keyof typeof CONTROL_PATHS): Promise<void> {
    setFailure(undefined);
    const body =
      control === 'steer'
        ? { text: steerText, interrupt }
        : control === 'pin'
          ? { pinned: session?.pinned !== true }
          : {};
    const result = await client.request<SessionControlResult>(
      `/sessions/${encodeURIComponent(id)}/${CONTROL_PATHS[control]}`,
      { method: 'POST', body },
    );
    if (result.kind === 'ok') {
      // Idempotent by contract: `changed` says whether this call did it, and the
      // status is a state either way — never an error (§9.3).
      if (result.value !== undefined) setControlState(result.value);
      if (control === 'steer') setSteerText('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(id) });
      return;
    }
    setFailure(result);
    pushToast(result.message);
  }

  if (detail.isError) {
    return (
      <section>
        <h2>Session</h2>
        <p className="notice" data-tone="danger" role="alert">
          {failureOf(detail.error)?.message ?? 'That session could not be read.'}
        </p>
      </section>
    );
  }

  if (session === undefined) {
    return (
      <section>
        <h2>Session</h2>
        <p className="empty">Loading the session…</p>
      </section>
    );
  }

  const agent = roster.data?.agents.find((one) => one.definition.id === session.agentId);
  const start = transcript.blocks.find((block): block is StartBlock => block.kind === 'start');
  const awaiting = isAwaitingAnswer(status ?? session.status, exitReason);
  const controls = controlStates(status ?? session.status, exitReason, session.pinned);
  const usage = liveUsage ?? detail.data?.usage ?? null;

  return (
    <div className="session">
      <section className="session__main" aria-labelledby="session-heading">
        <header className="session__header">
          <h2 id="session-heading">
            {agent === undefined ? (
              'deleted agent'
            ) : (
              <>
                <Avatar
                  agentId={agent.definition.id}
                  name={agent.definition.name}
                  avatar={agent.definition.avatar}
                />
                {agent.definition.name}
              </>
            )}
          </h2>
          <p className="session__meta">
            {/* runner's status vocabulary, verbatim (§9.2). */}
            <span className="badge" data-status={status}>
              {status}
            </span>
            {session.model === null ? null : <span className="badge">{session.model}</span>}
            {session.permissionMode === null ? null : (
              <span className="badge">{session.permissionMode}</span>
            )}
            {start?.workspace?.kind === undefined ? null : (
              <span className="badge">
                {start.workspace.kind}
                {start.workspace.branch === null || start.workspace.branch === undefined
                  ? ''
                  : ` · ${start.workspace.branch}`}
              </span>
            )}
            <Link to={`/projects/${encodeURIComponent(session.projectId)}`}>project</Link>
            <Link to={`/assignments/${encodeURIComponent(session.assignmentId)}`}>assignment</Link>
          </p>

          {/* The badges §9.2 says must never be missed. */}
          {start?.elevation == null ? null : (
            <p className="notice" data-tone="warn" data-badge="elevation">
              Elevated permissions: {start.elevation.allow.join(', ')} — {start.elevation.reason}
            </p>
          )}
          {session.origin === 'remote' ? (
            <p className="notice" data-badge="remote">
              Started remotely.
            </p>
          ) : null}
          {start?.questionBridge === 'disabled' ? (
            <p className="notice" data-tone="warn" data-badge="question-bridge">
              Question bridge disabled — this agent cannot ask you anything mid-run, so a decision
              it needs will end the turn instead.
            </p>
          ) : null}
          {(start?.diagnostics ?? []).map((diagnostic, index) => (
            <p
              key={`${diagnostic.code ?? 'diagnostic'}-${String(index)}`}
              className="notice"
              data-tone={diagnostic.level === 'error' ? 'danger' : 'warn'}
              data-badge="diagnostic"
            >
              {diagnostic.message}
            </p>
          ))}
          {transcript.pruned ? (
            <p className="notice" data-badge="pruned">
              Transcript pruned — projects’ retention removed this file, so there is nothing to read
              back.
            </p>
          ) : null}
          {awaiting ? (
            <p className="notice" data-tone="warn" data-badge="awaiting-answer" role="status">
              Waiting for your answer. <Link to="/questions">See the card</Link>
            </p>
          ) : null}
        </header>

        <div className="session__controls" role="group" aria-label="Session controls">
          {controls
            .filter((one) => !one.hidden)
            .map((one) => (
              <button
                key={one.control}
                type="button"
                className="button"
                data-control={one.control}
                disabled={!one.enabled || one.control === 'relaunch'}
                // §9.3: shown disabled **with the reason**, never bare.
                title={one.reason}
                aria-describedby={one.enabled ? undefined : `reason-${one.control}`}
                onClick={() => {
                  if (one.control === 'relaunch') return;
                  void control(one.control);
                }}
              >
                {one.label}
              </button>
            ))}
          {controls
            .filter((one) => !one.hidden && !one.enabled)
            .map((one) => (
              <span
                key={`${one.control}-reason`}
                id={`reason-${one.control}`}
                className="visually-hidden"
              >
                {one.reason}
              </span>
            ))}
        </div>

        {status === 'running' ? (
          <div className="session__steer">
            <label htmlFor="steer-text">Steer</label>
            <input
              id="steer-text"
              value={steerText}
              onChange={(event) => setSteerText(event.target.value)}
            />
            <label className="launch__toggle">
              <input
                type="checkbox"
                checked={interrupt}
                onChange={(event) => setInterrupt(event.target.checked)}
              />
              interrupt the current turn
            </label>
          </div>
        ) : null}

        {failure === undefined ? null : (
          <p className="notice" data-tone="danger" role="alert">
            {failure.message}
          </p>
        )}

        {transcript.capped || transcript.from > 0 ? (
          <button
            type="button"
            className="button"
            disabled={loadingEarlier}
            onClick={() => void loadEarlier()}
          >
            <Icon name="clock" />
            Load earlier
          </button>
        ) : null}

        {/*
          §15: `aria-live="off"` on the transcript. "Streaming assistant text is
          not announced — announcing every token makes a screen reader unusable."
        */}
        <ol className="session__blocks" aria-live="off" data-cap={String(BLOCK_CAP)}>
          {transcript.blocks.map((block) => (
            <SessionBlock key={block.key} block={block} />
          ))}
        </ol>
      </section>

      <UsageRail usage={usage} />
    </div>
  );
}
