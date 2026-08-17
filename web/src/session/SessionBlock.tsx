/**
 * One block of the session body (DESIGN §9.2's table).
 *
 * Structured rendering, never a terminal (§9.1): a tool call is one collapsed
 * line that expands, an errored one is expanded by default, a `Bash` result gets
 * the §9.1 `<pre>` and the ANSI formatter, and everything reflows on a 390px
 * viewport because it is real markup rather than a fixed-column buffer.
 *
 * Assistant text is rendered as **text**, not as HTML. §1.4 pins that agent
 * output is untrusted and that markdown rendering needs "a bundled renderer with
 * HTML disabled and a strict sanitiser"; no such renderer is bundled in this
 * milestone (it would be a dependency with no acceptance criterion behind it in
 * §4), so the text is placed in the DOM as a text node — which is the safe half
 * of that rule and is what makes the unsafe half impossible to reach by accident.
 */

import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { Icon } from '../icons/Sprite';

import { hasAnsi, parseAnsi, type AnsiSpan } from './ansi';
import { inputPreview, type Block } from './blocks';

/** The §9.1 exception: `Bash` **results** are captured program output. */
const ANSI_TOOLS: readonly string[] = ['Bash', 'BashOutput'];

function AnsiText({ text }: { readonly text: string }): ReactElement {
  const spans: readonly AnsiSpan[] = parseAnsi(text);
  return (
    <pre className="session-block__pre" data-ansi={hasAnsi(text) ? 'true' : 'false'}>
      {spans.map((span, index) => (
        <span
          key={index}
          data-ansi-span="true"
          style={{
            ...(span.color === undefined ? {} : { color: span.color }),
            ...(span.background === undefined ? {} : { background: span.background }),
            ...(span.bold === true ? { fontWeight: 700 } : {}),
            ...(span.dim === true ? { opacity: 0.7 } : {}),
            ...(span.italic === true ? { fontStyle: 'italic' } : {}),
            ...(span.underline === true ? { textDecoration: 'underline' } : {}),
          }}
        >
          {span.text}
        </span>
      ))}
    </pre>
  );
}

function ToolBlockView({
  block,
}: {
  readonly block: Extract<Block, { kind: 'tool' }>;
}): ReactElement {
  // §9.2: "Errors expand by default." Everything else starts collapsed, which is
  // also the phone default (§2.3).
  const [open, setOpen] = useState(block.isError);
  const ansi = ANSI_TOOLS.includes(block.name);

  return (
    <li className="session-block" data-kind="tool" data-error={block.isError ? 'true' : 'false'}>
      <button
        type="button"
        className="session-block__toggle"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="tool" />
        <span className="session-block__tool-name">{block.name}</span>
        <span className="session-block__preview">{inputPreview(block.name, block.input)}</span>
        {block.isError ? (
          <span className="badge" data-tone="danger">
            error
          </span>
        ) : null}
        {block.settled ? null : <span className="badge">running</span>}
      </button>
      {open ? (
        <div className="session-block__body">
          <h4>Input</h4>
          <pre className="session-block__pre">{JSON.stringify(block.input, null, 2)}</pre>
          <h4>Result</h4>
          {block.result === undefined ? (
            <p className="empty">No result yet.</p>
          ) : ansi ? (
            <AnsiText text={block.result} />
          ) : (
            <pre className="session-block__pre">{block.result}</pre>
          )}
        </div>
      ) : null}
    </li>
  );
}

export interface SessionBlockProps {
  readonly block: Block;
}

export function SessionBlock({ block }: SessionBlockProps): ReactElement | null {
  switch (block.kind) {
    case 'start':
      return (
        <li className="session-block" data-kind="start">
          <p className="session-block__meta">
            Session started
            {block.model === null ? '' : ` · ${block.model}`}
            {block.permissionMode === null ? '' : ` · ${block.permissionMode}`}
            {block.workspace?.branch === undefined || block.workspace.branch === null
              ? ''
              : ` · ${block.workspace.branch}`}
          </p>
        </li>
      );

    case 'prompt':
      return (
        <li className="session-block" data-kind="prompt" data-variant={block.variant}>
          <p className="session-block__meta">
            {block.variant === 'steer'
              ? block.interrupted
                ? 'steered — interrupted the turn'
                : 'steered'
              : block.variant === 'answer'
                ? 'your answer'
                : 'you said'}
          </p>
          <p className="session-block__text">{block.text}</p>
        </li>
      );

    case 'assistant':
      return (
        <li
          className="session-block"
          data-kind="assistant"
          data-streaming={block.streaming ? 'true' : 'false'}
        >
          {/*
            §15: the transcript region is not a live region — "announcing every
            token makes a screen reader unusable". The caret is CSS, and it is
            one of the two looping indicators the whole app is allowed (§14.1).
          */}
          <p className="session-block__text">
            {block.text}
            {block.streaming ? <span className="session-block__caret" aria-hidden="true" /> : null}
          </p>
        </li>
      );

    case 'tool':
      return <ToolBlockView block={block} />;

    case 'question':
      return (
        <li className="session-block" data-kind="question">
          <p className="session-block__meta">
            asked you
            {block.delivery === undefined
              ? ''
              : block.delivery === 'inline'
                ? ' · answered inline, without leaving the tool call'
                : ' · answered after the session parked'}
            {block.answeredVia === undefined ? '' : ` · answered ${block.answeredVia}`}
            {block.latencyMs === undefined
              ? ''
              : ` · waited ${String(Math.round(block.latencyMs / 1000))}s`}
          </p>
          <p className="session-block__text">{block.prompt}</p>
          {block.questionId === '' ? null : (
            <Link to={`/questions/${encodeURIComponent(block.questionId)}`}>See the card</Link>
          )}
        </li>
      );

    case 'diagnostic':
      return (
        <li className="session-block" data-kind="diagnostic" data-level={block.level}>
          {/* §9.2: "severity-coloured, always expanded, carrying the server's message". */}
          <p className="session-block__meta">{block.code}</p>
          <p className="session-block__text">{block.message}</p>
        </li>
      );

    case 'end':
      return (
        <li className="session-block" data-kind="end">
          <p className="session-block__meta">
            {`Finished: ${block.status}`}
            {block.exitReason === null ? '' : ` · ${block.exitReason.replaceAll('_', ' ')}`}
            {block.turns === null ? '' : ` · ${String(block.turns)} turns`}
            {block.durationMs === null ? '' : ` · ${String(Math.round(block.durationMs / 1000))}s`}
          </p>
          {block.summary === null ? null : <p className="session-block__text">{block.summary}</p>}
        </li>
      );
  }
}
