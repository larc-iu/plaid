import { useState, useEffect, useMemo } from 'react';
import { Trash2, AlertTriangle, Plus } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { SearchInput, ListHint } from '@ui/components/ui/list-search';
import { UserAvatar } from '@ui/components/shared/UserAvatar';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useUserSearch } from '@/hooks/useUserSearch';
import { UserSearch } from '@/components/shared/UserSearch';

// Current maintainers are resolved id-by-id (the per-user GET is open to any
// logged-in caller); new ones come from the shared directory search.

export const VocabularyMaintainers = ({ vocabulary, user, vocabularyId, client, onDataUpdate }) => {
  const maintainerIds = useMemo(() => vocabulary?.maintainers ?? [], [vocabulary]);

  const [maintainers, setMaintainers] = useState([]); // [{id, displayName, isAdmin}]
  const [loading, setLoading] = useState(true);
  const [updatingUser, setUpdatingUser] = useState(null);

  // Resolve maintainer ids → user objects (per-id GET is open to all callers,
  // unlike the directory list).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const resolved = await Promise.all(
          maintainerIds.map((id) =>
            client.users.get(id).catch(() => ({ id, displayName: id, isAdmin: false })),
          ),
        );
        if (!cancelled) {
          resolved.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
          setMaintainers(resolved);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [maintainerIds, client]);

  const search = useUserSearch({ client, excludeIds: maintainerIds });

  const canManageVocabulary = () => {
    if (!user || !vocabulary) return false;
    return user.isAdmin || vocabulary.maintainers?.includes(user.id);
  };

  const handleAddMaintainer = async (userId) => {
    try {
      setUpdatingUser(userId);
      await client.vocabLayers.addMaintainer(vocabularyId, userId);
      await onDataUpdate();
      search.setQuery('');
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
      notifyError(
        'You cannot remove yourself as a maintainer of the vocabulary',
        'Cannot remove own permissions',
      );
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
      <div className="rounded-md border border-border bg-muted p-3">
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
    <div className="flex flex-col gap-6">
      {/* Current maintainers */}
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h3 className="text-base font-semibold">Maintainers</h3>
          <span className="text-sm text-muted-foreground">{maintainers.length}</span>
        </div>
        <p className="px-4 pt-3 text-sm text-muted-foreground">
          Maintainers can edit vocabulary settings, manage entries, and control access to this
          vocabulary.
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
                      <UserAvatar
                        client={client}
                        userId={m.id}
                        displayName={m.displayName}
                        avatarHash={m.avatarHash}
                        className="h-7 w-7"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{m.displayName}</span>
                          {m.isAdmin && <Badge variant="secondary">Admin</Badge>}
                          {m.id === user.id && <Badge variant="outline">You</Badge>}
                        </div>
                        <span className="text-xs text-muted-foreground">{m.id}</span>
                      </div>
                    </div>
                  </td>
                  <td className="w-12 px-4 py-2 text-right">
                    {m.id !== user.id && (
                      <Button
                        size="icon"
                        variant="destructive"
                        className="h-8 w-8 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={() => handleRemoveMaintainer(m.id)}
                        disabled={updatingUser === m.id}
                        aria-label={`Remove ${m.displayName}`}
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
        <div className="px-4 py-3">
          <UserSearch
            client={client}
            search={search}
            renderAction={(u) => (
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleAddMaintainer(u.id)}
                disabled={updatingUser === u.id}
              >
                <Plus className="h-4 w-4" /> Add
              </Button>
            )}
          />
        </div>
      </div>
    </div>
  );
};
