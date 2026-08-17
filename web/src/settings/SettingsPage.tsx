/**
 * Settings (DESIGN §13; IMPLEMENTATION §10).
 *
 * Six sections, and three rules that decide what each one renders:
 *
 * 1. **Config is immutable per process** (foundation §2.4), so anything not
 *    backed by `settings` is read-only "with its winning layer" from
 *    `/api/config/effective`. "Presenting an editable control for something that
 *    cannot change at runtime is the fastest way to make a settings screen
 *    untrustworthy."
 * 2. **Remote browser: disabled with the reason. Work edition: hidden, with one
 *    honest sentence** (§13.5, §18-4). The distinction is whether the capability
 *    *exists*: over the tailnet remote's deny list refuses a route that works at
 *    the desk, and the user must learn that boundary; in the work edition the
 *    module is not loaded at all and a disabled toggle would be theatre.
 * 3. **The denied set is read from `GET /api/remote/status`**, never hardcoded,
 *    so a denial added server-side greys the right control by itself (§13.4).
 */

import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { queryKeys, useRemoteAgents, useRemoteStatus, useRemoteTokens } from '../api/queries';
import type { MintedToken } from '../api/types';
import { useEdition, useHasModule, useServices } from '../app/AppContext';
import { THEME_CHOICES, applyTheme, type ThemeChoice } from '../theme/theme';
import { useAppStore } from '../state/store';
import { RemoteSection } from '../remote/RemoteSection';
import { isRemoteClient, controlState } from '../remote/access';

export function SettingsPage(): ReactElement {
  const { client, boot } = useServices();
  const edition = useEdition();
  // §3.5, §13.5: feature detection, never a 404 probe. In the work edition the
  // remote module is not loaded, so this is false and the section is absent.
  const hasRemote = useHasModule('remote');
  const remote = isRemoteClient(client);
  const status = useRemoteStatus(client, hasRemote);
  const theme = useAppStore((store) => store.theme);
  const setTheme = useAppStore((store) => store.setTheme);

  const notifyLayer = boot.config.sources['orchestrator.notify.enabled']?.layer;
  const notifyEnabled =
    (
      (boot.config.config['orchestrator'] as Record<string, unknown> | undefined)?.['notify'] as
        Record<string, unknown> | undefined
    )?.['enabled'] !== false;

  const shutdown = controlState(status.data, remote, {
    method: 'POST',
    path: '/api/service/shutdown',
  });

  return (
    <section className="settings" aria-labelledby="settings-heading">
      <h2 id="settings-heading">Settings</h2>

      {hasRemote ? <RemoteSection /> : null}

      <section className="settings__section" aria-labelledby="settings-runner">
        <h3 id="settings-runner">Runner</h3>
        <p className="settings__layer">
          The concurrency cap lives on the <a href="/usage">usage screen</a>, beside the queue it
          governs. Everything else about the runner is configuration, which is fixed for the life of
          the process (foundation §2.4) and is shown with the layer that set it.
        </p>
        <ConfigRow label="runner.maxConcurrent" />
        <ConfigRow label="runner.sessionTimeoutMs" />
      </section>

      <section className="settings__section" aria-labelledby="settings-notify">
        <h3 id="settings-notify">Notifications</h3>
        {/*
          §13.5: a config-level policy is "shown disabled with the reason **and
          the layer that set it**" — in either edition, because the flag is
          visible in `/api/config/effective` either way.
        */}
        <label className="settings__row">
          <span>Send an ntfy push when a question stays open</span>
          <input
            type="checkbox"
            checked={notifyEnabled}
            disabled
            data-control="orchestrator.notify"
          />
        </label>
        <p className="settings__layer" data-layer={notifyLayer ?? 'built-in'}>
          {notifyEnabled
            ? `Enabled by the ${notifyLayer ?? 'built-in'} layer. Changing it needs a restart.`
            : `Disabled by the ${notifyLayer ?? 'built-in'} layer. Changing it needs a restart.`}
        </p>
        <p className="settings__layer">
          A push is a wake-up and a tailnet link — never the question’s content, and never a way to
          answer from outside the tailnet (§11.4).
        </p>
      </section>

      <section className="settings__section" aria-labelledby="settings-appearance">
        <h3 id="settings-appearance">Appearance</h3>
        <div className="field">
          <label htmlFor="settings-theme">Theme</label>
          <select
            id="settings-theme"
            value={theme}
            onChange={(event) => {
              const choice = event.target.value as ThemeChoice;
              setTheme(choice);
              applyTheme(choice);
            }}
          >
            {THEME_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </div>
      </section>

      <LogsSection />

      <section className="settings__section" aria-labelledby="settings-health">
        <h3 id="settings-health">Health &amp; about</h3>
        <dl>
          <dt>Edition</dt>
          <dd data-fact="edition">{edition}</dd>
          <dt>Version</dt>
          <dd>{boot.config.version}</dd>
          <dt>Modules</dt>
          <dd data-fact="modules">
            {boot.health.modules.map((module) => `${module.id}:${module.status}`).join(' ')}
          </dd>
        </dl>

        {/*
          §13.5's one honest sentence. Not a disabled section: in the work
          edition the routes do not exist, so there is nothing to disable.
        */}
        {hasRemote ? null : (
          <p className="settings__layer" data-fact="no-remote">
            Remote access is not available in the work edition.
          </p>
        )}

        {/*
          IMPLEMENTATION §10: health warnings are "displayed **persistently**,
          not as a dismissible toast". So they are rendered as part of the page,
          with no dismiss control anywhere near them.
        */}
        {boot.health.conditions.map((condition) => (
          <p
            key={condition.id}
            className="notice"
            data-tone={condition.level === 'error' ? 'danger' : 'warn'}
            data-condition-id={condition.id}
          >
            {condition.message}
          </p>
        ))}

        <DiagnosticsDownload />

        <button
          type="button"
          className="button"
          data-control="shutdown"
          disabled={shutdown.disabled}
          title={shutdown.reason}
          onClick={() => void client.request('/service/shutdown', { method: 'POST', body: {} })}
        >
          Stop background service
        </button>
        {shutdown.reason === undefined ? null : (
          <p className="settings__layer" data-reason="shutdown">
            {shutdown.reason}
          </p>
        )}
      </section>
    </section>
  );
}

/** One immutable config value, with the layer that won it (§13.1). */
function ConfigRow({ label }: { readonly label: string }): ReactElement {
  const { boot } = useServices();
  const source = boot.config.sources[label];
  return (
    <p className="settings__row" data-config={label}>
      <span>{label}</span>
      <span className="settings__layer">
        {source === undefined ? 'default' : `${source.layer} · ${source.origin}`}
      </span>
    </p>
  );
}

/**
 * §13.3, deliberately plain: "a filterable list, not a log analytics product".
 *
 * The download goes through the API client to a blob (§3.1, §18-9): `<a
 * download>` cannot carry a bearer, so over the tailnet a plain link would 401.
 */
function LogsSection(): ReactElement {
  const { client } = useServices();
  const pushToast = useAppStore((store) => store.pushToast);
  const [level, setLevel] = useState('info');
  const [records, setRecords] = useState<
    readonly { ts: string; level: string; component?: string; msg?: string }[] | undefined
  >();

  async function load(next = level): Promise<void> {
    const result = await client.request<{
      records: readonly { ts: string; level: string; component?: string; msg?: string }[];
    }>('/logs', { query: { level: next, limit: '100' } });
    if (result.kind !== 'ok') {
      pushToast(result.message);
      return;
    }
    setRecords(result.value.records);
  }

  return (
    <section className="settings__section" aria-labelledby="settings-logs">
      <h3 id="settings-logs">Logs</h3>
      <div className="field">
        <label htmlFor="settings-log-level">Level</label>
        <select
          id="settings-log-level"
          value={level}
          onChange={(event) => {
            setLevel(event.target.value);
            void load(event.target.value);
          }}
        >
          {['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </select>
        <button type="button" className="button" onClick={() => void load()}>
          Read the log
        </button>
      </div>
      {records === undefined ? (
        <p className="empty">Nothing read yet.</p>
      ) : records.length === 0 ? (
        <p className="empty">No records at this level.</p>
      ) : (
        <ul className="settings__list" data-logs="true">
          {records.slice(0, 100).map((record, index) => (
            <li key={`${record.ts}-${String(index)}`} data-level={record.level}>
              {`${record.ts} ${record.level} ${record.component ?? ''} ${record.msg ?? ''}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DiagnosticsDownload(): ReactElement {
  const { client } = useServices();
  const pushToast = useAppStore((store) => store.pushToast);
  return (
    <button
      type="button"
      className="button"
      data-control="diagnostics"
      onClick={() => {
        void client.objectUrl('/logs/download').then((result) => {
          if (result.kind !== 'ok') {
            pushToast(result.message);
            return;
          }
          const anchor = document.createElement('a');
          anchor.href = result.value;
          anchor.download = 'agentmanager-logs.zip';
          anchor.click();
          URL.revokeObjectURL(result.value);
        });
      }}
    >
      Download diagnostics
    </button>
  );
}

/** Re-exported for the grant toggle on the board card (§13.2, remote §12.4). */
export function useGrants(): ReturnType<typeof useRemoteAgents> {
  const { client } = useServices();
  return useRemoteAgents(client, useHasModule('remote'));
}

/** Shared by the settings screen and the token dialog. */
export function useTokens(): ReturnType<typeof useRemoteTokens> {
  const { client } = useServices();
  return useRemoteTokens(client, useHasModule('remote'));
}

/** After a mint, both lists are stale. One place, so neither is forgotten. */
export function useAfterMint(): (token: MintedToken) => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.remoteTokens });
    await queryClient.invalidateQueries({ queryKey: queryKeys.remoteStatus });
  };
}
