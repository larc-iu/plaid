import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth.js';
import { appName, appRoutes } from '../../lib/uiConfig.js';
import { PlaidMark } from '../assistant/PlaidMarks.jsx';
import { UserButton } from './UserButton';
import { headerItem } from './headerItem.js';
import { AssistantChrome } from '../assistant/AssistantChrome.jsx';
import { AssistantSubjectProvider } from '../assistant/AssistantSubject.jsx';
import { useAssistantScope } from '../assistant/subject.js';
import { adminUrl } from '../../domain/siblingApps.js';
import { useUserKeymap } from '../../hooks/useUserKeymap.js';

// The app shell, and the one place the assistant panel is mounted.
//
// It is a LAYOUT route, so it mounts once and the screens swap inside its
// Outlet. That is what lets a panel living here hold a conversation from one
// screen to the next: an answer can be read while the reader gets on with
// something else, and a question can span two documents.
//
// The panel itself, the chip, the rail and the gutter are `AssistantChrome`.
// What an app tells this shell is its assistant `adapter` and its `keymap`, if
// it has a rebindable one; the rest it reads from `configureUi` (its name on
// screen, and which of its routes a path is).
const Shell = ({ adapter, keymap }) => {
  const { user, logout, getClient } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // `getClient` throws when nobody is signed in, and this is a layout route:
  // everything below it is guarded, but the shell itself renders first.
  const client = user ? getClient() : null;
  const subject = useAssistantScope();
  // The signed-in person's own shortcuts, over the app's table.
  useUserKeymap(keymap);

  const routes = appRoutes();

  const handleLogout = () => {
    logout();
    navigate(routes.login);
  };

  // A document's tabs want the full viewport width: an annotation grid or a
  // canvas does, and the tab row stays in one place only if every tab has it
  // (each app's editor shell holds the others to a readable width). Every other
  // screen is constrained to a centered container.
  const isDocument = routes.at.document(location.pathname);

  return (
    <AssistantChrome
      adapter={adapter}
      client={client}
      user={user}
      subject={subject}
      routeHasProject={routes.at.project(location.pathname)}
      assistantRoute={routes.at.assistant(location.pathname)}
      className="flex min-h-screen flex-col bg-background text-foreground"
    >
      {({ chip }) => (
        <>
          <header className="border-b bg-background">
            {/* `h-14`, the same band in every app, which is also what the
                assistant panel's own header measures itself against. The band
                has to line up with the container below it. */}
            <div className="mx-auto flex h-14 max-w-[1320px] items-center justify-between px-4">
              <Link to="/" className="flex items-center gap-2 font-bold">
                <PlaidMark className="h-[18px] w-[18px] shrink-0" />
                {appName()}
              </Link>
              {user && (
                <div className="flex items-center gap-2">
                  {chip}
                  {/* The server's admin area is plaid-igt's. The release jar
                      always ships every app on one server, so there is exactly
                      one, and a second here would be a second answer to the
                      same question. A real anchor, not a Link: it is another
                      document. */}
                  {user.isAdmin && (
                    <a href={adminUrl()} className={headerItem()}>
                      Admin
                    </a>
                  )}
                  {/* Profile and Logout are both in here. Two bare text buttons
                      beside the name made the account three controls wide and
                      left Logout one stray click from Profile. */}
                  <UserButton
                    user={user}
                    client={client}
                    onLogout={handleLogout}
                    profileHref={routes.profile}
                  />
                </div>
              )}
            </div>
          </header>

          <main className="flex-1">
            {/* One container that changes shape, never a `cond ? <Outlet/> :
                <div><Outlet/></div>`. Swapping the element AT this position
                would unmount everything below it when you move into or out of a
                document, which is exactly the remount each app's editor shell
                exists to prevent, since the shell renders through this Outlet. */}
            <div className={isDocument ? 'w-full' : 'mx-auto max-w-[1320px] px-4 py-8'}>
              <Outlet />
            </div>
          </main>
        </>
      )}
    </AssistantChrome>
  );
};

export const AppShell = (props) => (
  <AssistantSubjectProvider>
    <Shell {...props} />
  </AssistantSubjectProvider>
);
