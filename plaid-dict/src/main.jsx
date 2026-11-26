import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from '@ui/components/ui/sonner';
import { configureUi } from '@ui/lib/uiConfig.js';
import { initI18n } from '@ui/lib/i18n.js';
import { configureAuth } from '@ui/services/auth.js';
import App from './App';
// The provenance palette the apps share, then this app's own tokens.
import '@ui/index.css';
import './index.css';

// plaid-ui prefixes every localStorage key it writes with `appPrefix`, so no two
// apps decide how each other's lists open, and reads this app's half of a
// project's config bucket under `configNamespace`. This app binds no compose
// codes.
configureUi({ appName: 'Plaid Dictionary', appPrefix: 'plaid_dict', configNamespace: 'dict' });
configureAuth({ loginRoute: '#/login' });

// The interface's language, settled before anything renders, so no screen
// shows first in one language and then in another. A promise rather than a
// top-level await: this app's build target has none.
initI18n({
  fr: async () => (await Promise.all([import('@ui/locales/fr.js')])).map((m) => m.default),
}).then(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <Toaster richColors closeButton position="bottom-right" />
      <App />
    </React.StrictMode>,
  );
});
