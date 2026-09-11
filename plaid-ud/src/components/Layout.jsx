import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Button } from '@ui/components/ui/button';

// The shell. `.tw` is on the header only: every route screen carries its own
// `.tw` root as it migrates, and the Mantine screens below must not inherit the
// scoped preflight reset. See src/index.css.
export const Layout = () => {
  const { user, logout } = useAuth();
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
        <div className="mx-auto flex h-16 max-w-[1320px] items-center justify-between px-4">
          <Link to="/" className="text-xl font-bold">
            Plaid UD
          </Link>
          {user && (
            <nav className="flex items-center gap-1">
              {user.isAdmin && (
                <Button asChild variant="ghost" size="sm">
                  <Link to="/admin/users">Users</Link>
                </Button>
              )}
              {/* Profile is a destination, so it is a real anchor: middle-click
                  and cmd-click open it in a new tab like any link. */}
              <Button asChild variant="ghost" size="sm">
                <Link to="/profile">{user.displayName}</Link>
              </Button>
              <Button variant="ghost" size="sm" onClick={handleLogout}>
                Logout
              </Button>
            </nav>
          )}
        </div>
      </header>

      <main className="flex-1">
        {/* One container that changes shape, never a `cond ? <Outlet/> :
            <div><Outlet/></div>`. Swapping the element AT this position would
            unmount everything below it when you move into or out of /annotate —
            which is exactly the remount DocumentEditorShell exists to prevent,
            since the shell renders through this Outlet. */}
        {/* No `.tw` on this container. Most screens below are still Mantine,
            and each migrated one brings its own. */}
        <div className={isAnnotationEditor ? 'w-full' : 'mx-auto max-w-[1320px] px-4 py-8'}>
          <Outlet />
        </div>
      </main>
    </div>
  );
};
