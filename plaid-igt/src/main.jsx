import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from '@ui/components/ui/sonner';
import { configureUi } from '@ui/lib/uiConfig.js';
import { attachCompose } from '@/lib/composeInput.js';
import App from './App';
// The provenance palette the apps share, then this app's own tokens.
import '@ui/index.css';
// Tailwind/shadcn styles.
import './index.css';

// What plaid-ui cannot know on its own. `plaid_igt` is the prefix this app's
// remembered list state has always carried, so nothing a reader had set is
// forgotten, and `igt` is its half of a project's config bucket. The composer
// stays here because it reads the open project's own bound codes, and the
// package just hands it the fields that opt in.
configureUi({ appPrefix: 'plaid_igt', configNamespace: 'igt', attachCompose });

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Toaster richColors closeButton position="bottom-right" />
    <App />
  </React.StrictMode>,
);
