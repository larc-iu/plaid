import { useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { UserButton } from '@ui/components/shared/UserButton';
import { useAuth } from '../../contexts/AuthContext';
import { headerItem } from '@ui/components/shared/headerItem.js';
import { AssistantChrome } from '@ui/components/assistant/AssistantChrome.jsx';
import { PlaidMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { AssistantSubjectProvider } from '@ui/components/assistant/AssistantSubject.jsx';
import { useAskAssistant, useAssistantScope } from '@ui/components/assistant/subject.js';
import { IGT_ASSISTANT } from '../projects/assistant/adapter.js';

// shadcn shell frame, and the one place the assistant panel is mounted.
// Preflight is global now, and the two islands own their CSS and must not
// inherit the scoped preflight reset.
//
// This is a LAYOUT route: it mounts once and the screens swap inside its
// `Outlet`. Every route used to wrap its own copy of this, which meant the
// shell's survival across a navigation was incidental, and a panel living in it
// could not hold a conversation from one screen to the next.
//
// The panel itself, the chip, the rail and the gutter are `AssistantChrome` in
// plaid-ui: plaid-ud's shell mounts the same component. What stays here is what
// is IGT's, which is the window bridge the lit island's "Ask" crosses.

const Shell = () => {
  const { user, client, logout } = useAuth();
  const location = useLocation();
  const subject = useAssistantScope();

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
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
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

  const navItem = (to, label, active) => (
    <Link key={to} to={to} className={headerItem(active)}>
      {label}
    </Link>
  );

  return (
    <AssistantChrome
      adapter={IGT_ASSISTANT}
      client={client}
      user={user}
      subject={subject}
      routeHasProject={/^\/projects\/[^/]+/.test(location.pathname)}
      assistantRoute={
        /^\/projects\/[^/]+\/?$/.test(location.pathname) &&
        new URLSearchParams(location.search).get('tab') === 'assistant'
      }
      className="min-h-screen bg-background text-foreground"
    >
      {({ chip }) => (
        <>
          <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
              <Link to="/projects" className="flex items-center gap-2 font-bold">
                <PlaidMark className="h-[18px] w-[18px] shrink-0" />
                Plaid IGT
              </Link>
              <nav className="flex items-center gap-1">
                {navItem('/projects', 'Projects', location.pathname.startsWith('/projects'))}
                {navItem(
                  '/vocabularies',
                  'Vocabularies',
                  location.pathname.startsWith('/vocabularies'),
                )}
                {/* The user guide is published with the docs site, not bundled here. */}
                <a
                  href="https://larc-iu.github.io/plaid/igt-guide.html"
                  target="_blank"
                  rel="noreferrer"
                  className={headerItem()}
                >
                  Guide
                </a>
              </nav>
              <div className="ml-auto flex items-center gap-2">
                {chip}
                {/* Administration is the server's, not this project's or this
                    screen's, so it sits with the account rather than in the nav
                    beside Projects and Vocabularies. plaid-ud says it in the same
                    place, where it has to be an anchor into this app. */}
                {user?.isAdmin &&
                  navItem('/admin', 'Admin', location.pathname.startsWith('/admin'))}
                {user && (
                  <UserButton
                    user={user}
                    client={client}
                    onLogout={logout}
                    profileHref="/profile"
                  />
                )}
              </div>
            </div>
          </header>
          <main>
            <Outlet />
          </main>
        </>
      )}
    </AssistantChrome>
  );
};

export function AppLayout() {
  return (
    <AssistantSubjectProvider>
      <Shell />
    </AssistantSubjectProvider>
  );
}
