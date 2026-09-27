import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from '@ui/components/ui/sonner';
import { configureUi } from '@ui/lib/uiConfig.js';
import { configureAuth, onSignOut } from '@ui/services/auth.js';
import { attachCompose } from '@/lib/composeInput.js';
import { forgetPrecedent } from '@/domain/precedentCache.js';
import { forgetAllLeftovers } from '@/domain/leftoverEntries.js';
import { APP_ROUTES } from './appRoutes.js';
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
configureUi({
  appPrefix: 'plaid_igt',
  configNamespace: 'igt',
  appName: 'Plaid IGT',
  attachCompose,
  appRoutes: APP_ROUTES,
});

// Where a signed-out session lands. The app's routing table is the app's.
configureAuth({ loginRoute: '#/login' });

// The precedent counts a tab keeps in the browser hold this login's word
// forms and values, so signing out forgets them.
onSignOut(forgetPrecedent);
// So do the entries a failed "+ Create" left behind, which are this login's
// (leftoverEntries.js). The page reloads on this tab's sign-out, but a tab
// told of a sign-out elsewhere stays.
onSignOut(forgetAllLeftovers);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Toaster richColors closeButton position="bottom-right" />
    <App />
  </React.StrictMode>,
);
