/**
 * The app root: routes (§2.1), the frame (§2.2) and the boot gate (§3.5).
 *
 * Fifteen routes, every one deep-linkable and every one surviving a reload — the
 * ntfy notification and the Electron toast both navigate by URL, and
 * foundation §6.4's history fallback is what makes a cold `GET /questions/abc`
 * arrive here rather than at a 404.
 */

import type { ReactElement } from 'react';
import { Route, Routes } from 'react-router-dom';

import { AgentDetail } from './agents/AgentDetail';
import { AgentWizard } from './agents/AgentWizard';
import { AssignmentPage } from './assignments/AssignmentPage';
import { AssignmentsPage } from './assignments/AssignmentsPage';
import { Board } from './board/Board';
import { AppFrame } from './app/AppFrame';
import { ConnectorsPage } from './connectors/ConnectorsPage';
import { DebugPanel } from './app/DebugPanel';
import { SettingsPage } from './settings/SettingsPage';
import { UsageView } from './usage/UsageView';
import { Toasts } from './app/Toasts';
import { useBridge, useServices } from './app/AppContext';
import { useDesktopBridge } from './app/useDesktopBridge';
import { useEventStream } from './app/useEventStream';
import { useOpenQuestions } from './app/useOpenQuestions';
import { Home } from './home/Home';
import { Sprite } from './icons/Sprite';
import { ProjectPage } from './projects/ProjectPage';
import { ProjectsPage } from './projects/ProjectsPage';
import { QuestionInbox } from './questions/QuestionInbox';
import { SessionsPage } from './session/SessionsPage';
import { SessionView } from './session/SessionView';
import { StartWorkHost } from './startwork/StartWork';

export function App(): ReactElement {
  const { client, events, avatars } = useServices();
  const bridge = useBridge();
  useEventStream(events, avatars);
  // §2.2's badge, from the server (M6 closed M5's degrade), and §1.5 #6's toast
  // and taskbar badge, which mirror it.
  useOpenQuestions(client);
  useDesktopBridge(bridge, events);

  return (
    <>
      <Sprite />
      <AppFrame>
        <Routes>
          {/*
            §2.4: home is mission control, and the board is a destination named
            for what it holds (§5). `/agents` is declared *after* its own two
            deeper routes only in this file's reading order — react-router v6
            ranks by specificity, not by source order, so `/agents/new` and
            `/agents/:id` still win over `/agents`. `shell.test.tsx` asserts it
            rather than trusting it.
          */}
          <Route path="/" element={<Home />} />
          <Route path="/agents" element={<Board />} />
          <Route path="/agents/new" element={<AgentWizard />} />
          <Route path="/agents/:id" element={<AgentDetail />} />
          {/* The connector library (§7.4, roster §10.3): define a server once,
              assign it to the agents that need it. */}
          <Route path="/connectors" element={<ConnectorsPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:id" element={<SessionView />} />
          <Route path="/assignments" element={<AssignmentsPage />} />
          <Route path="/assignments/:id" element={<AssignmentPage />} />
          <Route path="/questions" element={<QuestionInbox />} />
          {/* The ntfy deep-link target (§2.1, orchestrator §10). */}
          <Route path="/questions/:id" element={<QuestionInbox />} />
          <Route path="/usage" element={<UsageView />} />
          <Route path="/settings" element={<SettingsPage />} />
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
        {/*
          §6's one flow, mounted above every route — it is reached from home,
          the board, a card menu, a project card, a project page, a work-item
          row and every drop, and must survive the navigation that opening it
          from any of them would otherwise cause (§5.4, §6).

          One host, because there is one flow: the separate launch and pair
          dialogs that used to sit here are what made "start some work" a
          question about which dialog to open.
        */}
        <StartWorkHost />
        <Toasts />
      </AppFrame>
    </>
  );
}
