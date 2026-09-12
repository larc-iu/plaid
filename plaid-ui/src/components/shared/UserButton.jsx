import { Link } from 'react-router-dom';
import { User, LogOut } from 'lucide-react';
import { UserAvatar } from './UserAvatar.jsx';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu.jsx';

// The account in the header band: who is signed in, and everything about
// being signed in. Logout lives in here rather than beside it, so the band
// carries one control for the account instead of two, and the one thing in it
// that cannot be undone is not a click away from a link.
export function UserButton({ user, client, onLogout }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <UserAvatar
          client={client}
          userId={user.id}
          displayName={user.displayName}
          avatarHash={user.avatarHash}
          className="h-7 w-7"
        />
        <span className="text-sm font-medium">{user.displayName}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Account</DropdownMenuLabel>
        {/* A real anchor, not an onClick: Profile is a destination, so
            middle-click and cmd-click open it in a new tab like any link. */}
        <DropdownMenuItem asChild>
          <Link to="/profile">
            <User className="h-4 w-4" /> Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* `() => onLogout()` and not `onLogout`: plaid-igt's takes an optional
            reason to show on the login page, and the click event went in as
            one. */}
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => onLogout()}
        >
          <LogOut className="h-4 w-4" /> Logout
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
