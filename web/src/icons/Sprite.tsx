/**
 * The inline SVG sprite (DESIGN §1.4).
 *
 * "No icon font, no icon CDN. A hand-picked inline SVG sprite in the bundle."
 * One `<svg>` of `<symbol>`s rendered once at the top of the app; every icon is
 * a `<use href="#icon-…">`, so the glyphs cost one copy each however many cards
 * are on the board.
 *
 * Icons are decorative by default (`aria-hidden`), because §15 requires that
 * colour and shape are never the only carrier — every icon here sits beside its
 * own word. An icon that must carry meaning passes a `title`.
 */

import type { ReactElement } from 'react';

export type IconName =
  | 'home'
  | 'board'
  | 'questions'
  | 'usage'
  | 'settings'
  | 'key'
  | 'warning'
  | 'pin'
  | 'chevron'
  | 'folder'
  | 'plus'
  | 'grip'
  | 'tool'
  | 'clock'
  | 'sessions'
  | 'assignments'
  | 'plug';

export function Sprite(): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'none' }}
      aria-hidden="true"
      data-testid="icon-sprite"
    >
      {/*
        A roof over a door — the one glyph nobody has to learn. §2.4's home is
        the screen the app opens on, and the rail's first item is the way back
        to it from anywhere.
      */}
      <symbol
        id="icon-home"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M2 7 8 2l6 5v6.5H2z" strokeLinejoin="round" />
        <path d="M6.5 13.5v-4h3v4" strokeLinejoin="round" />
      </symbol>
      <symbol
        id="icon-board"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <rect x="1.5" y="2.5" width="5" height="5" rx="1" />
        <rect x="9.5" y="2.5" width="5" height="5" rx="1" />
        <rect x="1.5" y="9.5" width="5" height="4" rx="1" />
        <rect x="9.5" y="9.5" width="5" height="4" rx="1" />
      </symbol>
      <symbol
        id="icon-questions"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M2 3.5h12v8H6l-4 3z" />
        <path d="M8 6.2a1.3 1.3 0 1 1 .9 1.3v1" strokeLinecap="round" />
      </symbol>
      <symbol
        id="icon-usage"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M2 13.5h12" strokeLinecap="round" />
        <path d="M4 13.5v-4M8 13.5v-8M12 13.5v-6" strokeLinecap="round" />
      </symbol>
      <symbol
        id="icon-settings"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="8" cy="8" r="2.2" />
        <path
          d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"
          strokeLinecap="round"
        />
      </symbol>
      <symbol id="icon-key" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="5" cy="8" r="2.5" />
        <path d="M7.5 8H14M12 8v2.5M10 8v2" strokeLinecap="round" />
      </symbol>
      <symbol
        id="icon-warning"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M8 2 14.5 13.5h-13z" strokeLinejoin="round" />
        <path d="M8 6.5v3.2M8 11.6v.4" strokeLinecap="round" />
      </symbol>
      <symbol id="icon-pin" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M6 1.5h4l-.6 4 2.6 2.5H4l2.6-2.5z" strokeLinejoin="round" />
        <path d="M8 8v6.5" strokeLinecap="round" />
      </symbol>
      <symbol
        id="icon-chevron"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="m5 3 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
      </symbol>
      <symbol
        id="icon-folder"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M1.5 3.5h4l1.5 2h7.5v8h-13z" strokeLinejoin="round" />
      </symbol>
      <symbol
        id="icon-plus"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M8 3v10M3 8h10" strokeLinecap="round" />
      </symbol>
      <symbol id="icon-grip" viewBox="0 0 16 16" fill="currentColor">
        <circle cx="6" cy="3.5" r="1.2" />
        <circle cx="10" cy="3.5" r="1.2" />
        <circle cx="6" cy="8" r="1.2" />
        <circle cx="10" cy="8" r="1.2" />
        <circle cx="6" cy="12.5" r="1.2" />
        <circle cx="10" cy="12.5" r="1.2" />
      </symbol>
      <symbol
        id="icon-tool"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path
          d="M10.5 2.2a3.5 3.5 0 0 0-4.3 4.5L2 11l3 3 4.3-4.2a3.5 3.5 0 0 0 4.5-4.3l-2.2 2.2-2-2z"
          strokeLinejoin="round"
        />
      </symbol>
      {/* A transcript: the session view's own shape, in miniature. */}
      <symbol
        id="icon-sessions"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
        <path d="M4.5 6h4M4.5 8.5h7M4.5 11h5" strokeLinecap="round" />
      </symbol>
      {/* Two seats facing each other — §10's pair, which is what an assignment is. */}
      <symbol
        id="icon-assignments"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="5" cy="5" r="2.25" />
        <circle cx="11" cy="5" r="2.25" />
        <path d="M1.75 13.25c0-2 1.45-3.25 3.25-3.25s3.25 1.25 3.25 3.25" strokeLinecap="round" />
        <path d="M8.75 13.25c0-2 1.45-3.25 3.25-3.25s2.25.8 2.25 2.4" strokeLinecap="round" />
      </symbol>
      {/* A two-pin plug: the connector library (§2.1, roster §10.3). Its own
          glyph rather than the tool spanner, because "what this agent can reach"
          and "what it is allowed to do" are the two things §7.3 is most careful
          not to let anyone mistake for each other. */}
      <symbol
        id="icon-plug"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M6 1.5v3.5M10 1.5v3.5" strokeLinecap="round" />
        <path d="M3.75 5h8.5v2a4.25 4.25 0 0 1-8.5 0z" strokeLinejoin="round" />
        <path d="M8 11.25v3.25" strokeLinecap="round" />
      </symbol>
      <symbol
        id="icon-clock"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" />
      </symbol>
    </svg>
  );
}

export interface IconProps {
  readonly name: IconName;
  readonly title?: string;
  readonly size?: number;
}

export function Icon({ name, title, size = 16 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      focusable="false"
      {...(title === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': title })}
    >
      <use href={`#icon-${name}`} />
    </svg>
  );
}
