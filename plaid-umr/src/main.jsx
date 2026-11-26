import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@ui/components/ui/sonner';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';
import { configureUi } from '@ui/lib/uiConfig.js';
import { initI18n } from '@ui/lib/i18n.js';
import { APP_ROUTES } from './appRoutes.js';
import { configureAuth } from '@ui/services/auth.js';
// The provenance palette the apps share, then this app's own tokens.
import '@ui/index.css';
import './index.css';
import App from './App.jsx';

// plaid-ui prefixes every localStorage key it writes with `appPrefix`, so no two
// apps decide how each other's lists open, and reads this app's half of a
// project's config bucket under `configNamespace`. This app binds no compose
// codes.
configureUi({
  appPrefix: 'plaid_umr',
  configNamespace: 'umr',
  appName: 'Plaid UMR',
  appRoutes: APP_ROUTES,
});

// Where a signed-out session lands. The app's routing table is the app's.
configureAuth({ loginRoute: '#/login' });

// The interface's language, settled before anything renders, so no screen
// shows first in one language and then in another.
await initI18n({
  fr: async () =>
    (await Promise.all([import('@ui/locales/fr.js'), import('./locales/fr.js')])).map(
      (m) => m.default,
    ),
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Toaster richColors closeButton position="bottom-right" />
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </StrictMode>,
);
