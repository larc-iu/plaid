import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth.js';
import { appName, appRoutes } from '../../lib/uiConfig.js';
import { LIST_PAGE_WIDTH } from '../../lib/pageWidth.js';
import { cn } from '../../lib/utils.js';
import { PlaidMark } from '../assistant/PlaidMarks.jsx';
import { UserButton } from './UserButton';
import { headerItem } from './headerItem.js';
import { AssistantChrome } from '../assistant/AssistantChrome.jsx';
import { AssistantSubjectProvider } from '../assistant/AssistantSubject.jsx';
import { useAssistantScope } from '../assistant/subject.js';
import { adminUrl } from '../../domain/siblingApps.js';
import { useUserKeymap } from '../../hooks/useUserKeymap.js';
import { useUnsavedGuard } from '../../hooks/useUnsavedDraft.js';

// The app shell, and the one place the assistant panel is mounted.
//
// It is a LAYOUT route, so it mounts once and the screens swap inside its
// Outlet. That is what lets a panel living here hold a conversation from one
// screen to the next: an answer can be read while the reader gets on with
// something else, and a question can span two documents.
//
// The panel itself, the chip, the rail and the gutter are `AssistantChrome`.
// What an app tells this shell:
// - `adapter`, its assistant, and `keymap`, if it has a rebindable one.
// - `nav`, its own destinations on the left of the band, as
//   `[{ to, label, match }]`, where `match(pathname)` says the item is where the
//   reader is. Empty for an app with none.
// - `guideHref`, its user guide on the docs site, drawn last in the nav.
// - `adminTo`, where the admin area is when it is a route of THIS app (a
//   `Link`). Without it, Admin is a full page load into the app that has one.
// - `isAssistantRoute(location)`, for an app whose assistant is not a route of
//   its own (plaid-igt's is a `?tab=`), so the path alone cannot say.
// - `children`, parts of the app that draw nothing but need the shell's
//   context (plaid-igt's bridge from the lit island's "Ask").
// The rest it reads from `configureUi` (its name on screen, and which of its
// routes a path is).
const Shell = ({ adapter, keymap, nav = [], guideHref, adminTo, isAssistantRoute, children }) => {
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

  // Signing out takes the screen underneath with it, so it is a way out like
  // any other: the text typed on the screen below is asked about first.
  const guardLeaving = useUnsavedGuard();

  const handleLogout = async () => {
    if (!(await guardLeaving())) return;
    logout();
    navigate(routes.login);
  };

  // A document's tabs want the full viewport width: an annotation grid or a
  // canvas does, and the tab row stays in one place only if every tab has it
  // (each app's editor shell holds the others to a readable width). Every other
  // screen is constrained to a centered container, as wide as a list is. A
  // settings page or a form holds itself to the narrower width inside it, from
  // its left edge, so the page's left edge does not move between tabs.
  const path = location.pathname;
  const isDocument = routes.at.document(path);
  const assistantRoute = isAssistantRoute ? isAssistantRoute(location) : routes.at.assistant(path);

  return (
    <AssistantChrome
      adapter={adapter}
      client={client}
      user={user}
      subject={subject}
      routeHasProject={routes.at.project(path)}
      assistantRoute={assistantRoute}
      className="flex min-h-screen flex-col bg-background text-foreground"
    >
      {({ chip }) => (
        <>
          {children}
          {/* Sticky in every app: the band is how a reader leaves a long
              document, and plaid-igt's document bar sits right under it. The
              assistant dock is fixed at z-30, below this. */}
          <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
            {/* `h-14`, the same band in every app, which is also what the
                assistant panel's own header measures itself against. The band
                has to line up with the container below it. One row at every
                width: on a phone the name leaves only the mark, and the nav
                scrolls sideways in the room left beside the account. */}
            <div
              className={cn('mx-auto flex h-14 items-center gap-2 px-4 sm:gap-4', LIST_PAGE_WIDTH)}
            >
              <Link to={routes.projects} className="flex shrink-0 items-center gap-2 font-bold">
                <PlaidMark className="h-[18px] w-[18px] shrink-0" />
                <span className="sr-only sm:not-sr-only">{appName()}</span>
              </Link>
              {(nav.length > 0 || guideHref) && (
                <nav className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
                  {nav.map(({ to, label, match }) => (
                    <Link key={to} to={to} className={headerItem(!!match?.(path))}>
                      {label}
                    </Link>
                  ))}
                  {/* The user guide is published with the docs site, not
                      bundled with the app. */}
                  {guideHref && (
                    <a href={guideHref} target="_blank" rel="noreferrer" className={headerItem()}>
                      Guide
                    </a>
                  )}
                </nav>
              )}
              {user && (
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {chip}
                  {/* The server's admin area is plaid-igt's. The release jar
                      always ships every app on one server, so there is exactly
                      one, and a second here would be a second answer to the
                      same question. From another app it is a real anchor, not
                      a Link: it is another document. Administration is the
                      server's, not this project's or this screen's, so it sits
                      with the account rather than in the nav. */}
                  {user.isAdmin &&
                    (adminTo ? (
                      <Link to={adminTo} className={headerItem(path.startsWith(adminTo))}>
                        Admin
                      </Link>
                    ) : (
                      <a href={adminUrl()} className={headerItem()}>
                        Admin
                      </a>
                    ))}
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
            <div className={isDocument ? 'w-full' : cn('mx-auto px-4 py-8', LIST_PAGE_WIDTH)}>
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
