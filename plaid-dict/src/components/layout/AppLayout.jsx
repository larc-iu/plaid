import { Link } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@ui/components/ui/button';
import { PlaidMark } from '@ui/components/assistant/PlaidMarks.jsx';

// The chrome around every screen. The dictionary pages themselves set their own
// wider or narrower measure inside `children`.
export const AppLayout = ({ children }) => {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 font-serif text-lg font-semibold">
            <PlaidMark className="h-[18px] w-[18px] shrink-0" />
            Plaid Dictionary
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {user?.displayName}
            </span>
            <Button variant="ghost" size="sm" onClick={() => logout()}>
              <LogOut className="mr-1.5 h-4 w-4" />
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
};
