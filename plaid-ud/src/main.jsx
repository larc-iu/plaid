import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import '@mantine/core/styles.css';
import '@mantine/dropzone/styles.css';
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

// Mantine still provides the theme and, until 0.4 retires RewritePreview's
// modal, the modal manager. Toasts and confirmations are already sonner and the
// shared ConfirmProvider, so the two halves of the migration never show two
// toast stacks at once.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MantineProvider theme={theme}>
      <ModalsProvider>
        <Toaster richColors closeButton position="bottom-right" />
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </ModalsProvider>
    </MantineProvider>
  </StrictMode>,
);
