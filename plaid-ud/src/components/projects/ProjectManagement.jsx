import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Title, Text, Button, Alert, Paper, Stack, Group, Center, Loader, Table, Badge,
  Select, Modal, TextInput, PasswordInput, Checkbox, Breadcrumbs, Anchor, Code,
} from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useAuth } from '../../contexts/AuthContext';
import { confirmDelete, notifySuccess, notifyError } from '../../utils/feedback.jsx';

const PERMISSION_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'reader', label: 'Reader' },
  { value: 'writer', label: 'Writer' },
  { value: 'maintainer', label: 'Maintainer' },
];

const EMPTY_USER_FORM = { username: '', password: '', confirmPassword: '', isAdmin: false };

export const ProjectManagement = () => {
  const { projectId } = useParams();
  const { user, getClient } = useAuth();
  const [project, setProject] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

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

  const fetchData = async () => {
    try {
      setLoading(true);
      const client = getClient();
      const projectData = await client.projects.get(projectId);
      setProject(projectData);
      const usersData = await client.users.list();
      setUsers(usersData);
    } catch (err) {
      console.error('Error fetching data:', err);
      notifyError('Failed to load project data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [projectId]);

  // Check if current user can manage this project
  const canManageProject = () => {
    if (!user || !project) return false;
    return isAdmin || project.maintainers?.includes(user.id);
  };

  // Get user's current permission level for the project
  const getUserPermissionLevel = (userId) => {
    if (!project) return 'none';
    if (project.maintainers?.includes(userId)) return 'maintainer';
    if (project.writers?.includes(userId)) return 'writer';
    if (project.readers?.includes(userId)) return 'reader';
    return 'none';
  };

  // Handle permission change
  const handlePermissionChange = async (userId, newLevel) => {
    try {
      const client = getClient();
      const currentLevel = getUserPermissionLevel(userId);

      // Remove current permission if any
      if (currentLevel === 'maintainer') {
        await client.projects.removeMaintainer(projectId, userId);
      } else if (currentLevel === 'writer') {
        await client.projects.removeWriter(projectId, userId);
      } else if (currentLevel === 'reader') {
        await client.projects.removeReader(projectId, userId);
      }

      // Add new permission if not 'none'
      if (newLevel === 'maintainer') {
        await client.projects.addMaintainer(projectId, userId);
      } else if (newLevel === 'writer') {
        await client.projects.addWriter(projectId, userId);
      } else if (newLevel === 'reader') {
        await client.projects.addReader(projectId, userId);
      }

      notifySuccess('User permissions updated');
      await fetchData(); // Refresh data
    } catch (err) {
      console.error('Error updating permissions:', err);
      notifyError('Failed to update user permissions');
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
      await fetchData(); // Refresh users list
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
      await fetchData(); // Refresh users list
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
          await fetchData(); // Refresh users list
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

  if (!canManageProject()) {
    return <Alert color="red">You don't have permission to manage this project</Alert>;
  }

  return (
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

      {isAdmin && (
        <Button
          leftSection={<IconPlus size={16} />}
          mb="lg"
          onClick={() => { setShowCreateUserForm(true); setCreateUserError(''); }}
        >
          Create User
        </Button>
      )}

      {/* Users and Permissions Management */}
      <Paper withBorder radius="md" mb="lg">
        <Group px="lg" py="md" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
          <Title order={3} size="h4">User Permissions</Title>
        </Group>
        <Table.ScrollContainer minWidth={600}>
          <Table verticalSpacing="sm" horizontalSpacing="lg">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>User</Table.Th>
                <Table.Th>Role</Table.Th>
                <Table.Th>Project Permission</Table.Th>
                {isAdmin && <Table.Th>Actions</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {users.map(userItem => (
                <Table.Tr key={userItem.id}>
                  <Table.Td>
                    <Text size="sm" fw={500}>{userItem.username}</Text>
                    <Text size="sm" c="dimmed">ID: {userItem.id}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={userItem.isAdmin ? 'grape' : 'gray'} variant="light">
                      {userItem.isAdmin ? 'Admin' : 'User'}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Select
                      data={PERMISSION_OPTIONS}
                      value={getUserPermissionLevel(userItem.id)}
                      onChange={(value) => handlePermissionChange(userItem.id, value)}
                      disabled={userItem.id === user.id}
                      allowDeselect={false}
                      w={160}
                      size="sm"
                      description={userItem.id === user.id ? 'Cannot change own permissions' : undefined}
                    />
                  </Table.Td>
                  {isAdmin && (
                    <Table.Td>
                      <Button variant="subtle" size="compact-sm" onClick={() => startEditingUser(userItem)}>
                        Edit
                      </Button>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
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
