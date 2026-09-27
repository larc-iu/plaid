import { AppShell } from '@ui/components/shared/AppShell.jsx';
import { UMR_ASSISTANT } from './assistant/adapter.js';
import { keys } from '../lib/keymap.js';

// The app shell, which is plaid-ui's: the header band, the assistant panel and
// its chip and rail, and the one container every screen renders into. What this
// app tells it is which assistant answers here, which keymap a person's own
// bindings lie over, and where its user guide is. It has no destinations of its
// own beside Projects, so its nav is the Guide.
export const Layout = () => (
  <AppShell
    adapter={UMR_ASSISTANT}
    keymap={keys}
    guideHref="https://larc-iu.github.io/plaid/umr-guide.html"
  />
);
