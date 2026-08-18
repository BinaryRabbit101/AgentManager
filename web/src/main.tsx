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
// §2.4's home screen. A sibling import rather than another `@import` inside
// `styles.css` only so the two can be edited independently; the cascade is the
// same, because this still lands after the sheet it builds on.
import './home.css';
// §7.3's integrations panel, beside home.css for the same reason: its own file
// so the editor's connector UI can be edited without touching the base sheet,
// and it lands after the utilities (`.field`, `.button`, `.badge`) it builds on.
import './integrations.css';
// §6's Start work flow, beside both for the same reason: one sheet per screen,
// edited independently, landing after the system it builds on.
import './startwork.css';

import { App } from './App';
import { AvatarCache } from './api/avatars';
import { ApiClient } from './api/client';
import { DEFAULT_STALE_TIME_MS } from './api/queries';
import { AppServicesProvider } from './app/AppContext';
import { BootGate } from './app/Boot';
import { readDesktopBridge } from './app/bridge';
import { EventStream } from './events/EventStream';
import { claimTokenFromHash } from './api/pairing';
import { readStoredTheme } from './theme/theme';
import { useAppStore } from './state/store';

const client = new ApiClient();
claimTokenFromHash(client);

const avatars = new AvatarCache(client);
const events = new EventStream({ client });
// §1.5: absent in a browser, present in the Electron window. One build, and the
// only thing that differs between the two deliveries is whether this is a stub.
const bridge = readDesktopBridge();
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
          <AppServicesProvider services={{ client, avatars, events, boot, bridge }}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </AppServicesProvider>
        )}
      </BootGate>
    </QueryClientProvider>
  </StrictMode>,
);
