/**
 * Project quick-add — the register-an-existing-folder half (DESIGN §8.1).
 *
 * "A single dialog … **inspect → confirm**, never a form to fill." The whole
 * flow is three requests and no typing beyond a name the user probably keeps:
 *
 *   browse (or type a path) → `POST /api/projects/inspect` → prefilled form
 *   with the server's warnings verbatim → `POST /api/projects`
 *
 * Two rules are load-bearing and both come from §8.1:
 *
 * - **Refusals render the server's message with the offending path.** Nested
 *   project, already registered, inside the data root — projects wrote those
 *   messages for a human and they name the path that caused them. Paraphrasing
 *   would delete the one fact that fixes the problem.
 * - **A typed absolute path always works**, in both viewports and over the
 *   tailnet. The browse navigator is a convenience over `GET /api/fs/browse`,
 *   never the only way in.
 *
 * The Electron native picker is §1.5's one privileged capability and lands with
 * the shell (M6). The call site feature-detects (`bridge.pickFolder`) rather
 * than branching on delivery mode, so it needs no change here when it arrives.
 *
 * Clone (the second tab) is M7.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { useServices } from '../app/AppContext';
import { queryKeys } from '../api/queries';
import type { ApiFailure } from '../api/result';
import type { BrowseListing, Project, ProjectInspection } from '../api/types';

export interface QuickAddDialogProps {
  readonly onClose: () => void;
  readonly onCreated?: (project: Project) => void;
}

export function QuickAddDialog({ onClose, onCreated }: QuickAddDialogProps): ReactElement {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDivElement>(null);

  const [path, setPath] = useState('');
  const [listing, setListing] = useState<BrowseListing | undefined>();
  const [browseFailure, setBrowseFailure] = useState<ApiFailure | undefined>();
  const [inspection, setInspection] = useState<ProjectInspection | undefined>();
  const [name, setName] = useState('');
  const [failure, setFailure] = useState<ApiFailure | undefined>();
  const [busy, setBusy] = useState(false);

  // §15: Esc closes every dialog, and focus starts inside it.
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('input')?.focus();
  }, []);

  async function browse(target: string | null): Promise<void> {
    const result = await client.request<BrowseListing>('/fs/browse', {
      query: target === null ? {} : { path: target },
    });
    if (result.kind === 'ok') {
      setListing(result.value);
      setBrowseFailure(undefined);
      setPath(result.value.path);
    } else {
      setBrowseFailure(result);
    }
  }

  async function inspect(): Promise<void> {
    setBusy(true);
    setFailure(undefined);
    const result = await client.request<ProjectInspection>('/projects/inspect', {
      method: 'POST',
      body: { localPath: path },
    });
    setBusy(false);
    if (result.kind === 'ok') {
      setInspection(result.value);
      setName(result.value.name);
    } else {
      setInspection(undefined);
      setFailure(result);
    }
  }

  async function create(): Promise<void> {
    if (inspection === undefined) return;
    setBusy(true);
    setFailure(undefined);
    const result = await client.request<Project>('/projects', {
      method: 'POST',
      body: { localPath: inspection.localPath, name, slug: inspection.slug },
    });
    setBusy(false);
    if (result.kind === 'ok') {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      onCreated?.(result.value);
      onClose();
    } else {
      setFailure(result);
    }
  }

  return (
    <div
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-add-heading"
      ref={dialogRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <h2 id="quick-add-heading">Add project</h2>

      <div className="field">
        <label htmlFor="quick-add-path">Folder path</label>
        <input
          id="quick-add-path"
          name="localPath"
          value={path}
          placeholder="C:\Code\my-app"
          onChange={(event) => setPath(event.target.value)}
        />
      </div>

      <div className="board__filters">
        <button type="button" className="button" onClick={() => void browse(null)}>
          Browse
        </button>
        <button
          type="button"
          className="button"
          disabled={path.trim() === '' || busy}
          onClick={() => void inspect()}
        >
          Inspect
        </button>
      </div>

      {browseFailure === undefined ? null : (
        <p className="notice" data-tone="danger" role="alert">
          {browseFailure.message}
        </p>
      )}

      {listing === undefined ? null : (
        <div className="browse">
          {/* §15: "lists that are lists" — the accessible name belongs on the
              list, not on a wrapper the screen reader walks straight past. */}
          <ul aria-label="Folders">
            {listing.parent === null ? null : (
              <li>
                <button type="button" onClick={() => void browse(listing.parent)}>
                  ↑ {listing.parent}
                </button>
              </li>
            )}
            {listing.entries.map((entry) => (
              <li key={entry.path}>
                <button type="button" onClick={() => void browse(entry.path)}>
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {failure === undefined ? null : (
        // The server's message, verbatim, including the path it names (§8.1).
        <p className="notice" data-tone="danger" role="alert" data-error-code={failure.code ?? ''}>
          {failure.message}
          {typeof failure.details?.['path'] === 'string' ? (
            <>
              {' '}
              <code>{String(failure.details['path'])}</code>
            </>
          ) : null}
        </p>
      )}

      {inspection === undefined ? null : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          {inspection.warnings.map((warning) => (
            <p key={warning.code} className="notice" data-warning-code={warning.code}>
              {warning.message}
            </p>
          ))}

          <div className="field">
            <label htmlFor="quick-add-name">Name</label>
            <input
              id="quick-add-name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <dl className="debug-panel">
            <dt>Path</dt>
            <dd>{inspection.localPath}</dd>
            <dt>Slug</dt>
            <dd>{inspection.slug}</dd>
            <dt>Version control</dt>
            <dd>{inspection.vcs}</dd>
            <dt>Remote</dt>
            <dd>{inspection.repoUrl ?? 'none'}</dd>
            <dt>Default branch</dt>
            <dd>{inspection.defaultBranch ?? 'none'}</dd>
          </dl>

          <button type="submit" className="button" data-variant="primary" disabled={busy}>
            Create
          </button>
        </form>
      )}

      <button type="button" className="button" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}
