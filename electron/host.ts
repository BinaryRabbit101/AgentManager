/**
 * The shell's view of Electron (ui DESIGN §1.5, foundation §4.1).
 *
 * Electron is a **pure client** and the shell is a thin wrapper with seven
 * responsibilities. Every one of them touches the Electron API, and none of them
 * is interesting enough to be worth an un-testable file — so the API is declared
 * here as the exact subset the shell uses, and `main.ts` builds one of these from
 * the real `electron` module.
 *
 * Two consequences, both deliberate:
 *
 * - **`shell.ts` is unit-testable with a plain object.** Electron cannot be
 *   driven headlessly in this repository (it needs a downloaded binary and a
 *   display), so the alternative to a seam is no coverage at all. The window-level
 *   behaviour that genuinely needs a window lives on the manual checklist
 *   (`npm run checks:ui`).
 * - **`electron` is not a build dependency.** Nothing here imports it; `main.ts`
 *   resolves it at runtime. Packaging the shell — the Electron dependency,
 *   the builder, the installer — is foundation §7's deferred half, and adding a
 *   ~200 MB devDependency to satisfy a type import would be paying for it early.
 *
 * The interfaces are structural, so the real Electron objects satisfy them
 * without an adapter beyond `main.ts`'s field-for-field wiring.
 */

/** `app` — only what §1.5's job list needs. */
export interface AppLike {
  whenReady(): Promise<void>;
  /** §1.5 #4: "a second launch focuses the existing window". */
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: () => void): void;
  quit(): void;
  /** The Windows taskbar badge (§1.5 #6). */
  setBadgeCount(count: number): boolean;
}

export interface WebContentsLike {
  /** `target="_blank"` and `window.open` — §1.5 #7. */
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
  /** In-page navigation — the other half of #7. */
  on(event: 'will-navigate', listener: (event: PreventableEvent, url: string) => void): void;
}

export interface PreventableEvent {
  preventDefault(): void;
}

export interface WindowLike {
  loadURL(url: string): Promise<void>;
  show(): void;
  focus(): void;
  isMinimized(): boolean;
  restore(): void;
  isDestroyed(): boolean;
  readonly webContents: WebContentsLike;
  on(event: 'closed', listener: () => void): void;
}

/** One tray menu row (§1.5 #3). */
export interface MenuItemSpec {
  readonly id: string;
  readonly label: string;
  readonly enabled?: boolean;
  readonly click?: () => void;
}

export interface TrayLike {
  setToolTip(text: string): void;
  setContextMenu(template: readonly MenuItemSpec[]): void;
}

export interface NotificationSpec {
  readonly title: string;
  readonly body: string;
  /** Clicking focuses the window on this route (§1.5 #6). */
  readonly route: string;
}

export interface WindowSpec {
  readonly width: number;
  readonly height: number;
  readonly show: boolean;
  readonly webPreferences: Readonly<Record<string, unknown>>;
}

/** `ipcMain` — the three privileged calls the preload forwards (§1.5 #5, #6). */
export interface IpcLike {
  handle(channel: string, listener: (payload: unknown) => unknown): void;
}

/**
 * The whole Electron surface the shell touches.
 *
 * `openExternal`, `showOpenDialog` and `notify` are named for what the shell
 * wants rather than for the Electron module they come from, because that is what
 * makes the fake in `shell.test.ts` readable.
 */
export interface ElectronHost {
  readonly app: AppLike;
  readonly ipc: IpcLike;
  createWindow(spec: WindowSpec): WindowLike;
  createTray(): TrayLike;
  /** Resolves when the user clicks the toast; never rejects. */
  notify(spec: NotificationSpec): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** §1.5 #5 — the only privileged capability the shell grants the page. */
  showOpenDialog(): Promise<string | null>;
}
