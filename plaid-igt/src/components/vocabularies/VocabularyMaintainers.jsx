import { useState, useEffect, useMemo } from 'react';
import { Trash2, AlertTriangle, Search, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { notifySuccess, notifyError } from '@/utils/feedback';

// Mirrors AccessManagement: the full user roster is never fetched (it doesn't
// scale and `GET /users` is admin/project-maintainer-gated — a vocab-only
// maintainer gets a 403). Current maintainers are resolved id-by-id (the
// per-user GET is open to any logged-in caller), and new maintainers come from
// a server-side `?q=` search that degrades gracefully when the caller can't
// browse the directory.
const SEARCH_LIMIT = 25;

export const VocabularyMaintainers = ({
  vocabulary,
  user,
  vocabularyId,
  client,
  onDataUpdate,
}) => {
  const maintainerIds = useMemo(() => vocabulary?.maintainers ?? [], [vocabulary]);

  const [maintainers, setMaintainers] = useState([]); // [{id, username, isAdmin}]
  const [loading, setLoading] = useState(true);
  const [updatingUser, setUpdatingUser] = useState(null);

  // Resolve maintainer ids → user objects (per-id GET is open to all callers,
  // unlike the directory list).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const resolved = await Promise.all(maintainerIds.map((id) =>
          client.users.get(id).catch(() => ({ id, username: id, isAdmin: false }))));
        if (!cancelled) {
          resolved.sort((a, b) => (a.username || '').localeCompare(b.username || ''));
          setMaintainers(resolved);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [maintainerIds, client]);

  // Search-to-add (server-side ?q=).
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchDenied, setSearchDenied] = useState(false); // 403: caller can't browse the directory

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!searchActive) return;
    let cancelled = false;
    (async () => {
      setSearchLoading(true);
      try {
        const page = await client.users.listPage({ q: debouncedSearch || undefined, limit: SEARCH_LIMIT });
        const known = new Set(maintainerIds);
        const results = (page.entries || []).filter((u) => !known.has(u.id));
        if (!cancelled) { setSearchResults(results); setSearchDenied(false); }
      } catch (err) {
        if (!cancelled) {
          setSearchResults([]);
          if (err?.status === 403) setSearchDenied(true);
          else console.error('User search failed:', err);
        }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [debouncedSearch, searchActive, maintainerIds, client]);

  const canManageVocabulary = () => {
    if (!user || !vocabulary) return false;
    return user.isAdmin || vocabulary.maintainers?.includes(user.id);
  };

  const handleAddMaintainer = async (userId) => {
    try {
      setUpdatingUser(userId);
      await client.vocabLayers.addMaintainer(vocabularyId, userId);
      await onDataUpdate();
      setSearch('');
      notifySuccess('User has been added as a maintainer', 'Maintainer added');
    } catch (err) {
      console.error('Error adding maintainer:', err);
      notifyError('Failed to add maintainer', 'Error');
    } finally {
      setUpdatingUser(null);
    }
  };

  const handleRemoveMaintainer = async (userId) => {
    if (userId === user.id) {
      notifyError('You cannot remove yourself as a maintainer of the vocabulary', 'Cannot remove own permissions');
      return;
    }
    try {
      setUpdatingUser(userId);
      await client.vocabLayers.removeMaintainer(vocabularyId, userId);
      await onDataUpdate();
      notifySuccess('User has been removed as a maintainer', 'Maintainer removed');
    } catch (err) {
      console.error('Error removing maintainer:', err);
      notifyError('Failed to remove maintainer', 'Error');
    } finally {
      setUpdatingUser(null);
    }
  };

  if (!canManageVocabulary()) {
    return (
      <div className="tw rounded-md border border-border bg-muted p-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="text-sm">
            <p className="font-medium">Access Denied</p>
            <p className="mt-1 text-muted-foreground">
              You need maintainer permissions to manage vocabulary access.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tw flex flex-col gap-6">
      {/* Current maintainers */}
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h3 className="text-base font-semibold">Maintainers</h3>
          <span className="text-sm text-muted-foreground">{maintainers.length}</span>
        </div>
        <p className="px-4 pt-3 text-sm text-muted-foreground">
          Maintainers can edit vocabulary settings, manage vocabulary items, and control access to this vocabulary.
        </p>
        {loading ? (
          <div className="flex justify-center py-8 text-muted-foreground">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {maintainers.map((m) => (
                <tr key={m.id} className="group border-t">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{m.username}</span>
                      {m.isAdmin && <Badge variant="secondary">Admin</Badge>}
                      {m.id === user.id && <Badge variant="outline">You</Badge>}
                    </div>
                    <span className="text-xs text-muted-foreground">{m.id}</span>
                  </td>
                  <td className="w-12 px-4 py-2 text-right">
                    {m.id !== user.id && (
                      <Button
                        size="icon"
                        variant="destructive"
                        className="h-8 w-8 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={() => handleRemoveMaintainer(m.id)}
                        disabled={updatingUser === m.id}
                        aria-label={`Remove ${m.username}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add a maintainer (server-side search) */}
      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h3 className="text-base font-semibold">Add a maintainer</h3>
        </div>
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search users by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => setSearchActive(true)}
            />
          </div>

          {searchDenied ? (
            <p className="py-1 text-sm text-muted-foreground">
              You don’t have permission to browse the user directory, so you can’t add
              maintainers by search. Ask an administrator (or a project maintainer) to add them.
            </p>
          ) : searchActive && (
            searchLoading ? (
              <div className="flex justify-center py-4 text-muted-foreground">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
              </div>
            ) : searchResults.length === 0 ? (
              <p className="py-1 text-sm text-muted-foreground">
                {debouncedSearch ? 'No matching users.' : 'No other users to add.'}
              </p>
            ) : (
              <div className="flex flex-col">
                {searchResults.map((u, i) => (
                  <div key={u.id} className={`flex items-center justify-between gap-2 py-2 ${i ? 'border-t' : ''}`}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{u.username}</span>
                        {u.isAdmin && <Badge variant="secondary">Admin</Badge>}
                      </div>
                      <span className="block truncate text-xs text-muted-foreground">{u.id}</span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleAddMaintainer(u.id)}
                      disabled={updatingUser === u.id}
                    >
                      <Plus className="h-4 w-4" /> Add
                    </Button>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
};
