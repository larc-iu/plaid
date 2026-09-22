import { AppShell } from '@ui/components/shared/AppShell.jsx';
import { UD_ASSISTANT } from './assistant/adapter.js';

// The app shell, which is plaid-ui's: the header band, the assistant panel and
// its chip and rail, and the one container every screen renders into. What this
// app tells it is which assistant answers here.
//
// No keymap: this app's chords are hard-coded, by ruling, so there is no table
// for a person's own bindings to lie over.
export const Layout = () => <AppShell adapter={UD_ASSISTANT} keymap={null} />;
