import { useEffect } from 'react';
import { AppShell } from '@ui/components/shared/AppShell.jsx';
import { useAskAssistant } from '@ui/components/assistant/subject.js';
import { IGT_ASSISTANT } from '../projects/assistant/adapter.js';
import { keys } from '@/lib/keymap.js';

// The app shell, which is plaid-ui's, as in plaid-ud and plaid-umr: the header
// band, the assistant panel and its chip and rail, and the one container every
// screen renders into. It is a LAYOUT route: it mounts once and the screens
// swap inside its `Outlet`, which is what lets the panel hold a conversation
// from one screen to the next.
//
// What this app tells it: its assistant and keymap, its own destinations
// (Projects and Vocabularies), its guide, that the admin area is a route here,
// and how to tell that the assistant tab is open. What stays here is what is
// IGT's to do inside the shell, `ShellBridges`.

// Two listeners that draw nothing, mounted inside the shell because the first
// needs its assistant context.
const ShellBridges = () => {
  // What the reader pointed at, as {ref, label}. The interlinear grid is a lit
  // island, so its "Ask" reaches React as a window event, and the shell listens
  // rather than the document screen: the panel lives here now, and Ask has to
  // be able to open it. Past that bridge it is the ordinary channel a React
  // screen uses (`useAskAssistant`), which plaid-ud's editor calls directly.
  const ask = useAskAssistant();
  useEffect(() => {
    const onAsk = (e) => {
      if (e.detail) ask(e.detail);
    };
    window.addEventListener('igt:ask-assistant', onAsk);
    return () => window.removeEventListener('igt:ask-assistant', onAsk);
  }, [ask]);

  // `/` outside a text box focuses the screen's search box (the first
  // SearchInput on it), the web's own key for that. Nothing when the screen
  // has none, and nothing while typing: a slash in a box is a slash.
  useEffect(() => {
    const onSlash = (e) => {
      if (e.isComposing || !keys.is('global.search', e)) return;
      const t = e.target;
      if (t?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName)) return;
      const box = document.querySelector('input[data-search-box]');
      if (!box || box.disabled) return;
      e.preventDefault();
      box.focus();
      box.select();
    };
    document.addEventListener('keydown', onSlash);
    return () => document.removeEventListener('keydown', onSlash);
  }, []);

  return null;
};

// This app's destinations on the left of the band.
const NAV = [
  { to: '/projects', label: 'Projects', match: (path) => path.startsWith('/projects') },
  { to: '/vocabularies', label: 'Vocabularies', match: (path) => path.startsWith('/vocabularies') },
];

// The assistant here is a TAB on the project screen (`?tab=assistant`), not a
// route of its own, so the path alone does not say whether it already has the
// whole screen.
const isAssistantRoute = ({ pathname, search }) =>
  /^\/projects\/[^/]+\/?$/.test(pathname) && new URLSearchParams(search).get('tab') === 'assistant';

export function AppLayout() {
  return (
    <AppShell
      adapter={IGT_ASSISTANT}
      keymap={keys}
      nav={NAV}
      guideHref="https://larc-iu.github.io/plaid/igt-guide.html"
      adminTo="/admin"
      isAssistantRoute={isAssistantRoute}
    >
      <ShellBridges />
    </AppShell>
  );
}
