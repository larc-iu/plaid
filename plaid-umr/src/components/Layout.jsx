import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { PlaidMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { UserButton } from '@ui/components/shared/UserButton';
import { headerItem } from '@ui/components/shared/headerItem.js';
import { adminUrl } from '@ui/domain/siblingApps.js';
import { useUserKeymap } from '@ui/hooks/useUserKeymap.js';
import { keys } from '../lib/keymap.js';

// The shell. A LAYOUT route (App.jsx), so it mounts once and the screens swap
// inside its Outlet. The assistant panel will be mounted here when the UMR
// assistant lands, the way plaid-ud's and plaid-igt's shells mount it.
export const Layout = () => {
  const { user, logout, getClient } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // `getClient` throws when nobody is signed in, and this is a layout route:
  // everything below it is guarded, but the shell itself renders first.
  const client = user ? getClient() : null;
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
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-[1320px] items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-bold">
            <PlaidMark className="h-[18px] w-[18px] shrink-0" />
            Plaid UMR
          </Link>
          {user && (
            <div className="flex items-center gap-2">
              {/* The server's admin area is plaid-igt's. A real anchor, not a
                  Link: it is another document. */}
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
        {/* One container that changes shape, never a swapped element: swapping
            at this position would unmount everything below it when moving into
            or out of /annotate, which is the remount DocumentEditorShell exists
            to prevent. */}
        <div className={isAnnotationEditor ? 'w-full' : 'mx-auto max-w-[1320px] px-4 py-8'}>
          <Outlet />
        </div>
      </main>
    </div>
  );
};
