import { useState, useEffect, useCallback } from 'react';
import {
  Title, Text, Button, Alert, Paper, Stack, Group, Center, Loader, Table, Badge,
  Modal, TextInput, PasswordInput, Checkbox,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { useAuth } from '../../contexts/AuthContext';
import { confirmDelete, notifySuccess, notifyError } from '../../utils/feedback.jsx';
import classes from '../common/listRow.module.css';

const PAGE_SIZE = 100;
const EMPTY_USER_FORM = { username: '', password: '', confirmPassword: '', isAdmin: false };

// Instance-wide user administration (admin only). Unlike ProjectManagement —
// which resolves a single project's ACL — this browses the whole directory via
// the server-side `?q=` search and offers create / edit / deactivate /
// reactivate. Deactivation is a soft-delete (client.users.delete); the user
// stays in listings with a `deactivatedAt` timestamp and is reversible.
export const AdminUsers = () => {
  const { user, getClient } = useAuth();
  const isAdmin = user?.isAdmin || false;

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);                  // 0-indexed current page
  const [cursors, setCursors] = useState([undefined]);  // cursors[i] = keyset cursor that fetches page i (page 0 → none)
  const [nextCursor, setNextCursor] = useState(null);   // cursor for the page after this one, or null at the end

  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 250);

  // Create-user form state
  const [showCreateUserForm, setShowCreateUserForm] = useState(false);
  const [newUserForm, setNewUserForm] = useState(EMPTY_USER_FORM);
  const [createUserError, setCreateUserError] = useState('');
  const [createUserLoading, setCreateUserLoading] = useState(false);

  // Edit-user form state
  const [editingUser, setEditingUser] = useState(null);
  const [editUserForm, setEditUserForm] = useState(EMPTY_USER_FORM);
  const [editUserError, setEditUserError] = useState('');
  const [editUserLoading, setEditUserLoading] = useState(false);

  // Fetch one page. `cursor` is the keyset cursor for `pageIndex` (undefined for
  // the first page); the response carries this page's rows plus the cursor for
  // the next page (null when there are no more).
  const fetchPage = useCallback(async (pageIndex, cursor) => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const client = getClient();
      const resp = await client.users.listPage({
        q: debouncedSearch || undefined, limit: PAGE_SIZE, cursor: cursor || undefined,
      });
      setUsers(resp.entries || []);
      setNextCursor(resp.nextCursor || null);
      setPage(pageIndex);
    } catch (err) {
      console.error('Failed to load users:', err);
      notifyError('Failed to load users');
      setUsers([]);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, [isAdmin, debouncedSearch, getClient]);

  // (Re)start at the first page on mount and whenever the search changes.
  useEffect(() => {
    setCursors([undefined]);
    fetchPage(0, undefined);
  }, [fetchPage]);

  const goNext = () => {
    if (!nextCursor || loading) return;
    setCursors(prev => {
      const copy = prev.slice(0, page + 1);
      copy[page + 1] = nextCursor;
      return copy;
    });
    fetchPage(page + 1, nextCursor);
  };

  const goPrev = () => {
    if (page === 0 || loading) return;
    fetchPage(page - 1, cursors[page - 1]);
  };

  // Reload the current page in place (after a create / edit / (de)activate).
  const reload = () => fetchPage(page, cursors[page]);

  const handleCreateUser = async (e) => {
    e.preventDefault();
    setCreateUserError('');

    if (newUserForm.password !== newUserForm.confirmPassword) {
      setCreateUserError('Passwords do not match');
      return;
    }
    if (newUserForm.password.length < 6) {
      setCreateUserError('Password must be at least 6 characters long');
      return;
    }

    setCreateUserLoading(true);
    try {
      await getClient().users.create(newUserForm.username, newUserForm.password, newUserForm.isAdmin);
      notifySuccess('User created successfully');
      setShowCreateUserForm(false);
      setNewUserForm(EMPTY_USER_FORM);
      await reload();
    } catch (err) {
      console.error('Error creating user:', err);
      if (err.status === 409 || (err.message && err.message.includes('409'))) {
        setCreateUserError(`A user with the ID "${newUserForm.username}" already exists. Please choose a different user ID.`);
      } else {
        setCreateUserError('Failed to create user: ' + (err.message || 'Unknown error'));
      }
    } finally {
      setCreateUserLoading(false);
    }
  };

  const startEditingUser = (userToEdit) => {
    setEditUserError('');
    setEditingUser(userToEdit);
    setEditUserForm({
      username: userToEdit.username,
      password: '',
      confirmPassword: '',
      isAdmin: userToEdit.isAdmin || false,
    });
  };

  const handleUpdateUser = async (e) => {
    e.preventDefault();
    setEditUserError('');

    if (editUserForm.password && editUserForm.password !== editUserForm.confirmPassword) {
      setEditUserError('Passwords do not match');
      return;
    }
    if (editUserForm.password && editUserForm.password.length < 6) {
      setEditUserError('Password must be at least 6 characters long');
      return;
    }

    setEditUserLoading(true);
    try {
      const newUsername = editUserForm.username !== editingUser.username ? editUserForm.username : undefined;
      const newPassword = editUserForm.password || undefined;
      const newIsAdmin = editUserForm.isAdmin !== (editingUser.isAdmin || false) ? editUserForm.isAdmin : undefined;

      await getClient().users.update(editingUser.id, newPassword, newUsername, newIsAdmin);
      notifySuccess('User updated successfully');
      setEditingUser(null);
      setEditUserForm(EMPTY_USER_FORM);
      await reload();
    } catch (err) {
      console.error('Error updating user:', err);
      setEditUserError('Failed to update user: ' + (err.message || 'Unknown error'));
    } finally {
      setEditUserLoading(false);
    }
  };

  const handleDeactivate = (target) => {
    confirmDelete({
      title: 'Deactivate user',
      message: `Deactivate "${target.username}"? They will be unable to log in, and their project memberships, vocab maintainerships, and API tokens will be revoked. This is reversible by reactivating, but those grants are not restored automatically.`,
      confirmLabel: 'Deactivate',
      onConfirm: async () => {
        try {
          await getClient().users.delete(target.id);
          notifySuccess('User deactivated');
          setEditingUser(null);
          await reload();
        } catch (err) {
          console.error('Error deactivating user:', err);
          notifyError('Failed to deactivate user: ' + (err.message || 'Unknown error'));
        }
      },
    });
  };

  const handleReactivate = async (target) => {
    try {
      await getClient().users.activate(target.id);
      notifySuccess('User reactivated');
      setEditingUser(null);
      await reload();
    } catch (err) {
      console.error('Error reactivating user:', err);
      notifyError('Failed to reactivate user: ' + (err.message || 'Unknown error'));
    }
  };

  if (!isAdmin) {
    return <Alert color="red">You don't have permission to manage users.</Alert>;
  }

  return (
    <>
      <Group justify="space-between" align="flex-end" mb="lg">
        <Stack gap={2}>
          <Title order={2}>User Administration</Title>
          <Text c="dimmed">Create, edit, and deactivate user accounts across the instance.</Text>
        </Stack>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => { setNewUserForm(EMPTY_USER_FORM); setShowCreateUserForm(true); setCreateUserError(''); }}
        >
          Create User
        </Button>
      </Group>

      <Paper withBorder radius="md">
        <Group px="lg" py="md" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
          <TextInput
            leftSection={<IconSearch size={16} />}
            placeholder="Search users by name…"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
        </Group>

        {loading ? (
          <Center py="xl"><Loader size="sm" /></Center>
        ) : users.length === 0 ? (
          <Text px="lg" py="md" size="sm" c="dimmed">
            {debouncedSearch ? 'No matching users.' : 'No users found.'}
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={520}>
            <Table verticalSpacing={6} horizontalSpacing="lg">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>User</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {users.map(u => {
                  const isSelf = u.id === user.id;
                  const deactivated = !!u.deactivatedAt;
                  return (
                    <Table.Tr
                      key={u.id}
                      className={classes.row}
                      style={deactivated ? { opacity: 0.6 } : undefined}
                      onClick={() => startEditingUser(u)}
                    >
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          <Text size="sm" fw={500}>{u.username}</Text>
                          {u.isAdmin && <Badge size="xs" color="grape" variant="light">Admin</Badge>}
                          {isSelf && <Badge size="xs" color="blue" variant="light">You</Badge>}
                        </Group>
                        <Text size="xs" c="dimmed">ID: {u.id}</Text>
                      </Table.Td>
                      <Table.Td>
                        {deactivated
                          ? <Badge size="sm" color="red" variant="light">Deactivated</Badge>
                          : <Badge size="sm" color="green" variant="light">Active</Badge>}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}

        {(page > 0 || nextCursor) && (
          <Group justify="space-between" px="lg" py="sm" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
            <Button variant="default" size="xs" disabled={page === 0 || loading} onClick={goPrev}>
              Previous
            </Button>
            <Text size="sm" c="dimmed">Page {page + 1}</Text>
            <Button variant="default" size="xs" disabled={!nextCursor || loading} onClick={goNext}>
              Next
            </Button>
          </Group>
        )}
      </Paper>

      {/* Create User Modal */}
      <Modal
        opened={showCreateUserForm}
        onClose={() => { setShowCreateUserForm(false); setCreateUserError(''); }}
        title="Create New User"
        centered
      >
        <form onSubmit={handleCreateUser}>
          <Stack gap="md">
            {createUserError && <Alert color="red">{createUserError}</Alert>}

            <TextInput
              label="User ID"
              description="Unique identifier for this user (cannot be changed later)"
              placeholder="e.g., john.doe"
              value={newUserForm.username}
              onChange={(e) => setNewUserForm(prev => ({ ...prev, username: e.target.value }))}
              required
              data-autofocus
            />

            <Checkbox
              label="Admin User"
              checked={newUserForm.isAdmin}
              onChange={(e) => setNewUserForm(prev => ({ ...prev, isAdmin: e.currentTarget.checked }))}
            />

            <PasswordInput
              label="Password"
              value={newUserForm.password}
              onChange={(e) => setNewUserForm(prev => ({ ...prev, password: e.target.value }))}
              required
            />

            <PasswordInput
              label="Confirm Password"
              value={newUserForm.confirmPassword}
              onChange={(e) => setNewUserForm(prev => ({ ...prev, confirmPassword: e.target.value }))}
              required
            />

            <Group justify="flex-end">
              <Button type="submit" color="green" loading={createUserLoading}>
                Create User
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      {/* Edit User Modal */}
      <Modal
        opened={!!editingUser}
        onClose={() => setEditingUser(null)}
        title={editingUser ? `Edit User: ${editingUser.username}` : ''}
        centered
      >
        {editingUser && (
          <form onSubmit={handleUpdateUser}>
            <Stack gap="md">
              {editUserError && <Alert color="red">{editUserError}</Alert>}

              <TextInput
                label="Username"
                value={editUserForm.username}
                onChange={(e) => setEditUserForm(prev => ({ ...prev, username: e.target.value }))}
                required
                data-autofocus
              />

              <Checkbox
                label="Admin User"
                checked={editUserForm.isAdmin}
                disabled={editingUser.id === user.id}
                description={editingUser.id === user.id ? 'You cannot change your own admin status' : undefined}
                onChange={(e) => setEditUserForm(prev => ({ ...prev, isAdmin: e.currentTarget.checked }))}
              />

              <PasswordInput
                label="New Password (leave blank to keep current)"
                value={editUserForm.password}
                onChange={(e) => setEditUserForm(prev => ({ ...prev, password: e.target.value }))}
              />

              <PasswordInput
                label="Confirm New Password"
                value={editUserForm.confirmPassword}
                onChange={(e) => setEditUserForm(prev => ({ ...prev, confirmPassword: e.target.value }))}
              />

              <Group justify="space-between" pt="xs">
                {editingUser.deactivatedAt ? (
                  <Button type="button" variant="subtle" color="green" onClick={() => handleReactivate(editingUser)}>
                    Reactivate
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="subtle"
                    color="red"
                    disabled={editingUser.id === user.id}
                    onClick={() => handleDeactivate(editingUser)}
                  >
                    Deactivate
                  </Button>
                )}
                <Group gap="sm">
                  <Button type="button" variant="default" onClick={() => setEditingUser(null)}>
                    Cancel
                  </Button>
                  <Button type="submit" loading={editUserLoading}>Update User</Button>
                </Group>
              </Group>
            </Stack>
          </form>
        )}
      </Modal>
    </>
  );
};
