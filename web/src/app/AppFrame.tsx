/**
 * The app frame (DESIGN §2.2, §2.3).
 *
 * One component tree for all three viewports. Desktop gets a narrow left rail
 * plus a persistent top bar; the phone gets the same four destinations as a
 * bottom tab bar with 48px targets. The switch is a media query in `styles.css`,
 * not a branch here — §2.3 says the layout is responsive from a single tree, and
 * a second tree is how the two delivery modes drift apart.
 *
 * Landmarks are real (`nav` / `main`), the destinations are a list because they
 * are a list, and every rail item is a real link so it can be middle-clicked,
 * bookmarked and read by a screen reader (§15).
 */

import type { ReactElement, ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import { Icon, type IconName } from '../icons/Sprite';

import { ConnectionIndicator, OfflineBanner } from './ConnectionIndicator';
import { ThemeToggle } from './ThemeToggle';

interface Destination {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
}

const DESTINATIONS: readonly Destination[] = [
  { to: '/', label: 'Board', icon: 'board' },
  { to: '/questions', label: 'Questions', icon: 'questions' },
  { to: '/usage', label: 'Usage', icon: 'usage' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

export interface AppFrameProps {
  readonly children: ReactNode;
}

export function AppFrame({ children }: AppFrameProps): ReactElement {
  return (
    <div className="frame">
      <header className="frame__topbar">
        <h1 className="frame__title">AgentManager</h1>
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
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="frame__main">{children}</main>
    </div>
  );
}
