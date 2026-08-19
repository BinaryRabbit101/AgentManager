/**
 * Settings → **Automation** (DESIGN §13.1; orchestrator §2.8, WO8).
 *
 * The global list of background triggers, across every project. Its own module
 * rather than inline JSX in `SettingsPage`, for the reason `RemoteSection` is
 * its own module: the panel is substantial, and the project page renders the
 * same one.
 *
 * **Not edition-gated** (D6). Triggers are outbound-only and involve no
 * listener, so a work-edition install schedules work exactly as a home one does.
 */
import type { ReactElement } from 'react';

import { TriggersPanel } from './TriggersPanel';

export function AutomationSection(): ReactElement {
  return (
    <section
      className="settings__section"
      aria-labelledby="settings-automation"
      data-section="automation"
    >
      <h3 id="settings-automation">Automation</h3>
      <p>
        A trigger runs a task template on a schedule. Before every run the same preflight the
        Start-work dialog shows has to come back green — a run that would stop and ask for a
        permission, or reach for a connector that is not connected, is refused and says so instead.
      </p>
      <TriggersPanel headingId="settings-automation" />
    </section>
  );
}
