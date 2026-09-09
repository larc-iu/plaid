import { useCallback, useEffect, useState } from 'react';
import { MoreVertical, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/ui/data-table';
import { UserAvatar } from '@/components/shared/UserAvatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';
import { notifyError } from '@/utils/feedback';
import { useUserAdmin, UserAdminDialogs } from './userAdmin';
import { UserDetail } from './UserDetail';

// The whole account directory. The project Access tab resolves one project's
// members; this browses everyone, and opens onto what one person has been
// doing, what they can reach, and what tokens they hold.

export const AdminUsers = ({ client, currentUser }) => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

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
      notifyError(err.message || 'Failed to load users', 'Error');
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
        onBack={() => setSelected(null)}
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
        <button
          type="button"
          className="flex items-center gap-2 text-left hover:underline"
          onClick={() => setSelected(u.id)}
        >
          <UserAvatar
            client={client}
            userId={u.id}
            displayName={u.displayName}
            avatarHash={u.avatarHash}
            className="h-6 w-6"
          />
          <span className="font-medium">{u.displayName || u.id}</span>
        </button>
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
              title={`Deactivated ${timeAgo(u.deactivatedAt)} — ${fullTimestamp(u.deactivatedAt)}`}
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
            <DropdownMenuItem onSelect={() => setSelected(u.id)}>Open</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => userAdmin.startEdit(u)}>Edit user…</DropdownMenuItem>
            <DropdownMenuItem
              disabled={userAdmin.resetting}
              onSelect={() => userAdmin.createResetLink(u)}
            >
              Create password reset link…
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
          match: (u, q) =>
            u.id.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q),
        }}
        noun="account"
        empty="No accounts."
        loading={loading}
        actions={
          <Button size="sm" onClick={userAdmin.openCreate}>
            <UserPlus className="h-4 w-4" /> Create User
          </Button>
        }
      />
      <UserAdminDialogs controller={userAdmin} />
    </>
  );
};
