import { useCallback, useEffect, useMemo, useState } from 'react';
import { MoreVertical, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SearchInput, ListCount, ListPager } from '@/components/ui/list-search';
import { UserAvatar } from '@/components/shared/UserAvatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { usePagedList } from '@/hooks/usePagedList';
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
  const [search, setSearch] = useState('');
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = q
      ? users.filter(
          (u) => u.id.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q),
        )
      : users;
    return [...rows].sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id));
  }, [users, search]);

  const paged = usePagedList(filtered, { resetKey: search });

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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search accounts…"
          className="max-w-xs"
        />
        <ListCount shown={filtered.length} total={users.length} noun="account" />
        <Button size="sm" className="ml-auto" onClick={userAdmin.openCreate}>
          <UserPlus className="h-4 w-4" /> Create User
        </Button>
      </div>

      <div className="rounded-md border">
        <ListPager {...paged} onPage={paged.setPage} position="top" />
        {loading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No accounts match.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="w-12 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {paged.pageItems.map((u) => (
                <tr key={u.id} className="border-b last:border-0 hover:bg-accent/40">
                  <td className="px-3 py-2">
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
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{u.id}</td>
                  <td className="px-3 py-2">
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
                  </td>
                  <td className="px-3 py-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="Account actions"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setSelected(u.id)}>Open</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => userAdmin.startEdit(u)}>
                          Edit user…
                        </DropdownMenuItem>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ListPager {...paged} onPage={paged.setPage} position="bottom" />
      </div>

      <UserAdminDialogs controller={userAdmin} />
    </div>
  );
};
