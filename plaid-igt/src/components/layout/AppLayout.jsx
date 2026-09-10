import { Link, useLocation } from 'react-router-dom';
import { UserButton } from './UserButton';
import { useAuth } from '../../contexts/AuthContext';
import { cn } from '@/lib/utils';

// shadcn shell frame. `.tw` is scoped to the header only: each route screen
// adds its own `.tw` root, and the two islands own their CSS and must not
// inherit the scoped preflight reset.
export function AppLayout({ children }) {
  const { user, client, logout } = useAuth();
  const location = useLocation();

  const navItem = (to, label, active) => (
    <Link
      key={to}
      to={to}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {label}
    </Link>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link to="/projects" className="font-bold">
            Plaid IGT
          </Link>
          <nav className="flex items-center gap-1">
            {navItem('/projects', 'Projects', location.pathname.startsWith('/projects'))}
            {navItem(
              '/vocabularies',
              'Vocabularies',
              location.pathname.startsWith('/vocabularies'),
            )}
            {user?.isAdmin && navItem('/admin', 'Admin', location.pathname.startsWith('/admin'))}
            {/* The user guide is published with the docs site, not bundled here. */}
            <a
              href="https://larc-iu.github.io/plaid/igt-guide.html"
              target="_blank"
              rel="noreferrer"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              Guide
            </a>
          </nav>
          <div className="ml-auto">
            {user && <UserButton user={user} client={client} onLogout={logout} />}
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
