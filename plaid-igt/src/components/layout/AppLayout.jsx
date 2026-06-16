import { Link, useLocation } from 'react-router-dom';
import { UserButton } from './UserButton';
import { useAuth } from '../../contexts/AuthContext';
import { cn } from '@/lib/utils';

// shadcn shell frame. `.tw` is scoped to the header only — the still-Mantine
// route screens render inside <main> and must NOT inherit the scoped preflight
// reset. Migrated screens add their own `.tw` root.
export function AppLayout({ children }) {
  const { user, logout } = useAuth();
  const location = useLocation();

  const navItem = (to, label, active) => (
    <Link
      key={to}
      to={to}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {label}
    </Link>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="tw sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link to="/projects" className="font-bold">Plaid IGT</Link>
          <nav className="flex items-center gap-1">
            {navItem('/projects', 'Projects', location.pathname.startsWith('/projects'))}
            {navItem('/vocabularies', 'Vocabularies', location.pathname.startsWith('/vocabularies'))}
          </nav>
          <div className="ml-auto">{user && <UserButton user={user} onLogout={logout} />}</div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
