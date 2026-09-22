import { AppShell } from '@ui/components/shared/AppShell.jsx';
import { UMR_ASSISTANT } from './assistant/adapter.js';
import { keys } from '../lib/keymap.js';

// The app shell, which is plaid-ui's: the header band, the assistant panel and
// its chip and rail, and the one container every screen renders into. What this
// app tells it is which assistant answers here, and which keymap a person's own
// bindings lie over.
export const Layout = () => <AppShell adapter={UMR_ASSISTANT} keymap={keys} />;
