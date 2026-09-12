import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { PlaidMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { UserButton } from '@ui/components/shared/UserButton';
import { headerItem } from '@ui/components/shared/headerItem.js';
import { adminUrl } from '../domain/siblingApps.js';

// The shell.
export const Layout = () => {
  const { user, logout, getClient } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // The annotation editor wants the full viewport width; every other screen is
  // constrained to a centered container.
  const isAnnotationEditor = location.pathname.includes('/annotate');

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
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
              <UserButton user={user} client={getClient()} onLogout={handleLogout} />
            </div>
          )}
        </div>
      </header>

      <main className="flex-1">
        {/* One container that changes shape, never a `cond ? <Outlet/> :
            <div><Outlet/></div>`. Swapping the element AT this position would
            unmount everything below it when you move into or out of /annotate: 
            which is exactly the remount DocumentEditorShell exists to prevent,
            since the shell renders through this Outlet. */}
        {/* Preflight is global now, so nothing here scopes it. Every screen
            and each migrated one brings its own. */}
        <div className={isAnnotationEditor ? 'w-full' : 'mx-auto max-w-[1320px] px-4 py-8'}>
          <Outlet />
        </div>
      </main>
    </div>
  );
};
