import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { PlaidMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { UserButton } from '@ui/components/shared/UserButton';
import { headerItem } from '@ui/components/shared/headerItem.js';
import { AssistantChrome } from '@ui/components/assistant/AssistantChrome.jsx';
import { AssistantSubjectProvider } from '@ui/components/assistant/AssistantSubject.jsx';
import { useAssistantScope } from '@ui/components/assistant/subject.js';
import { adminUrl } from '@ui/domain/siblingApps.js';
import { useUserKeymap } from '@ui/hooks/useUserKeymap.js';
import { keys } from '../lib/keymap.js';
import { UMR_ASSISTANT } from './assistant/adapter.js';

// The shell, and the one place the assistant panel is mounted.
//
// It is already a LAYOUT route (App.jsx), so it mounts once and the screens
// swap inside its Outlet. That is what lets a panel living here hold a
// conversation from one screen to the next: an answer can be read while the
// reader gets on with something else, and a question can span two documents.
//
// The panel itself, the chip, the rail and the gutter are `AssistantChrome` in
// plaid-ui, which plaid-ud's and plaid-igt's shells mount too. UMR's screens
// publish their subject from TWO places: ProjectTabs for the project's own
// screens and DocumentEditorShell for a document.
const Shell = () => {
  const { user, logout, getClient } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // `getClient` throws when nobody is signed in, and this is a layout route:
  // everything below it is guarded, but the shell itself renders first.
  const client = user ? getClient() : null;
  const subject = useAssistantScope();
  // The signed-in person's own shortcuts, over the app's table.
  useUserKeymap(keys);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // The annotation editor wants the full viewport width. Every other screen
  // is constrained to a centered container.
  const isAnnotationEditor = location.pathname.includes('/annotate');

  return (
    <AssistantChrome
      adapter={UMR_ASSISTANT}
      client={client}
      user={user}
      subject={subject}
      routeHasProject={/^\/projects\/[^/]+/.test(location.pathname)}
      assistantRoute={/^\/projects\/[^/]+\/assistant\/?$/.test(location.pathname)}
      className="flex min-h-screen flex-col bg-background text-foreground"
    >
      {({ chip }) => (
        <>
          <header className="border-b bg-background">
            <div className="mx-auto flex h-14 max-w-[1320px] items-center justify-between px-4">
              <Link to="/" className="flex items-center gap-2 font-bold">
                <PlaidMark className="h-[18px] w-[18px] shrink-0" />
                Plaid UMR
              </Link>
              {user && (
                <div className="flex items-center gap-2">
                  {chip}
                  {/* The server's admin area is plaid-igt's. A real anchor, not
                      a Link: it is another document. */}
                  {user.isAdmin && (
                    <a href={adminUrl()} className={headerItem()}>
                      Admin
                    </a>
                  )}
                  <UserButton
                    user={user}
                    client={client}
                    onLogout={handleLogout}
                    profileHref="/profile"
                  />
                </div>
              )}
            </div>
          </header>

          <main className="flex-1">
            {/* One container that changes shape, never a swapped element:
                swapping at this position would unmount everything below it when
                moving into or out of /annotate, which is the remount
                DocumentEditorShell exists to prevent. */}
            <div className={isAnnotationEditor ? 'w-full' : 'mx-auto max-w-[1320px] px-4 py-8'}>
              <Outlet />
            </div>
          </main>
        </>
      )}
    </AssistantChrome>
  );
};

export const Layout = () => (
  <AssistantSubjectProvider>
    <Shell />
  </AssistantSubjectProvider>
);
