import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { 
  Container, 
  Title, 
  Text, 
  Stack,
  Alert,
  Loader,
  Center,
  Breadcrumbs,
  Anchor,
  Tabs,
  TextInput,
  Button,
  Group,
  Paper,
  Modal,
  Divider,
  Switch
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useDisclosure } from '@mantine/hooks';
import IconVocabulary from '@tabler/icons-react/dist/esm/icons/IconVocabulary.mjs';
import IconUsers from '@tabler/icons-react/dist/esm/icons/IconUsers.mjs';
import IconSettings from '@tabler/icons-react/dist/esm/icons/IconSettings.mjs';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';
import IconPlus from '@tabler/icons-react/dist/esm/icons/IconPlus.mjs';
import IconX from '@tabler/icons-react/dist/esm/icons/IconX.mjs';
import { VocabularyItems } from './VocabularyItems';
import { VocabularyMaintainers } from './VocabularyMaintainers';

export const VocabularyDetail = () => {
  const { vocabularyId } = useParams();
  const navigate = useNavigate();
  const { user, client } = useAuth();
  const isNewVocabulary = !vocabularyId;

  const [vocabulary, setVocabulary] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState(isNewVocabulary ? 'settings' : 'items');
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState('');
  const [customFields, setCustomFields] = useState([]);
  const [fieldConfigs, setFieldConfigs] = useState({});
  const [newFieldName, setNewFieldName] = useState('');
  const [deleteModalOpened, { open: openDeleteModal, close: closeDeleteModal }] = useDisclosure(false);
  const [confirmDeleteName, setConfirmDeleteName] = useState('');

  const fetchVocabulary = async () => {
    if (isNewVocabulary) {
      setVocabulary({
        name: '',
        config: {},
        maintainers: [user?.id].filter(Boolean)
      });
      setEditedName('');
      setCustomFields([]);
      setIsEditing(true);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      if (!client) {
        throw new Error('Not authenticated');
      }
      
      if (!vocabularyId || vocabularyId === 'undefined') {
        throw new Error('Invalid vocabulary ID');
      }
      
      const vocabularyData = await client.vocabLayers.get(vocabularyId);
      setVocabulary(vocabularyData);
      setEditedName(vocabularyData.name);
      
      // Extract custom fields from config
      const fields = [];
      const configs = {};
      if (vocabularyData.config?.plaid?.fields) {
        Object.entries(vocabularyData.config.plaid.fields).forEach(([fieldName, fieldConfig]) => {
          if (fieldName.toLowerCase() !== 'form') {
            fields.push(fieldName);
            // Handle both old boolean format and new object format
            if (typeof fieldConfig === 'object' && fieldConfig !== null) {
              configs[fieldName] = fieldConfig;
            } else {
              // Legacy boolean format - convert to object
              configs[fieldName] = { inline: false };
            }
          }
        });
      }
      setCustomFields(fields);
      setFieldConfigs(configs);
      
      // Fetch users if user can manage this vocabulary
      if (canManageVocabulary(vocabularyData)) {
        const usersData = await client.users.list();
        setUsers(usersData);
      }
      
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        navigate('/login');
        return;
      }
      setError('Failed to load vocabulary');
      console.error('Error fetching vocabulary:', err);
    } finally {
      setLoading(false);
    }
  };

  // Helper function to check permissions
  const canManageVocabulary = (vocab = vocabulary) => {
    if (!user || !vocab) return false;
    return user.isAdmin || vocab.maintainers?.includes(user.id);
  };

  // Lightweight update function that only updates vocabulary data without loading state
  const updateVocabulary = async () => {
    if (isNewVocabulary) return;

    try {
      if (!client) {
        throw new Error('Not authenticated');
      }
      
      if (!vocabularyId || vocabularyId === 'undefined') {
        throw new Error('Invalid vocabulary ID');
      }
      
      const vocabularyData = await client.vocabLayers.get(vocabularyId);
      setVocabulary(vocabularyData);
      
      // Extract custom fields from config
      const fields = [];
      const configs = {};
      if (vocabularyData.config?.plaid?.fields) {
        Object.entries(vocabularyData.config.plaid.fields).forEach(([fieldName, fieldConfig]) => {
          if (fieldName.toLowerCase() !== 'form') {
            fields.push(fieldName);
            // Handle both old boolean format and new object format
            if (typeof fieldConfig === 'object' && fieldConfig !== null) {
              configs[fieldName] = fieldConfig;
            } else {
              // Legacy boolean format - convert to object
              configs[fieldName] = { inline: false };
            }
          }
        });
      }
      setCustomFields(fields);
      setFieldConfigs(configs);
      
    } catch (err) {
      console.error('Error updating vocabulary:', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to update vocabulary data',
        color: 'red'
      });
    }
  };

  useEffect(() => {
    fetchVocabulary();
  }, [vocabularyId]);

  const handleSave = async () => {
    if (!editedName.trim()) {
      notifications.show({
        title: 'Invalid Name',
        message: 'Vocabulary name cannot be empty',
        color: 'red'
      });
      return;
    }

    try {
      let savedVocabulary;
      
      if (isNewVocabulary) {
        savedVocabulary = await client.vocabLayers.create(editedName.trim());
        
        // Save custom fields configuration if any
        if (customFields.length > 0) {
          const fieldsConfig = {};
          customFields.forEach(field => {
            fieldsConfig[field] = fieldConfigs[field] || { inline: false };
          });
          await client.vocabLayers.setConfig(savedVocabulary.id, 'plaid', 'fields', fieldsConfig);
        }
        
        navigate(`/vocabularies/${savedVocabulary.id}`, { replace: true });
        notifications.show({
          title: 'Success',
          message: 'Vocabulary created successfully',
          color: 'green'
        });
      } else {
        // Update existing vocabulary name
        if (editedName !== vocabulary.name) {
          await client.vocabLayers.update(vocabularyId, editedName.trim());
          // Update local state to reflect the change immediately
          await updateVocabulary();
          notifications.show({
            title: 'Success',
            message: 'Vocabulary name updated successfully',
            color: 'green'
          });
        }
      }
      
      setIsEditing(false);
    } catch (err) {
      console.error('Error saving vocabulary:', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to save vocabulary',
        color: 'red'
      });
    }
  };

  const handleAddField = async () => {
    const trimmedName = newFieldName.trim();
    if (!trimmedName) {
      notifications.show({
        title: 'Invalid Field Name',
        message: 'Field name cannot be empty',
        color: 'red'
      });
      return;
    }

    // Check for reserved name
    if (trimmedName.toLowerCase() === 'form') {
      notifications.show({
        title: 'Reserved Field Name',
        message: 'Field name "form" is reserved and cannot be used',
        color: 'red'
      });
      return;
    }

    // Check for duplicate names (case insensitive)
    if (customFields.some(field => field.toLowerCase() === trimmedName.toLowerCase())) {
      notifications.show({
        title: 'Duplicate Field Name',
        message: 'A field with this name already exists',
        color: 'red'
      });
      return;
    }

    const updatedFields = [...customFields, trimmedName];
    await saveCustomFields(updatedFields);
    setNewFieldName('');
  };

  const handleRemoveField = async (fieldName) => {
    const updatedFields = customFields.filter(field => field !== fieldName);
    const updatedConfigs = { ...fieldConfigs };
    delete updatedConfigs[fieldName];
    await saveCustomFields(updatedFields, updatedConfigs);
  };

  const handleToggleInline = async (fieldName) => {
    const updatedConfigs = {
      ...fieldConfigs,
      [fieldName]: {
        ...fieldConfigs[fieldName],
        inline: !fieldConfigs[fieldName]?.inline
      }
    };
    await saveCustomFields(customFields, updatedConfigs);
  };

  const saveCustomFields = async (fields, configs = fieldConfigs) => {
    try {
      setCustomFields(fields);
      setFieldConfigs(configs);
      
      // Save to server if not a new vocabulary
      if (!isNewVocabulary) {
        const fieldsConfig = {};
        fields.forEach(field => {
          fieldsConfig[field] = configs[field] || { inline: false };
        });
        
        if (Object.keys(fieldsConfig).length > 0) {
          await client.vocabLayers.setConfig(vocabularyId, 'plaid', 'fields', fieldsConfig);
        } else {
          await client.vocabLayers.deleteConfig(vocabularyId, 'plaid', 'fields');
        }
        
        notifications.show({
          title: 'Success',
          message: 'Custom fields updated successfully',
          color: 'green'
        });
      }
    } catch (err) {
      console.error('Error saving custom fields:', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to save custom fields',
        color: 'red'
      });
    }
  };

  const handleDelete = async () => {
    if (confirmDeleteName !== vocabulary.name) {
      notifications.show({
        title: 'Name Mismatch',
        message: 'The entered name does not match the vocabulary name',
        color: 'red'
      });
      return;
    }

    try {
      await client.vocabLayers.delete(vocabularyId);
      closeDeleteModal();
      navigate('/vocabularies');
      notifications.show({
        title: 'Success',
        message: 'Vocabulary deleted successfully',
        color: 'green'
      });
    } catch (err) {
      console.error('Error deleting vocabulary:', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to delete vocabulary',
        color: 'red'
      });
    }
  };

  const breadcrumbItems = [
    { title: 'Vocabularies', href: '/vocabularies' },
    { title: isNewVocabulary ? 'New Vocabulary' : (vocabulary?.name || 'Loading...'), href: null }
  ].map((item, index) => (
    item.href ? (
      <Anchor key={index} component={Link} to={item.href}>
        {item.title}
      </Anchor>
    ) : (
      <Text key={index}>{item.title}</Text>
    )
  ));

  if (loading) {
    return (
      <Container size="lg" py="xl">
        <Center>
          <Stack align="center" spacing="md">
            <Loader size="lg" />
            <Text>Loading vocabulary...</Text>
          </Stack>
        </Center>
      </Container>
    );
  }

  if (error) {
    return (
      <Container size="lg" py="xl">
        <Alert color="red" title="Error">
          {error}
        </Alert>
      </Container>
    );
  }

  if (!vocabulary && !isNewVocabulary) {
    return (
      <Container size="lg" py="xl">
        <Alert color="red" title="Vocabulary Not Found">
          The requested vocabulary could not be found.
        </Alert>
      </Container>
    );
  }

  return (
    <Container size="lg" py="xl">
      <Stack spacing="lg">
        <Breadcrumbs>
          {breadcrumbItems}
        </Breadcrumbs>

        {!isNewVocabulary && (
          <div>
            <Title order={1} mb="xs">{vocabulary?.name}</Title>
            <Text c="dimmed" size="xs" mb="lg">{vocabulary?.id}</Text>
          </div>
        )}

        {!isNewVocabulary && !isEditing && (
          <Tabs value={activeTab} onChange={setActiveTab}>
            <Tabs.List>
              <Tabs.Tab value="items" leftSection={<IconVocabulary size={16} />}>
                Vocabulary Items
              </Tabs.Tab>
              {canManageVocabulary() && (
                <Tabs.Tab value="maintainers" leftSection={<IconUsers size={16} />}>
                  Maintainers
                </Tabs.Tab>
              )}
              {canManageVocabulary() && (
                <Tabs.Tab value="settings" leftSection={<IconSettings size={16} />}>
                  Settings
                </Tabs.Tab>
              )}
            </Tabs.List>

            <Tabs.Panel value="items">
              <VocabularyItems 
                vocabularyId={vocabularyId}
                vocabulary={vocabulary}
                client={client}
                customFields={customFields}
              />
            </Tabs.Panel>

            {canManageVocabulary() && (
              <Tabs.Panel value="maintainers">
                <VocabularyMaintainers 
                  vocabulary={vocabulary}
                  users={users}
                  user={user}
                  vocabularyId={vocabularyId}
                  client={client}
                  onDataUpdate={updateVocabulary}
                />
              </Tabs.Panel>
            )}

            {canManageVocabulary() && (
              <Tabs.Panel value="settings">
                <Stack spacing="lg">
                  <Paper p="md" withBorder>
                    <Stack spacing="md">
                      <Title order={3}>Basic Settings</Title>
                      
                      <Group>
                        <TextInput
                          label="Vocabulary Name"
                          placeholder="Enter vocabulary name"
                          value={editedName}
                          onChange={(event) => setEditedName(event.currentTarget.value)}
                          flex={1}
                        />
                        <Button
                          onClick={handleSave}
                          disabled={!editedName.trim() || editedName === vocabulary?.name}
                          style={{ alignSelf: 'flex-end' }}
                        >
                          Save Name
                        </Button>
                      </Group>
                    </Stack>
                  </Paper>

                  <Paper p="md" withBorder>
                    <Stack spacing="md">
                      <Title order={3}>Custom Fields</Title>
                      <Text size="sm" c="dimmed">
                        Add custom fields to vocabulary items. Field names cannot be "form" or duplicate existing fields (case-insensitive).
                      </Text>
                      
                      {customFields.length > 0 && (
                        <Stack spacing="xs">
                          {customFields.map(field => (
                            <Group key={field} justify="space-between">
                              <Group>
                                <Text>{field}</Text>
                                <Switch
                                  size="xs"
                                  label="Show inline"
                                  labelPosition="left"
                                  checked={fieldConfigs[field]?.inline || false}
                                  onChange={() => handleToggleInline(field)}
                                />
                              </Group>
                              <Button
                                size="xs"
                                variant="light"
                                color="red"
                                leftSection={<IconX size={14} />}
                                onClick={() => handleRemoveField(field)}
                              >
                                Remove
                              </Button>
                            </Group>
                          ))}
                        </Stack>
                      )}
                      
                      <Group>
                        <TextInput
                          placeholder="Enter field name"
                          value={newFieldName}
                          onChange={(event) => setNewFieldName(event.currentTarget.value)}
                          flex={1}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              handleAddField();
                            }
                          }}
                        />
                        <Button
                          leftSection={<IconPlus size={16} />}
                          onClick={handleAddField}
                          disabled={!newFieldName.trim()}
                        >
                          Add Field
                        </Button>
                      </Group>
                    </Stack>
                  </Paper>

                  <Divider />

                  <Paper p="md" withBorder>
                    <Stack spacing="md">
                      <Title order={3}>Danger Zone</Title>
                      <Text size="sm" c="dimmed">
                        Delete this vocabulary permanently. This action cannot be undone.
                      </Text>
                      <div>
                        <Button
                          color="red"
                          leftSection={<IconTrash size={16} />}
                          onClick={openDeleteModal}
                        >
                          Delete Vocabulary
                        </Button>
                      </div>
                    </Stack>
                  </Paper>
                </Stack>
              </Tabs.Panel>
            )}
          </Tabs>
        )}

        {isNewVocabulary && (
          <Stack spacing="lg">
            <Title order={2}>Create New Vocabulary</Title>
            
            <Paper p="md" withBorder>
              <Stack spacing="md">
                <TextInput
                  label="Vocabulary Name"
                  placeholder="Enter vocabulary name"
                  value={editedName}
                  onChange={(event) => setEditedName(event.currentTarget.value)}
                  required
                  autoFocus
                  description="Choose a descriptive name for your vocabulary"
                  error={editedName && !editedName.trim() ? "Name cannot be empty" : null}
                />
              </Stack>
            </Paper>

            <Paper p="md" withBorder>
              <Stack spacing="md">
                <Title order={3}>Custom Fields (Optional)</Title>
                <Text size="sm" c="dimmed">
                  Add custom fields to vocabulary items. Field names cannot be "form" or duplicate existing fields (case-insensitive).
                </Text>
                
                {customFields.length > 0 && (
                  <Stack spacing="xs">
                    {customFields.map(field => (
                      <Group key={field} justify="space-between">
                        <Group>
                          <Text>{field}</Text>
                          <Switch
                            size="xs"
                            label="Show inline"
                            labelPosition="left"
                            checked={fieldConfigs[field]?.inline || false}
                            onChange={() => handleToggleInline(field)}
                          />
                        </Group>
                        <Button
                          size="xs"
                          variant="light"
                          color="red"
                          leftSection={<IconX size={14} />}
                          onClick={() => handleRemoveField(field)}
                        >
                          Remove
                        </Button>
                      </Group>
                    ))}
                  </Stack>
                )}
                
                <Group>
                  <TextInput
                    placeholder="Enter field name"
                    value={newFieldName}
                    onChange={(event) => setNewFieldName(event.currentTarget.value)}
                    flex={1}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        handleAddField();
                      }
                    }}
                  />
                  <Button
                    leftSection={<IconPlus size={16} />}
                    onClick={handleAddField}
                    disabled={!newFieldName.trim()}
                  >
                    Add Field
                  </Button>
                </Group>
              </Stack>
            </Paper>

            <Group justify="flex-end">
              <Button
                variant="default"
                onClick={() => navigate('/vocabularies')}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={!editedName.trim()}
              >
                Create Vocabulary
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>

      {/* Delete Confirmation Modal */}
      <Modal
        opened={deleteModalOpened}
        onClose={closeDeleteModal}
        title="Delete Vocabulary"
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
              You are about to permanently delete the vocabulary <strong>"{vocabulary?.name}"</strong>.
            </Text>
            <Text size="sm" mt="xs">
              This action cannot be undone and will remove all vocabulary items and their links.
            </Text>
          </Alert>

          <TextInput
            label={`To confirm, type "${vocabulary?.name}" below:`}
            placeholder="Enter vocabulary name"
            value={confirmDeleteName}
            onChange={(event) => setConfirmDeleteName(event.currentTarget.value)}
          />

          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                closeDeleteModal();
                setConfirmDeleteName('');
              }}
            >
              Cancel
            </Button>
            <Button
              color="red"
              onClick={handleDelete}
              disabled={confirmDeleteName !== vocabulary?.name}
              leftSection={<IconTrash size={16} />}
            >
              Delete Vocabulary
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Container>
  );
};