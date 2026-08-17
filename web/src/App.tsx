/**
 * The app root: routes (§2.1), the frame (§2.2) and the boot gate (§3.5).
 *
 * Ten routes, every one deep-linkable and every one surviving a reload — the
 * ntfy notification and the Electron toast both navigate by URL, and
 * foundation §6.4's history fallback is what makes a cold `GET /questions/abc`
 * arrive here rather than at a 404.
 */

import type { ReactElement } from 'react';
import { Route, Routes } from 'react-router-dom';

import { Board } from './board/Board';
import { AppFrame } from './app/AppFrame';
import { DebugPanel } from './app/DebugPanel';
import { Placeholder } from './app/Placeholder';
import { useServices } from './app/AppContext';
import { useEventStream } from './app/useEventStream';
import { Sprite } from './icons/Sprite';

export function App(): ReactElement {
  const { events, avatars } = useServices();
  useEventStream(events, avatars);

  return (
    <>
      <Sprite />
      <AppFrame>
        <Routes>
          <Route path="/" element={<Board />} />
          <Route
            path="/agents/new"
            element={<Placeholder title="New agent" milestone="M8" what="The drafting wizard" />}
          />
          <Route
            path="/agents/:id"
            element={<Placeholder title="Agent" milestone="M8" what="The agent editor" />}
          />
          <Route
            path="/projects/:id"
            element={<Placeholder title="Project" milestone="M7" what="The project page" />}
          />
          <Route
            path="/sessions/:id"
            element={<Placeholder title="Session" milestone="M4" what="The session view" />}
          />
          <Route
            path="/assignments/:id"
            element={
              <Placeholder title="Assignment" milestone="M9" what="The collaboration view" />
            }
          />
          <Route
            path="/questions"
            element={<Placeholder title="Questions" milestone="M5" what="The question inbox" />}
          />
          <Route
            path="/questions/:id"
            element={<Placeholder title="Question" milestone="M5" what="One question card" />}
          />
          <Route
            path="/usage"
            element={<Placeholder title="Usage" milestone="M10" what="The usage view" />}
          />
          <Route
            path="/settings"
            element={<Placeholder title="Settings" milestone="M10" what="Settings" />}
          />
          {/*
            The SPA's own 404. Foundation's history fallback hands every unknown
            non-API path to index.html, so this is where a mistyped URL lands —
            and it must say so rather than render an empty frame.
          */}
          <Route
            path="*"
            element={
              <section>
                <h2>No such screen</h2>
                <p className="empty">That address does not name anything in AgentManager.</p>
              </section>
            }
          />
        </Routes>
        <DebugPanel />
      </AppFrame>
    </>
  );
}
