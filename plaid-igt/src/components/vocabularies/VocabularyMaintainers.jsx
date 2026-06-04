import { useState, useMemo } from 'react';
import { UserPlus, Trash2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { notifySuccess, notifyError } from '@/utils/feedback';

export const VocabularyMaintainers = ({
  vocabulary,
  users,
  user,
  vocabularyId,
  client,
  onDataUpdate
}) => {
  const [updatingUser, setUpdatingUser] = useState(null);
  const [hoveredUser, setHoveredUser] = useState(null);

  // Check if user is a maintainer
  const isMaintainer = (userId) => {
    return vocabulary?.maintainers?.includes(userId) || false;
  };

  const handleAddMaintainer = async (userId) => {
    try {
      setUpdatingUser(userId);
      if (!client) {
        throw new Error('Not authenticated');
      }

      await client.vocabLayers.addMaintainer(vocabularyId, userId);

      // Refresh vocabulary data to update permissions
      await onDataUpdate();

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
      if (!client) {
        throw new Error('Not authenticated');
      }

      await client.vocabLayers.removeMaintainer(vocabularyId, userId);

      // Refresh vocabulary data to update permissions
      await onDataUpdate();

      notifySuccess('User has been removed as a maintainer', 'Maintainer removed');
    } catch (err) {
      console.error('Error removing maintainer:', err);
      notifyError('Failed to remove maintainer', 'Error');
    } finally {
      setUpdatingUser(null);
    }
  };

  // Prepare table data - memoized to prevent unnecessary re-renders
  const tableData = useMemo(() => {
    const data = users.map(u => ({
      ...u,
      isMaintainer: isMaintainer(u.id)
    }));

    // Sort by: 1) Admin status (admins first), 2) Maintainer status (maintainers next), 3) Username alphabetically
    data.sort((a, b) => {
      // First sort by admin status (admins first)
      if (a.isAdmin !== b.isAdmin) {
        return b.isAdmin - a.isAdmin;
      }

      // Then sort by maintainer status (maintainers first)
      if (a.isMaintainer !== b.isMaintainer) {
        return b.isMaintainer - a.isMaintainer;
      }

      // Finally sort by username alphabetically
      return a.username.localeCompare(b.username);
    });

    return data;
  }, [users, vocabulary]);

  // Check if current user can manage this vocabulary
  const canManageVocabulary = () => {
    if (!user || !vocabulary) return false;
    return user.isAdmin || vocabulary.maintainers?.includes(user.id);
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
      <div className="rounded-lg border bg-card p-4">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Maintainer Management</h3>
        </div>

        <p className="mb-4 text-sm text-muted-foreground">
          Maintainers can edit vocabulary settings, manage vocabulary items, and control access to this vocabulary.
        </p>

        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left font-medium">User ID</th>
              <th className="px-3 py-2 text-left font-medium">Username</th>
              <th className="px-3 py-2 text-left font-medium">Admin Status</th>
              <th className="px-3 py-2 text-left font-medium">Maintainer Status</th>
            </tr>
          </thead>
          <tbody>
            {tableData.map(record => (
              <tr key={record.id} className="group border-t hover:bg-muted/50">
                <td className="px-3 py-2">
                  <span className="text-muted-foreground">{record.id}</span>
                </td>
                <td className="px-3 py-2">{record.username}</td>
                <td className="px-3 py-2">
                  {record.isAdmin ? (
                    <Badge variant="destructive">Admin</Badge>
                  ) : (
                    <Badge variant="secondary">User</Badge>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div
                    className="flex items-center justify-between gap-2"
                    onMouseEnter={() => setHoveredUser(record.id)}
                    onMouseLeave={() => setHoveredUser(null)}
                  >
                    {record.isMaintainer ? (
                      <>
                        <Badge variant="secondary">Maintainer</Badge>
                        {record.id !== user.id && (
                          <Button
                            size="icon"
                            variant="destructive"
                            className={`h-8 w-8 shrink-0 transition-opacity ${hoveredUser === record.id ? 'opacity-100' : 'opacity-0'}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleRemoveMaintainer(record.id);
                            }}
                            disabled={updatingUser === record.id}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </>
                    ) : (
                      <>
                        {record.isAdmin ? (
                          <Badge variant="destructive">Admin (Full Access)</Badge>
                        ) : (
                          <>
                            <span className="text-sm text-muted-foreground">Not a maintainer</span>
                            <Button
                              size="icon"
                              variant="secondary"
                              className={`h-8 w-8 shrink-0 transition-opacity ${hoveredUser === record.id ? 'opacity-100' : 'opacity-0'}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleAddMaintainer(record.id);
                              }}
                              disabled={updatingUser === record.id}
                            >
                              <UserPlus className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
