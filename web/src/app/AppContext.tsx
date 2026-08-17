/**
 * The three long-lived objects every screen reaches for, in one context.
 *
 * The API client, the avatar cache and the event stream are singletons in
 * production (§3.3: "two websockets at most, and only one of them is always
 * open") but they are *constructed* rather than imported as module state, so a
 * test can mount the whole app against a stub transport without touching the
 * network. That is the only reason this file exists.
 */

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

import type { AvatarCache } from '../api/avatars';
import type { ApiClient } from '../api/client';
import type { EffectiveConfig, Health } from '../api/types';
import type { EventStream } from '../events/EventStream';
import type { SseTransport } from '../events/sse';

import { BROWSER_BRIDGE, type DesktopBridge } from './bridge';

export interface BootFacts {
  readonly config: EffectiveConfig;
  readonly health: Health;
}

export interface AppServices {
  readonly client: ApiClient;
  readonly avatars: AvatarCache;
  readonly events: EventStream;
  readonly boot: BootFacts;
  /**
   * How the **per-session** feed of §3.3 is opened.
   *
   * The global feed's transport is already a seam inside `EventStream` (remote
   * §3.4 substitutes the ticket flavour there). The session view opens its own
   * socket while it is mounted, so the same seam has to reach it — and it reaches
   * it here rather than through a module-level default, for exactly the reason
   * this file exists: a screen must be mountable without a network.
   */
  readonly sessionTransport?: SseTransport | undefined;
  /**
   * The Electron preload bridge (§1.5), or the browser stub.
   *
   * Read once at boot and carried here rather than reached for through
   * `globalThis` at each call site, for the same reason everything else in this
   * file is: a screen must be mountable without the environment it ships in.
   */
  readonly bridge?: DesktopBridge | undefined;
}

const AppServicesContext = createContext<AppServices | undefined>(undefined);

export interface AppProviderProps {
  readonly services: AppServices;
  readonly children: ReactNode;
}

export function AppServicesProvider({ services, children }: AppProviderProps): ReactElement {
  return <AppServicesContext.Provider value={services}>{children}</AppServicesContext.Provider>;
}

export function useServices(): AppServices {
  const services = useContext(AppServicesContext);
  if (services === undefined) {
    throw new Error('useServices was called outside <AppServicesProvider>.');
  }
  return services;
}

/**
 * §1.5's bridge, feature-detected at every call site.
 *
 * Defaults to the browser stub, so a component that forgets to check still gets
 * a well-formed object with nothing on it rather than `undefined`.
 */
export function useBridge(): DesktopBridge {
  return useServices().bridge ?? BROWSER_BRIDGE;
}

/** `edition`, the module list and the policy flags of §3.5, read once at boot. */
export function useEdition(): 'home' | 'work' {
  return useServices().boot.config.edition;
}

export function useModules(): readonly string[] {
  return useServices().boot.health.modules.map((module) => module.name);
}

/**
 * §3.5: "A missing `orchestrator` module is a first-class degraded state, not a
 * crash: there is no launch path at all without it."
 */
export function useHasOrchestrator(): boolean {
  return useModules().includes('orchestrator');
}

/**
 * §3.5: what exists is learned from the module list, "never by probing for a
 * 404". The remote module is absent in the work edition by construction (§13.5)
 * and absent everywhere until the remote element ships, and both cases read the
 * same here — which is the point of feature detection over an edition branch.
 */
export function useHasModule(name: string): boolean {
  return useModules().includes(name);
}

/**
 * `policy.allowPermissionElevation` and the layer that won it (§3.5, §13.5).
 *
 * Read from `/api/config/effective` at boot rather than assumed: config is
 * immutable per process (foundation §2.4), so one read is the whole story, and
 * the layer is what turns a disabled control into an explained one.
 */
export function usePermissionElevationPolicy(): {
  readonly allowed: boolean;
  readonly layer: string | undefined;
} {
  const { config } = useServices().boot;
  const policy = config.config['policy'];
  const allowed =
    typeof policy === 'object' && policy !== null
      ? (policy as Record<string, unknown>)['allowPermissionElevation'] !== false
      : true;
  return { allowed, layer: config.sources['policy.allowPermissionElevation']?.layer };
}
