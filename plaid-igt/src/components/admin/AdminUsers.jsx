import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MoreVertical, UserPlus } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { DataTable } from '@ui/components/shared/data-table';
import { UserAvatar } from '@ui/components/shared/UserAvatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@ui/components/ui/dropdown-menu';
import { timeAgo, fullTimestamp } from '@ui/lib/formatTime.js';
import { notifyError, humanizeError } from '@/utils/feedback';
import { useUserAdmin } from '@ui/hooks/useUserAdmin.js';
import { UserAdminDialogs } from '@ui/components/shared/UserAdminDialogs.jsx';
import { UserDetail } from './UserDetail';
import { textIncludes } from '@ui/domain/collation.js';

// The whole account directory. The project Access tab resolves one project's
// members; this browses everyone, and opens onto what one person has been
// doing, what they can reach, and what tokens they hold.
//
// The open account lives in the URL beside the tab (`?user=<id>`), so a name
// is a real link: middle-click opens the account in a new tab, and a pasted
// address opens it too. Every other param stays.
const PARAM = 'user';

const withUser = (params, id) => {
  const next = new URLSearchParams(params);
  if (id) next.set(PARAM, id);
  else next.delete(PARAM);
  return { search: next.toString() };
};

export const AdminUsers = ({ client, currentUser }) => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchParams] = useSearchParams();
  const selected = searchParams.get(PARAM);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // The whole directory, then filtered and paged here: a local filter
      // keeps the roster sortable and countable without a round trip per
      // keystroke, and list() follows every cursor so nothing is dropped
      // silently at some page boundary.
      setUsers((await client.users.list()) || []);
    } catch (err) {
      console.error('Error loading users:', err);
      notifyError(humanizeError(err), 'Failed to load the accounts');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const userAdmin = useUserAdmin({ client, currentUser, onChanged: load });

  if (selected) {
    return (
      <UserDetail
        client={client}
        userId={selected}
        backTo={withUser(searchParams, null)}
        onEdit={(u) => userAdmin.startEdit(u)}
        dialogs={<UserAdminDialogs controller={userAdmin} />}
      />
    );
  }

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sort: (u) => (u.displayName || u.id).toLowerCase(),
      render: (u) => (
        <Link to={withUser(searchParams, u.id)} className="flex items-center gap-2 hover:underline">
          <UserAvatar
            client={client}
            userId={u.id}
            displayName={u.displayName}
            avatarHash={u.avatarHash}
            className="h-6 w-6"
          />
          <span className="font-medium">{u.displayName || u.id}</span>
        </Link>
      ),
    },
    {
      key: 'email',
      label: 'Email',
      sort: (u) => u.id.toLowerCase(),
      className: 'text-muted-foreground',
      render: (u) => u.id,
    },
    {
      key: 'status',
      label: 'Status',
      // Admins first, then active, then deactivated, so the column groups the
      // way someone scanning it expects.
      sort: (u) => (u.deactivatedAt ? 2 : u.isAdmin ? 0 : 1),
      render: (u) => (
        <div className="flex items-center gap-1.5">
          {u.isAdmin && <Badge variant="secondary">Admin</Badge>}
          {u.deactivatedAt && (
            <Badge
              variant="outline"
              className="whitespace-nowrap"
              title={`Deactivated ${timeAgo(u.deactivatedAt)} (${fullTimestamp(u.deactivatedAt)})`}
            >
              Deactivated
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      label: '',
      headerClassName: 'w-12',
      render: (u) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Account actions">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link to={withUser(searchParams, u.id)}>Open</Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => userAdmin.startEdit(u)}>Edit user</DropdownMenuItem>
            <DropdownMenuItem
              disabled={userAdmin.resetting}
              onSelect={() => userAdmin.createResetLink(u)}
            >
              Create password reset link
            </DropdownMenuItem>
            {u.deactivatedAt && (
              <DropdownMenuItem onSelect={() => userAdmin.activateUser(u)}>
                Reactivate
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      <DataTable
        rows={users}
        columns={columns}
        rowKey={(u) => u.id}
        id="admin-users"
        defaultSort={{ key: 'name', dir: 'asc' }}
        search={{
          placeholder: 'Search accounts…',
          match: (u, q) => textIncludes(u.id, q) || textIncludes(u.displayName || '', q),
        }}
        noun="account"
        empty="No accounts."
        loading={loading}
        actions={
          <Button size="sm" onClick={userAdmin.openCreate}>
            <UserPlus className="h-4 w-4" /> Create user
          </Button>
        }
      />
      <UserAdminDialogs controller={userAdmin} />
    </>
  );
};
