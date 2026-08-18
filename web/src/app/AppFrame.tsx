/**
 * The app frame (DESIGN §2.2, §2.3).
 *
 * One component tree for all three viewports. Desktop gets a narrow left rail
 * plus a persistent top bar; the phone gets the same five destinations as a
 * bottom tab bar with 48px targets. The switch is a media query in `styles.css`,
 * not a branch here — §2.3 says the layout is responsive from a single tree, and
 * a second tree is how the two delivery modes drift apart.
 *
 * Landmarks are real (`nav` / `main`), the destinations are a list because they
 * are a list, and every rail item is a real link so it can be middle-clicked,
 * bookmarked and read by a screen reader (§15).
 */

import type { ReactElement, ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';

import { Announcer } from '../a11y/Announcer';
import { Icon, type IconName } from '../icons/Sprite';
import { useAppStore } from '../state/store';

import { ConnectionIndicator, OfflineBanner } from './ConnectionIndicator';
import { ThemeToggle } from './ThemeToggle';

interface Destination {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
}

const DESTINATIONS: readonly Destination[] = [
  { to: '/', label: 'Board', icon: 'board' },
  { to: '/projects', label: 'Projects', icon: 'folder' },
  { to: '/questions', label: 'Questions', icon: 'questions' },
  { to: '/usage', label: 'Usage', icon: 'usage' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

export interface AppFrameProps {
  readonly children: ReactNode;
}

export function AppFrame({ children }: AppFrameProps): ReactElement {
  // §2.2's badge. `null` until something has said — see the store's note.
  const openQuestions = useAppStore((store) => store.openQuestions);

  return (
    <div className="frame">
      <header className="frame__topbar">
        <h1 className="frame__title">AgentManager</h1>
        {/*
          §2.2's global "New agent". A link rather than a button for the reason
          every rail item is one — `/agents/new` is a route, and a route reached
          only by a click handler cannot be middle-clicked or bookmarked. Add
          project is the projects page's own header button, because it opens a
          dialog rather than navigating.
        */}
        <Link className="button" data-variant="primary" to="/agents/new">
          <Icon name="plus" />
          <span>New agent</span>
        </Link>
        <ConnectionIndicator />
        <ThemeToggle />
      </header>
      <OfflineBanner />
      <nav className="frame__rail" aria-label="Main">
        <ul>
          {DESTINATIONS.map((destination) => (
            <li key={destination.to}>
              <NavLink to={destination.to} end={destination.to === '/'}>
                <Icon name={destination.icon} />
                <span>{destination.label}</span>
                {destination.to === '/questions' && openQuestions !== null && openQuestions > 0 ? (
                  <span className="rail-badge" data-badge="questions">
                    {openQuestions}
                    <span className="visually-hidden"> questions waiting</span>
                  </span>
                ) : null}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="frame__main">{children}</main>
      {/* §15's polite region: status transitions and arriving questions, and
          nothing that streams. One region for the whole app. */}
      <Announcer />
    </div>
  );
}
