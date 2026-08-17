/**
 * The boot facts, on screen (IMPLEMENTATION §1's acceptance).
 *
 * "The app boots against a running core, renders the frame, shows **edition and
 * module list** on a debug panel, and reports `live` on the connection
 * indicator."
 *
 * It also carries the persistent health warnings of §13.5's last acceptance —
 * a degraded keyfile secret provider and the `ANTHROPIC_API_KEY` override are
 * facts about how the machine is set up, not events, so they are displayed
 * persistently rather than as a dismissible toast.
 */

import type { ReactElement } from 'react';

import { useServices } from './AppContext';

export function DebugPanel(): ReactElement {
  const { boot, events } = useServices();
  const { config, health } = boot;

  return (
    <details className="debug-panel" data-testid="debug-panel">
      <summary>Core</summary>
      <dl>
        <dt>Edition</dt>
        <dd data-testid="debug-edition">{config.edition}</dd>
        <dt>Version</dt>
        <dd>{config.version}</dd>
        <dt>Health</dt>
        <dd>{health.status}</dd>
        <dt>Modules</dt>
        <dd data-testid="debug-modules">
          {health.modules.map((module) => `${module.name}:${module.status}`).join(' ')}
        </dd>
        <dt>Event filter</dt>
        <dd data-testid="debug-stream-url">{events.streamUrl()}</dd>
      </dl>

      {health.conditions.map((condition) => (
        <p
          key={`${condition.code}-${condition.module ?? ''}`}
          className="notice"
          data-tone={condition.level === 'error' ? 'danger' : 'warn'}
          data-condition-code={condition.code}
        >
          {condition.message}
        </p>
      ))}
    </details>
  );
}
