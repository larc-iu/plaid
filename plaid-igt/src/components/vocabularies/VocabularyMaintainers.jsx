import { useState, useMemo } from 'react';
import { 
  Title, 
  Text, 
  Button, 
  Stack,
  Group,
  Badge,
  Paper,
  Alert
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { notifications } from '@mantine/notifications';
import IconUserPlus from '@tabler/icons-react/dist/esm/icons/IconUserPlus.mjs';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';

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
      
      notifications.show({
        title: 'Maintainer added',
        message: 'User has been added as a maintainer',
        color: 'green'
      });
    } catch (err) {
      console.error('Error adding maintainer:', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to add maintainer',
        color: 'red'
      });
    } finally {
      setUpdatingUser(null);
    }
  };

  const handleRemoveMaintainer = async (userId) => {
    if (userId === user.id) {
      notifications.show({
        title: 'Cannot remove own permissions',
        message: 'You cannot remove yourself as a maintainer of the vocabulary',
        color: 'red'
      });
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
      
      notifications.show({
        title: 'Maintainer removed',
        message: 'User has been removed as a maintainer',
        color: 'green'
      });
    } catch (err) {
      console.error('Error removing maintainer:', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to remove maintainer',
        color: 'red'
      });
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
      <Alert color="yellow" title="Access Denied">
        You need maintainer permissions to manage vocabulary access.
      </Alert>
    );
  }

  return (
    <Stack spacing="lg">
      <Paper p="md" withBorder>
        <Group justify="space-between" mb="md">
          <Title order={3}>Maintainer Management</Title>
        </Group>
        
        <Text size="sm" c="dimmed" mb="md">
          Maintainers can edit vocabulary settings, manage vocabulary items, and control access to this vocabulary.
        </Text>
        
        <DataTable
          withTableBorder
          withRowBorders
          highlightOnHover
          columns={[
            { 
              accessor: 'id', 
              title: 'User ID',
              width: '25%',
              render: ({ id }) => (
                <Text size="sm" c="dimmed">{id}</Text>
              )
            },
            { 
              accessor: 'username', 
              title: 'Username',
              width: '25%',
              render: (record) => (
                <Text>{record.username}</Text>
              )
            },
            { 
              accessor: 'isAdmin', 
              title: 'Admin Status',
              width: '20%',
              render: ({ isAdmin }) => (
                isAdmin ? (
                  <Badge color="red" size="sm">Admin</Badge>
                ) : (
                  <Badge color="gray" size="sm">User</Badge>
                )
              )
            },
            { 
              accessor: 'isMaintainer', 
              title: 'Maintainer Status',
              width: '30%',
              render: (record) => (
                <Group 
                  justify="space-between"
                  onMouseEnter={() => setHoveredUser(record.id)}
                  onMouseLeave={() => setHoveredUser(null)}
                  style={{ width: '100%' }}
                >
                  {record.isMaintainer ? (
                    <>
                      <Badge color="blue" size="sm">Maintainer</Badge>
                      {record.id !== user.id && (
                        <Button
                          size="xs"
                          color="red"
                          variant="light"
                          style={{ 
                            opacity: hoveredUser === record.id ? 1 : 0,
                            transition: 'opacity 0.2s ease',
                            marginLeft: '8px'
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleRemoveMaintainer(record.id);
                          }}
                          loading={updatingUser === record.id}
                          disabled={updatingUser === record.id}
                        >
                          <IconTrash size={14} />
                        </Button>
                      )}
                    </>
                  ) : (
                    <>
                      {record.isAdmin ? (
                        <Badge color="red" size="sm">Admin (Full Access)</Badge>
                      ) : (
                        <>
                          <Text size="sm" c="dimmed">Not a maintainer</Text>
                          <Button
                            size="xs"
                            color="blue"
                            variant="light"
                            style={{ 
                              opacity: hoveredUser === record.id ? 1 : 0,
                              transition: 'opacity 0.2s ease',
                              marginLeft: '8px'
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleAddMaintainer(record.id);
                            }}
                            loading={updatingUser === record.id}
                            disabled={updatingUser === record.id}
                          >
                            <IconUserPlus size={14} />
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </Group>
              )
            }
          ]}
          records={tableData}
          minHeight={150}
        />
      </Paper>
    </Stack>
  );
};