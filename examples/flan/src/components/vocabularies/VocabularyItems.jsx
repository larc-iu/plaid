import { useState, useEffect } from 'react';
import {
  Stack,
  Text,
  Paper,
  TextInput,
  Button,
  Group,
  Loader,
  Alert,
  Modal,
  Divider,
  ActionIcon
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { notifications } from '@mantine/notifications';
import { useDisclosure } from '@mantine/hooks';
import IconPlus from '@tabler/icons-react/dist/esm/icons/IconPlus.mjs';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';
import IconEdit from '@tabler/icons-react/dist/esm/icons/IconEdit.mjs';
import IconCheck from '@tabler/icons-react/dist/esm/icons/IconCheck.mjs';
import IconX from '@tabler/icons-react/dist/esm/icons/IconX.mjs';

export const VocabularyItems = ({ vocabularyId, vocabulary, client, customFields }) => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newItemForm, setNewItemForm] = useState('');
  const [newItemFields, setNewItemFields] = useState({});
  const [editingItem, setEditingItem] = useState(null);
  const [editForm, setEditForm] = useState('');
  const [editFields, setEditFields] = useState({});
  const [deleteModalOpened, { open: openDeleteModal, close: closeDeleteModal }] = useDisclosure(false);
  const [itemToDelete, setItemToDelete] = useState(null);

  const fetchItems = async () => {
    try {
      setLoading(true);
      if (!client) {
        throw new Error('Not authenticated');
      }
      
      const vocabularyData = await client.vocabLayers.get(vocabularyId, true);
      setItems(vocabularyData.items || []);
      setError('');
    } catch (err) {
      setError('Failed to load vocabulary items');
      console.error('Error fetching vocabulary items:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchItems();
  }, [vocabularyId]);

  const handleCreateItem = async () => {
    if (!newItemForm.trim()) {
      notifications.show({
        title: 'Invalid Form',
        message: 'Item form cannot be empty',
        color: 'red'
      });
      return;
    }

    try {
      const metadata = Object.keys(newItemFields).length > 0 ? newItemFields : undefined;
      await client.vocabItems.create(vocabularyId, newItemForm.trim(), metadata);
      
      // Reset form
      setNewItemForm('');
      setNewItemFields({});
      
      // Refresh items
      await fetchItems();
      
      notifications.show({
        title: 'Success',
        message: 'Vocabulary item created successfully',
        color: 'green'
      });
    } catch (err) {
      console.error('Error creating vocabulary item:', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to create vocabulary item',
        color: 'red'
      });
    }
  };

  const handleStartEdit = (item) => {
    setEditingItem(item.id);
    setEditForm(item.form);
    setEditFields(item.metadata || {});
  };

  const handleSaveEdit = async () => {
    if (!editForm.trim()) {
      notifications.show({
        title: 'Invalid Form',
        message: 'Item form cannot be empty',
        color: 'red'
      });
      return;
    }

    try {
      const item = items.find(i => i.id === editingItem);
      
      // Update form if changed
      if (editForm !== item.form) {
        await client.vocabItems.update(editingItem, editForm.trim());
      }
      
      // Update metadata
      if (Object.keys(editFields).length > 0) {
        await client.vocabItems.setMetadata(editingItem, editFields);
      } else if (item.metadata && Object.keys(item.metadata).length > 0) {
        await client.vocabItems.deleteMetadata(editingItem);
      }
      
      // Reset edit state
      setEditingItem(null);
      setEditForm('');
      setEditFields({});
      
      // Refresh items
      await fetchItems();
      
      notifications.show({
        title: 'Success',
        message: 'Vocabulary item updated successfully',
        color: 'green'
      });
    } catch (err) {
      console.error('Error updating vocabulary item:', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to update vocabulary item',
        color: 'red'
      });
    }
  };

  const handleCancelEdit = () => {
    setEditingItem(null);
    setEditForm('');
    setEditFields({});
  };

  const handleDeleteClick = (item) => {
    setItemToDelete(item);
    openDeleteModal();
  };

  const handleConfirmDelete = async () => {
    if (!itemToDelete) return;

    try {
      await client.vocabItems.delete(itemToDelete.id);
      
      closeDeleteModal();
      setItemToDelete(null);
      
      // Refresh items
      await fetchItems();
      
      notifications.show({
        title: 'Success',
        message: 'Vocabulary item deleted successfully',
        color: 'green'
      });
    } catch (err) {
      console.error('Error deleting vocabulary item:', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to delete vocabulary item',
        color: 'red'
      });
    }
  };

  const renderCustomFieldInputs = (values, onChange, keyPrefix) => {
    return customFields.map(fieldName => (
      <TextInput
        key={`${keyPrefix}-${fieldName}`}
        label={fieldName}
        placeholder={`Enter ${fieldName}`}
        value={values[fieldName] || ''}
        onChange={(event) => onChange({
          ...values,
          [fieldName]: event.currentTarget.value
        })}
      />
    ));
  };

  if (loading) {
    return (
      <Stack spacing="lg" align="center">
        <Loader size="md" />
        <Text>Loading vocabulary items...</Text>
      </Stack>
    );
  }

  if (error) {
    return (
      <Alert color="red" title="Error">
        {error}
      </Alert>
    );
  }

  // Prepare columns for the data table
  const columns = [
    {
      accessor: 'form',
      title: 'Form',
      width: '30%',
      render: (record) => {
        if (editingItem === record.id) {
          return (
            <TextInput
              value={editForm}
              onChange={(event) => setEditForm(event.currentTarget.value)}
              size="sm"
            />
          );
        }
        return <Text>{record.form}</Text>;
      }
    },
    // Add custom field columns
    ...customFields.map(fieldName => ({
      accessor: fieldName,
      title: fieldName,
      width: `${Math.max(15, 60 / (customFields.length + 2))}%`,
      render: (record) => {
        if (editingItem === record.id) {
          return (
            <TextInput
              value={editFields[fieldName] || ''}
              onChange={(event) => setEditFields({
                ...editFields,
                [fieldName]: event.currentTarget.value
              })}
              size="sm"
            />
          );
        }
        return <Text>{record.metadata?.[fieldName] || ''}</Text>;
      }
    })),
    {
      accessor: 'actions',
      title: 'Actions',
      width: '20%',
      render: (record) => {
        if (editingItem === record.id) {
          return (
            <Group spacing="xs">
              <ActionIcon
                color="green"
                size="sm"
                onClick={handleSaveEdit}
              >
                <IconCheck size={14} />
              </ActionIcon>
              <ActionIcon
                color="gray"
                size="sm"
                onClick={handleCancelEdit}
              >
                <IconX size={14} />
              </ActionIcon>
            </Group>
          );
        }
        
        return (
          <Group spacing="xs">
            <ActionIcon
              color="blue"
              size="sm"
              onClick={() => handleStartEdit(record)}
            >
              <IconEdit size={14} />
            </ActionIcon>
            <ActionIcon
              color="red"
              size="sm"
              onClick={() => handleDeleteClick(record)}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        );
      }
    }
  ];

  return (
    <Stack spacing="lg">
      {/* Items table */}
      <Paper p="md" withBorder>
        <Stack spacing="md">
          <Text size="md" fw={500}>Vocabulary Items ({items.length})</Text>
          
          {items.length === 0 ? (
            <Text c="dimmed" ta="center" py="xl">
              No vocabulary items yet. Add your first item below.
            </Text>
          ) : (
            <DataTable
              textSelectionDisabled
              withTableBorder
              withRowBorders
              highlightOnHover
              columns={columns}
              records={items}
              minHeight={200}
            />
          )}
        </Stack>
      </Paper>

      {/* Add new item form */}
      <Paper p="md" withBorder>
        <Stack spacing="md">
          <Text size="md" fw={500}>Add New Vocabulary Item</Text>
          
          <TextInput
            label="Form"
            placeholder="Enter item form"
            value={newItemForm}
            onChange={(event) => setNewItemForm(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleCreateItem();
              }
            }}
          />
          
          {customFields.length > 0 && (
            <>
              <Divider />
              <Text size="sm" fw={500}>Custom Fields</Text>
              <Stack spacing="xs">
                {renderCustomFieldInputs(newItemFields, setNewItemFields, 'new')}
              </Stack>
            </>
          )}
          
          <Group justify="flex-end">
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={handleCreateItem}
              disabled={!newItemForm.trim()}
            >
              Add Item
            </Button>
          </Group>
        </Stack>
      </Paper>

      {/* Delete Confirmation Modal */}
      <Modal
        opened={deleteModalOpened}
        onClose={closeDeleteModal}
        title="Delete Vocabulary Item"
        size="md"
        centered
      >
        <Stack spacing="md">
          <Alert
            color="red"
            title="Warning"
            variant="light"
          >
            <Text size="sm">
              You are about to permanently delete the vocabulary item <strong>"{itemToDelete?.form}"</strong>.
            </Text>
            <Text size="sm" mt="xs">
              This action cannot be undone and will remove all links to this item.
            </Text>
          </Alert>

          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={closeDeleteModal}
            >
              Cancel
            </Button>
            <Button
              color="red"
              onClick={handleConfirmDelete}
              leftSection={<IconTrash size={16} />}
            >
              Delete Item
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
};