/**
 * The entry point: pairing, singletons, boot, render.
 *
 * The order matters and is §3.2's, step for step. The bearer is taken out of
 * `location.hash` and the fragment stripped with `history.replaceState`
 * **before the first render**, so a paired phone cannot be screenshotted from
 * its own address bar.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import './styles.css';

import { App } from './App';
import { AvatarCache } from './api/avatars';
import { ApiClient } from './api/client';
import { DEFAULT_STALE_TIME_MS } from './api/queries';
import { AppServicesProvider } from './app/AppContext';
import { BootGate } from './app/Boot';
import { EventStream } from './events/EventStream';
import { claimTokenFromHash } from './api/pairing';
import { readStoredTheme } from './theme/theme';
import { useAppStore } from './state/store';

const client = new ApiClient();
claimTokenFromHash(client);

const avatars = new AvatarCache(client);
const events = new EventStream({ client });
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // §16: nothing polls. The event feed is what invalidates.
      staleTime: DEFAULT_STALE_TIME_MS,
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

// The theme is already on <html> (theme-boot.js); this only seeds the store.
useAppStore.getState().setTheme(readStoredTheme());

const container = document.querySelector('#root');
if (container === null) throw new Error('The page has no #root to mount into.');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BootGate client={client}>
        {(boot) => (
          <AppServicesProvider services={{ client, avatars, events, boot }}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </AppServicesProvider>
        )}
      </BootGate>
    </QueryClientProvider>
  </StrictMode>,
);
