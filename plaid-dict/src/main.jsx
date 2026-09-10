import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from '@ui/components/ui/sonner';
import { configureUi } from '@ui/lib/uiConfig.js';
import App from './App';
// The provenance palette the apps share, then this app's own tokens.
import '@ui/index.css';
import './index.css';

// plaid-ui prefixes every localStorage key it writes with this, so no two apps
// decide how each other's lists open. This app binds no compose codes.
configureUi({ appPrefix: 'plaid_dict' });

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Toaster richColors closeButton position="bottom-right" />
    <App />
  </React.StrictMode>,
);
