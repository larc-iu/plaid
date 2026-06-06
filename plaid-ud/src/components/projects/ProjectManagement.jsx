import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Title, Text, Button, Alert, Paper, Stack, Group, Center, Loader, Table, Badge,
  Select, Modal, TextInput, PasswordInput, Checkbox, Breadcrumbs, Anchor, Code,
  Menu, ActionIcon,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconPlus, IconSearch, IconDotsVertical } from '@tabler/icons-react';
import { useAuth } from '../../contexts/AuthContext';
import { confirmDelete, notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { canManageProject } from '../../utils/permissions.js';

const PERMISSION_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'reader', label: 'Reader' },
  { value: 'writer', label: 'Writer' },
  { value: 'maintainer', label: 'Maintainer' },
];
const GRANT_ROLES = ['reader', 'writer', 'maintainer'];
const SEARCH_LIMIT = 25;

const EMPTY_USER_FORM = { username: '', password: '', confirmPassword: '', isAdmin: false };

// Role a given user holds on a project, from the project's ACL arrays.
const roleOf = (project, userId) => {
  if (project?.maintainers?.includes(userId)) return 'maintainer';
  if (project?.writers?.includes(userId)) return 'writer';
  if (project?.readers?.includes(userId)) return 'reader';
  return 'none';
};

export const ProjectManagement = ({ embedded = false }) => {
  const { projectId } = useParams();
  const { user, getClient } = useAuth();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);

  // Project members (users with a role here), resolved from the ACL — admins
  // excluded (they reach everything implicitly, so they're not "members").
  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(true);

  // Search-to-add. The roster isn't fetched wholesale; we query the server.
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 250);
  const [searchActive, setSearchActive] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // User creation form state
  const [showCreateUserForm, setShowCreateUserForm] = useState(false);
  const [newUserForm, setNewUserForm] = useState(EMPTY_USER_FORM);
  const [createUserError, setCreateUserError] = useState('');
  const [createUserLoading, setCreateUserLoading] = useState(false);

  // User editing state
  const [editingUser, setEditingUser] = useState(null);
  const [editUserForm, setEditUserForm] = useState(EMPTY_USER_FORM);
  const [editUserError, setEditUserError] = useState('');

  const isAdmin = user?.isAdmin || false;

  const fetchProject = async () => {
    try {
      setLoading(true);
      const client = getClient();
      const projectData = await client.projects.get(projectId);
      setProject(projectData);
      return projectData;
    } catch (err) {
      console.error('Error fetching project:', err);
      notifyError('Failed to load project data');
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProject();
  }, [projectId]);

  // Resolve the ACL member ids to user objects (for usernames + admin flag).
  // The member set is project-sized, not instance-sized, so per-id GETs are fine.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    (async () => {
      setMembersLoading(true);
      const client = getClient();
      const ids = [...new Set([
        ...(project.maintainers || []),
        ...(project.writers || []),
        ...(project.readers || []),
      ])];
      try {
        const resolved = await Promise.all(ids.map(id =>
          client.users.get(id).catch(() => ({ id, username: id, isAdmin: false }))));
        const rows = resolved
          .filter(u => !u.isAdmin)
          .map(u => ({ ...u, role: roleOf(project, u.id) }))
          .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
        if (!cancelled) setMembers(rows);
      } catch (err) {
        console.error('Error resolving members:', err);
        if (!cancelled) setMembers([]);
      } finally {
        if (!cancelled) setMembersLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [project, getClient]);

  // Search the directory (server-side ?q=). Runs once the box is touched, so an
  // empty query browses everyone (first page); typing filters. Members already
  // on the project are dropped from the results.
  useEffect(() => {
    if (!searchActive) return;
    let cancelled = false;
    (async () => {
      setSearchLoading(true);
      const client = getClient();
      try {
        const page = await client.users.listPage({ q: debouncedSearch || undefined, limit: SEARCH_LIMIT });
        const memberIds = new Set(members.map(m => m.id));
        const results = (page.entries || []).filter(u => !memberIds.has(u.id));
        if (!cancelled) setSearchResults(results);
      } catch (err) {
        console.error('User search failed:', err);
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [debouncedSearch, searchActive, members, getClient]);

  // Add / change / remove a project role for a user.
  const setRole = async (userId, newLevel) => {
    try {
      const client = getClient();
      const current = roleOf(project, userId);
      if (current === newLevel) return;

      if (current === 'maintainer') await client.projects.removeMaintainer(projectId, userId);
      else if (current === 'writer') await client.projects.removeWriter(projectId, userId);
      else if (current === 'reader') await client.projects.removeReader(projectId, userId);

      if (newLevel === 'maintainer') await client.projects.addMaintainer(projectId, userId);
      else if (newLevel === 'writer') await client.projects.addWriter(projectId, userId);
      else if (newLevel === 'reader') await client.projects.addReader(projectId, userId);

      notifySuccess('Permissions updated');
      await fetchProject(); // re-resolves members + refreshes search filter
    } catch (err) {
      console.error('Error updating permissions:', err);
      notifyError('Failed to update permissions');
    }
  };

  // Handle user creation
  const handleCreateUser = async (e) => {
    e.preventDefault();
    setCreateUserError('');
    setCreateUserLoading(true);

    if (newUserForm.password !== newUserForm.confirmPassword) {
      setCreateUserError('Passwords do not match');
      setCreateUserLoading(false);
      return;
    }

    if (newUserForm.password.length < 6) {
      setCreateUserError('Password must be at least 6 characters long');
      setCreateUserLoading(false);
      return;
    }

    try {
      const client = getClient();
      await client.users.create(newUserForm.username, newUserForm.password, newUserForm.isAdmin);

      notifySuccess('User created successfully');
      setShowCreateUserForm(false);
      setNewUserForm(EMPTY_USER_FORM);
      setCreateUserError('');
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

  // Handle user editing
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

    try {
      const client = getClient();
      const newUsername = editUserForm.username !== editingUser.username ? editUserForm.username : undefined;
      const newPassword = editUserForm.password || undefined;
      const newIsAdmin = editUserForm.isAdmin !== (editingUser.isAdmin || false) ? editUserForm.isAdmin : undefined;

      await client.users.update(editingUser.id, newPassword, newUsername, newIsAdmin);

      notifySuccess('User updated successfully');
      setEditingUser(null);
      setEditUserForm(EMPTY_USER_FORM);
      await fetchProject();
    } catch (err) {
      console.error('Error updating user:', err);
      setEditUserError('Failed to update user: ' + (err.message || 'Unknown error'));
    }
  };

  const handleDeleteUser = () => {
    const target = editingUser;
    confirmDelete({
      title: 'Delete user',
      message: `Are you sure you want to delete user "${target.username}"? This action cannot be undone.`,
      onConfirm: async () => {
        try {
          await getClient().users.delete(target.id);
          notifySuccess('User deleted successfully');
          setEditingUser(null);
          await fetchProject();
        } catch (err) {
          console.error('Error deleting user:', err);
          notifyError('Failed to delete user: ' + (err.message || 'Unknown error'));
        }
      },
    });
  };

  if (loading) {
    return <Center py={48}><Loader /></Center>;
  }

  if (!project) {
    return <Alert color="red">Project not found</Alert>;
  }

  if (!canManageProject(project, user)) {
    return <Alert color="red">You don't have permission to manage this project</Alert>;
  }

  return (
    <>
      {!embedded && (
        <>
          <Breadcrumbs mb="lg">
            <Anchor component={Link} to="/projects" size="sm">Projects</Anchor>
            <Anchor component={Link} to={`/projects/${projectId}/documents`} size="sm">{project.name}</Anchor>
            <Text size="sm" c="dimmed">Project Management</Text>
          </Breadcrumbs>

          <Stack gap={2} mb="lg">
            <Title order={2}>Project Management</Title>
            <Text c="dimmed">Manage users and permissions for {project.name}</Text>
          </Stack>
        </>
      )}

      {isAdmin && (
        <Button
          leftSection={<IconPlus size={16} />}
          mb="lg"
          onClick={() => { setShowCreateUserForm(true); setCreateUserError(''); }}
        >
          Create User
        </Button>
      )}

      {/* Current members */}
      <Paper withBorder radius="md" mb="lg">
        <Group px="lg" py="md" justify="space-between" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
          <Title order={3} size="h4">Members</Title>
          <Text size="sm" c="dimmed">{members.length} with access</Text>
        </Group>

        {membersLoading ? (
          <Center py="xl"><Loader size="sm" /></Center>
        ) : members.length === 0 ? (
          <Text px="lg" py="md" size="sm" c="dimmed">
            No one has been granted access yet. Use “Add a user” below.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={520}>
            <Table verticalSpacing="sm" horizontalSpacing="lg">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>User</Table.Th>
                  <Table.Th>Project role</Table.Th>
                  {isAdmin && <Table.Th w={48} />}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {members.map(m => (
                  <Table.Tr key={m.id}>
                    <Table.Td>
                      <Text size="sm" fw={500}>{m.username}</Text>
                      <Text size="xs" c="dimmed">ID: {m.id}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Select
                        data={PERMISSION_OPTIONS}
                        value={m.role}
                        onChange={(value) => setRole(m.id, value)}
                        disabled={m.id === user.id}
                        allowDeselect={false}
                        w={150}
                        size="sm"
                        description={m.id === user.id ? 'Your own access' : undefined}
                      />
                    </Table.Td>
                    {isAdmin && (
                      <Table.Td>
                        <Menu position="bottom-end" withinPortal>
                          <Menu.Target>
                            <ActionIcon variant="subtle" color="gray" aria-label="User actions">
                              <IconDotsVertical size={16} />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item onClick={() => startEditingUser(m)}>Edit user…</Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Table.Td>
                    )}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Paper>

      {/* Add a user (server-side search) */}
      <Paper withBorder radius="md" mb="lg">
        <Group px="lg" py="md" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
          <Title order={3} size="h4">Add a user</Title>
        </Group>
        <Stack px="lg" py="md" gap="sm">
          <TextInput
            leftSection={<IconSearch size={16} />}
            placeholder="Search users by name…"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            onFocus={() => setSearchActive(true)}
          />
          {searchActive && (
            searchLoading ? (
              <Center py="md"><Loader size="sm" /></Center>
            ) : searchResults.length === 0 ? (
              <Text size="sm" c="dimmed" py="xs">
                {debouncedSearch ? 'No matching users.' : 'No other users to add.'}
              </Text>
            ) : (
              <Stack gap={0}>
                {searchResults.map((u, i) => (
                  <Group
                    key={u.id}
                    justify="space-between"
                    wrap="nowrap"
                    py="xs"
                    style={{ borderTop: i ? '1px solid var(--mantine-color-gray-1)' : undefined }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <Group gap="xs" wrap="nowrap">
                        <Text size="sm" fw={500} truncate>{u.username}</Text>
                        {u.isAdmin && <Badge size="xs" color="grape" variant="light">Admin</Badge>}
                      </Group>
                      <Text size="xs" c="dimmed" truncate>ID: {u.id}</Text>
                    </div>
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <Button size="compact-sm" variant="light" leftSection={<IconPlus size={14} />}>
                          Add
                        </Button>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Label>Add as…</Menu.Label>
                        {GRANT_ROLES.map(role => (
                          <Menu.Item key={role} onClick={() => setRole(u.id, role)}>
                            {role.charAt(0).toUpperCase() + role.slice(1)}
                          </Menu.Item>
                        ))}
                      </Menu.Dropdown>
                    </Menu>
                  </Group>
                ))}
              </Stack>
            )
          )}
        </Stack>
      </Paper>

      {/* API Access Section */}
      <Paper withBorder radius="md">
        <Group px="lg" py="md" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
          <Title order={3} size="h4">API Access</Title>
        </Group>
        <Stack px="lg" py="md" gap="sm" align="flex-start">
          <Text size="sm" c="dimmed">
            To access the API programmatically from external services like parsers or scripts,
            create a named API token. Unlike your login session, a named token can be revoked
            individually and its name appears in the audit history, so machine-made changes are
            distinguishable from yours.
          </Text>
          <Button component={Link} to="/profile" color="gray">
            Manage API Tokens
          </Button>
          <Text size="xs" c="dimmed">
            Use a token to initialize a Python <Code>PlaidClient</Code> instance.
          </Text>
        </Stack>
      </Paper>

      {/* Create User Modal */}
      <Modal
        opened={isAdmin && showCreateUserForm}
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
                <Button
                  type="button"
                  color="red"
                  onClick={handleDeleteUser}
                  disabled={editingUser.id === user.id}
                >
                  Delete User
                </Button>
                <Group gap="sm">
                  <Button type="button" variant="default" onClick={() => setEditingUser(null)}>
                    Cancel
                  </Button>
                  <Button type="submit">Update User</Button>
                </Group>
              </Group>
              {editingUser.id === user.id && (
                <Text size="xs" c="dimmed">You cannot delete your own account</Text>
              )}
            </Stack>
          </form>
        )}
      </Modal>
    </>
  );
};
