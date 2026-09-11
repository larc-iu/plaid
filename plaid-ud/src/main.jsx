import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@ui/components/ui/sonner';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';
import { configureUi } from '@ui/lib/uiConfig.js';
// The provenance palette the apps share, then this app's own tokens.
import '@ui/index.css';
import './index.css';
import App from './App.jsx';

// plaid-ui prefixes every localStorage key it writes with this, so no two apps
// decide how each other's lists open. This app binds no compose codes.
configureUi({ appPrefix: 'plaid_ud' });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Toaster richColors closeButton position="bottom-right" />
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </StrictMode>,
);
