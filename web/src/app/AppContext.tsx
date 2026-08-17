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

export interface BootFacts {
  readonly config: EffectiveConfig;
  readonly health: Health;
}

export interface AppServices {
  readonly client: ApiClient;
  readonly avatars: AvatarCache;
  readonly events: EventStream;
  readonly boot: BootFacts;
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
