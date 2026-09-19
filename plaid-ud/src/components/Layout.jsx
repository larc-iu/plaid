import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { PlaidMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { UserButton } from '@ui/components/shared/UserButton';
import { headerItem } from '@ui/components/shared/headerItem.js';
import { AssistantChrome } from '@ui/components/assistant/AssistantChrome.jsx';
import { AssistantSubjectProvider } from '@ui/components/assistant/AssistantSubject.jsx';
import { useAssistantScope } from '@ui/components/assistant/subject.js';
import { UD_ASSISTANT } from './assistant/adapter.js';
import { adminUrl } from '@ui/domain/siblingApps.js';

// The shell, and the one place the assistant panel is mounted.
//
// It is already a LAYOUT route (App.jsx), so it mounts once and the screens
// swap inside its `Outlet`. That is what lets a panel living here hold a
// conversation from one screen to the next, which is the whole point of moving
// it off the annotation editor: an answer can be read while the reader gets on
// with something else, and a question can span two documents.
//
// The panel itself, the chip, the rail and the gutter are `AssistantChrome` in
// plaid-ui, which plaid-igt's shell mounts too. UD's screens publish their
// subject from TWO places: ProjectTabs for the project's own screens and
// DocumentEditorShell for a document.
const Shell = () => {
  const { user, logout, getClient } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // `getClient` throws when nobody is signed in, and this is a layout route:
  // everything below it is guarded, but the shell itself renders first.
  const client = user ? getClient() : null;
  const subject = useAssistantScope();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // A document's tabs want the full viewport width: the annotation editor's
  // grid does, and the tab row stays in one place only if every tab has it
  // (DocumentEditorShell holds the others to a readable width). Every other
  // screen is constrained to a centered container.
  const isDocument = /^\/projects\/[^/]+\/documents\/[^/]+/.test(location.pathname);

  return (
    <AssistantChrome
      adapter={UD_ASSISTANT}
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
            {/* `h-14`, the same band as plaid-igt's, which is also what the
                assistant panel's own header measures itself against. The width is
                this app's own: the band has to line up with the container below
                it, and plaid-ud's screens are wider. */}
            <div className="mx-auto flex h-14 max-w-[1320px] items-center justify-between px-4">
              <Link to="/" className="flex items-center gap-2 font-bold">
                <PlaidMark className="h-[18px] w-[18px] shrink-0" />
                Plaid UD
              </Link>
              {user && (
                <div className="flex items-center gap-2">
                  {chip}
                  {/* The server's admin area is plaid-igt's. The release jar always
                      ships both apps on one server, so there is exactly one, and a
                      second here would be a second answer to the same question.
                      A real anchor, not a Link: it is another document. */}
                  {user.isAdmin && (
                    <a href={adminUrl()} className={headerItem()}>
                      Admin
                    </a>
                  )}
                  {/* Profile and Logout are both in here now. Two bare text
                      buttons beside the name made the account three controls wide
                      and left Logout one stray click from Profile. */}
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
            {/* One container that changes shape, never a `cond ? <Outlet/> :
                <div><Outlet/></div>`. Swapping the element AT this position would
                unmount everything below it when you move into or out of a document:
                which is exactly the remount DocumentEditorShell exists to prevent,
                since the shell renders through this Outlet. */}
            {/* Preflight is global now, so nothing here scopes it. Every screen
                and each migrated one brings its own. */}
            <div className={isDocument ? 'w-full' : 'mx-auto max-w-[1320px] px-4 py-8'}>
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
