import { useState, useMemo, memo } from 'react';
import { 
  Title, 
  Text, 
  Button, 
  Stack,
  Group,
  Select,
  Badge,
  Paper,
  Divider,
  Modal,
  TextInput,
  Switch,
  Alert
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { notifications } from '@mantine/notifications';
import { useClipboard, useDisclosure } from '@mantine/hooks';
import { IconCopy, IconCheck, IconUserPlus, IconTrash, IconAlertTriangle } from '@tabler/icons-react';

export const AccessManagement = memo(({ 
  project, 
  users, 
  user, 
  projectId, 
  getClient, 
  onDataUpdate,
  onUsersUpdate
}) => {
  const clipboard = useClipboard({ timeout: 2000 });
  const [updatingUser, setUpdatingUser] = useState(null);
  const [hoveredUser, setHoveredUser] = useState(null);
  const [addUserModalOpened, { open: openAddUserModal, close: closeAddUserModal }] = useDisclosure(false);
  const [deleteUserModalOpened, { open: openDeleteUserModal, close: closeDeleteUserModal }] = useDisclosure(false);
  const [newUserData, setNewUserData] = useState({
    username: '',
    password: '',
    isAdmin: false
  });
  const [userToDelete, setUserToDelete] = useState(null);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState('');
  const [creatingUser, setCreatingUser] = useState(false);
  const [deletingUser, setDeletingUser] = useState(false);

  // Get user's role in the project
  const getUserRole = (userId) => {
    if (!project) return 'none';
    if (project.maintainers?.includes(userId)) return 'maintainer';
    if (project.writers?.includes(userId)) return 'writer';
    if (project.readers?.includes(userId)) return 'reader';
    return 'none';
  };

  const handleRoleChange = async (userId, newRole) => {
    if (userId === user.id) {
      notifications.show({
        title: 'Cannot modify own permissions',
        message: 'You cannot change your own role in the project',
        color: 'red'
      });
      return;
    }

    try {
      setUpdatingUser(userId);
      const client = getClient();

      // Add new permission (if not 'none'). Old permission is automatically unassigned on addition,
      // and removing reader removes all other permissions.
      if (newRole === 'maintainer') {
        await client.projects.addMaintainer(projectId, userId);
      } else if (newRole === 'writer') {
        await client.projects.addWriter(projectId, userId);
      } else if (newRole === 'reader') {
        await client.projects.addReader(projectId, userId);
      } else if (newRole === 'none') {
        await client.projects.removeReader(projectId, userId);
      }
      
      // Refresh project data to update permissions
      await onDataUpdate();
      
      notifications.show({
        title: 'Role updated',
        message: `User role has been updated to ${newRole}`,
        color: 'green'
      });
    } catch (err) {
      console.error('Error updating role:', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to update user role',
        color: 'red'
      });
    } finally {
      setUpdatingUser(null);
    }
  };

  const handleCopyToken = () => {
    const token = localStorage.getItem('token');
    if (token) {
      clipboard.copy(token);
      notifications.show({
        title: 'Token copied',
        message: 'Your authentication token has been copied to clipboard',
        color: 'green'
      });
    }
  };

  const handleAddUser = async () => {
    if (!newUserData.username || !newUserData.password) {
      notifications.show({
        title: 'Missing Information',
        message: 'Please provide both Username and Password',
        color: 'red'
      });
      return;
    }

    try {
      setCreatingUser(true);
      const client = getClient();
      
      // Create the user
      await client.users.create(newUserData.username, newUserData.password, newUserData.isAdmin);
      
      // Refresh the users list
      await onUsersUpdate();
      
      notifications.show({
        title: 'User created',
        message: `User "${newUserData.username}" has been created successfully`,
        color: 'green'
      });
      
      // Reset form and close modal
      setNewUserData({ username: '', password: '', isAdmin: false });
      closeAddUserModal();
      
    } catch (err) {
      console.error('Error creating user:', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to create user. Please try again.',
        color: 'red'
      });
    } finally {
      setCreatingUser(false);
    }
  };

  const handleAddUserModalOpen = () => {
    setNewUserData({ username: '', password: '', isAdmin: false });
    openAddUserModal();
  };

  const handleDeleteUserClick = (userId, username) => {
    if (userId === user.id) {
      notifications.show({
        title: 'Cannot delete own account',
        message: 'You cannot delete your own user account',
        color: 'red'
      });
      return;
    }

    setUserToDelete({ id: userId, username });
    setDeleteConfirmationText('');
    openDeleteUserModal();
  };

  const handleDeleteUser = async () => {
    if (!userToDelete) return;

    if (deleteConfirmationText !== userToDelete.id) {
      notifications.show({
        title: 'Invalid confirmation',
        message: 'User ID does not match. Please type the exact user ID.',
        color: 'red'
      });
      return;
    }

    try {
      setDeletingUser(true);
      const client = getClient();
      
      // Delete the user
      await client.users.delete(userToDelete.id);
      
      // Refresh the users list
      await onUsersUpdate();
      
      notifications.show({
        title: 'User deleted',
        message: `User "${userToDelete.username}" has been deleted successfully`,
        color: 'green'
      });
      
      // Close modal and reset state
      closeDeleteUserModal();
      setUserToDelete(null);
      setDeleteConfirmationText('');
      
    } catch (err) {
      console.error('Error deleting user:', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to delete user. Please try again.',
        color: 'red'
      });
    } finally {
      setDeletingUser(false);
    }
  };

  // Prepare table data with user roles - memoized to prevent unnecessary re-renders
  const tableData = useMemo(() => {
    const data = users.map(u => ({
      ...u,
      role: getUserRole(u.id)
    }));
    
    // Sort by: 1) Admin status (admins first), 2) Role priority (maintainer > writer > reader > none), 3) Username alphabetically
    const roleMap = { maintainer: 3, writer: 2, reader: 1, none: 0 };
    data.sort((a, b) => {
      // First sort by admin status (admins first)
      if (a.isAdmin !== b.isAdmin) {
        return b.isAdmin - a.isAdmin;
      }
      
      // Then sort by role priority (higher number = higher priority)
      const roleA = roleMap[a.role] || 0;
      const roleB = roleMap[b.role] || 0;
      if (roleA !== roleB) {
        return roleB - roleA;
      }
      
      // Finally sort by username alphabetically
      return a.username.localeCompare(b.username);
    });
    
    return data;
  }, [users, project]);

  return (
    <Stack spacing="lg" mt="md">
      {/* User Management Section */}
      <Paper p="md">
        <Group justify="space-between" mb="md">
          <Title order={2}>User Management</Title>
          {user.isAdmin && (
            <Button
              leftSection={<IconUserPlus size={16} />}
              onClick={handleAddUserModalOpen}
            >
              Add User
            </Button>
          )}
        </Group>
        
        <DataTable
          withTableBorder
          withRowBorders
          highlightOnHover
          columns={[
            { 
              accessor: 'id', 
              title: 'User ID',
              width: '20%',
              render: ({ id }) => (
                <Text size="sm" c="dimmed">{id}</Text>
              )
            },
            { 
              accessor: 'username', 
              title: 'Username',
              width: '20%',
              render: (record) => (
                <Text>{record.username}</Text>
              )
            },
            { 
              accessor: 'isAdmin', 
              title: 'Admin Status',
              width: '15%',
              render: ({ isAdmin }) => (
                isAdmin ? (
                  <Badge color="red" size="sm">Admin</Badge>
                ) : (
                  <Badge color="gray" size="sm">User</Badge>
                )
              )
            },
            { 
              accessor: 'role', 
              title: 'Project Role',
              width: '40%',
              render: (record) => (
                <Group 
                  justify="space-between"
                  onMouseEnter={() => setHoveredUser(record.id)}
                  onMouseLeave={() => setHoveredUser(null)}
                  style={{ width: '100%' }}
                >
                  <Select
                    value={record.isAdmin && "admin" || record.role}
                    onChange={(value) => handleRoleChange(record.id, value)}
                    disabled={updatingUser === record.id || record.id === user.id || record.isAdmin}
                    data={[
                      { value: 'none', label: 'No Access' },
                      { value: 'reader', label: 'Reader' },
                      { value: 'writer', label: 'Writer' },
                      { value: 'maintainer', label: 'Maintainer' },
                    ]}
                    size="xs"
                    style={{ flex: 1 }}
                  />
                  {user.isAdmin && (
                    <Button
                      size="xs"
                      color="red"
                      variant="light"
                      style={{ 
                        opacity: (hoveredUser === record.id && record.id !== user.id) ? 1 : 0,
                        transition: 'opacity 0.2s ease',
                        marginLeft: '8px',
                        cursor: (record.id !== user.id ? 'pointer' : 'default')
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleDeleteUserClick(record.id, record.username);
                      }}
                      loading={deletingUser}
                      disabled={deletingUser}
                    >
                      <IconTrash size={14} />
                    </Button>
                  )}
                </Group>
              )
            }
          ]}
          records={tableData}
          minHeight={150}
        />
      </Paper>

      <Divider />

      {/* API Token Section */}
      <Paper p="md">
        <Title order={2} mb="md">API Token</Title>
        <Text size="sm" mb="md">
          Use your authentication token to access the API programmatically from external services like parsers or scripts.
        </Text>
        
        <Group>
          <Button
            leftSection={clipboard.copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            color={clipboard.copied ? 'green' : 'blue'}
            onClick={handleCopyToken}
          >
            {clipboard.copied ? 'Copied!' : 'Copy Token'}
          </Button>
        </Group>
        
        <Text size="xs" c="dimmed" mt="md">
          Keep your token secure. You can use it to initialize a Python PlaidClient instance.
        </Text>
      </Paper>

      {/* Add User Modal */}
      <Modal
        opened={addUserModalOpened}
        onClose={closeAddUserModal}
        title="Add New User"
        size="md"
        centered
      >
        <Stack spacing="md">
          <TextInput
            label="Username"
            placeholder="Enter username"
            value={newUserData.username}
            onChange={(event) => setNewUserData({ ...newUserData, username: event.currentTarget.value })}
            required
          />
          
          <TextInput
            label="Password"
            placeholder="Enter initial password"
            type="password"
            value={newUserData.password}
            onChange={(event) => setNewUserData({ ...newUserData, password: event.currentTarget.value })}
            required
          />
          
          <Switch
            label="Admin Status"
            description="Grant this user admin privileges"
            checked={newUserData.isAdmin}
            onChange={(event) => setNewUserData({ ...newUserData, isAdmin: event.currentTarget.checked })}
          />
          
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={closeAddUserModal}
              disabled={creatingUser}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddUser}
              loading={creatingUser}
              leftSection={!creatingUser ? <IconUserPlus size={16} /> : undefined}
            >
              {creatingUser ? 'Creating...' : 'Create User'}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Delete User Modal */}
      <Modal
        opened={deleteUserModalOpened}
        onClose={closeDeleteUserModal}
        title="Delete User"
        size="md"
        centered
      >
        <Stack spacing="md">
          <Alert
            icon={<IconAlertTriangle size={16} />}
            title="Caution"
            color="red"
            variant="light"
          >
            <Text size="sm">
              You are about to delete user:
              <br/><br/>
              <strong>"{userToDelete?.username}"</strong><br/>
              (<strong>{userToDelete?.id}</strong>)
            </Text>
          </Alert>

          <div>
            <Text size="sm" mb="xs">
              To confirm deletion, please type the user ID <strong>{userToDelete?.id}</strong> below:
            </Text>
            <TextInput
              value={deleteConfirmationText}
              onChange={(event) => setDeleteConfirmationText(event.currentTarget.value)}
              placeholder="Enter user ID"
              error={deleteConfirmationText && deleteConfirmationText !== userToDelete?.id ? 'User ID does not match' : null}
            />
          </div>

          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={closeDeleteUserModal}
              disabled={deletingUser}
            >
              Cancel
            </Button>
            <Button
              color="red"
              onClick={handleDeleteUser}
              disabled={deleteConfirmationText !== userToDelete?.id || deletingUser}
              loading={deletingUser}
              leftSection={<IconTrash size={16} />}
            >
              {deletingUser ? 'Deleting...' : 'Delete User'}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
});