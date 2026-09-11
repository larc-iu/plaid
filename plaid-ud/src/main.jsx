import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import { Toaster } from '@ui/components/ui/sonner';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';
import { configureUi } from '@ui/lib/uiConfig.js';
import { theme } from './theme.js';
// The provenance palette the apps share, then this app's own tokens.
import '@ui/index.css';
import './index.css';
import App from './App.jsx';

// plaid-ui prefixes every localStorage key it writes with this, so no two apps
// decide how each other's lists open. This app binds no compose codes.
configureUi({ appPrefix: 'plaid_ud' });

// Mantine is down to the theme, for the editor screens 0.5 has yet to reach.
// Its modal manager, notifications and dropzone are all gone; toasts and
// confirmations are sonner and the shared ConfirmProvider.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MantineProvider theme={theme}>
      <Toaster richColors closeButton position="bottom-right" />
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </MantineProvider>
  </StrictMode>,
);
