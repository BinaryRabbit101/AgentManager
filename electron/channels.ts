/**
 * The three IPC channels behind the preload bridge (DESIGN §1.5).
 *
 * One module so the preload and the main process cannot drift on a string. There
 * are exactly three because the bridge exposes exactly five keys and two of them
 * — `isElectron` and `coreUrl` — are values known at preload time and never
 * cross the boundary again.
 *
 * Namespaced, so a channel name can never collide with one Electron itself uses.
 */

export const PICK_FOLDER_CHANNEL = 'agentmanager:pickFolder';
export const NOTIFY_CHANNEL = 'agentmanager:notify';
export const SET_BADGE_CHANNEL = 'agentmanager:setBadge';

/** The payload of {@link NOTIFY_CHANNEL}: a desktop toast and where it leads. */
export interface NotifyRequest {
  readonly title: string;
  readonly body: string;
  /** An app route (`/questions/abc`), never a full URL — the shell owns the origin. */
  readonly route: string;
}

/**
 * Reads a notify payload defensively.
 *
 * The renderer is the least trusted input the main process has: it renders
 * untrusted agent output, and `route` is turned into a navigation. So the route
 * must be a same-document absolute path — anything with a scheme, an authority,
 * or a backslash is refused rather than normalised, because a normaliser is a
 * thing to be wrong about.
 */
export function readNotifyRequest(payload: unknown): NotifyRequest | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const { title, body, route } = record;
  if (typeof title !== 'string' || title === '') return undefined;
  if (typeof body !== 'string') return undefined;
  if (typeof route !== 'string') return undefined;
  if (!isAppRoute(route)) return undefined;
  return { title, body, route };
}

/** `/questions/abc` — a leading slash, no second slash, no scheme, no backslash. */
export function isAppRoute(route: string): boolean {
  if (!route.startsWith('/')) return false;
  if (route.startsWith('//')) return false;
  if (route.includes('\\')) return false;
  return !/^\/[^/]*:/u.test(route);
}

/** The payload of {@link SET_BADGE_CHANNEL}. Clamped, never trusted. */
export function readBadgeCount(payload: unknown): number | undefined {
  if (typeof payload !== 'number' || !Number.isFinite(payload)) return undefined;
  return Math.max(0, Math.floor(payload));
}
