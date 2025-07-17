import { useState, useEffect } from 'react';
import { 
  Stack, 
  Text, 
  Paper,
  TextInput,
  Button,
  Group,
  Loader,
  Alert
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { IconPlus, IconTrash, IconCheck, IconX, IconChevronUp, IconChevronDown, IconInfoCircle } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';

export const VocabularyStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, getClient }) => {
  const [newVocabName, setNewVocabName] = useState('');
  const [hoveredVocab, setHoveredVocab] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const vocabularies = data?.vocabularies || [];

  // Fetch available vocabularies on mount
  useEffect(() => {
    const fetchVocabs = async () => {
      try {
        setLoading(true);
        const client = getClient();
        if (!client) throw new Error('Not authenticated');
        
        const vocabList = await client.vocabLayers.list();
        
        // Transform API vocabs into our format
        const initialVocabs = (vocabList || []).map(vocab => ({
          name: vocab.name || vocab.id,
          id: vocab.id,
          enabled: false, // Default to disabled
          isCustom: false // Existing vocabs from API
        }));
        
        onDataChange({ vocabularies: initialVocabs });
        setError('');
      } catch (err) {
        console.error('Error fetching vocabularies:', err);
        setError('Failed to load vocabularies');
      } finally {
        setLoading(false);
      }
    };

    // Only fetch if we don't have vocabularies yet
    if (!data?.vocabularies) {
      fetchVocabs();
    } else {
      setLoading(false);
    }
  }, [getClient]);

  const handleVocabToggle = (vocabName, enabled) => {
    const updatedVocabs = vocabularies.map(vocab =>
      vocab.name === vocabName ? { ...vocab, enabled } : vocab
    );
    onDataChange({ ...data, vocabularies: updatedVocabs });
  };

  const handleAddCustomVocab = () => {
    const trimmedName = newVocabName.trim();
    
    if (!trimmedName) {
      notifications.show({
        title: 'Invalid Vocabulary Name',
        message: 'Vocabulary name cannot be empty',
        color: 'red'
      });
      return;
    }

    // Check for duplicate names (case insensitive)
    const isDuplicate = vocabularies.some(vocab => 
      vocab.name.toLowerCase() === trimmedName.toLowerCase()
    );

    if (isDuplicate) {
      notifications.show({
        title: 'Duplicate Vocabulary',
        message: 'A vocabulary with this name already exists',
        color: 'red'
      });
      return;
    }

    const newVocab = {
      name: trimmedName,
      id: `new-${Date.now()}`, // Temporary ID for new vocabs
      enabled: true, // New custom vocabs are enabled by default
      isCustom: true
    };

    onDataChange({
      ...data,
      vocabularies: [...vocabularies, newVocab]
    });

    setNewVocabName('');
    notifications.show({
      title: 'Vocabulary Added',
      message: `"${trimmedName}" has been added to your vocabularies`,
      color: 'green'
    });
  };

  const handleDeleteCustomVocab = (vocabName) => {
    const updatedVocabs = vocabularies.filter(vocab => vocab.name !== vocabName);
    onDataChange({ ...data, vocabularies: updatedVocabs });
    
    notifications.show({
      title: 'Vocabulary Removed',
      message: `"${vocabName}" has been removed`,
      color: 'blue'
    });
  };

  const handleKeyPress = (event) => {
    if (event.key === 'Enter') {
      handleAddCustomVocab();
    }
  };

  // Check if new vocab name would be a duplicate
  const wouldBeDuplicate = () => {
    const trimmedName = newVocabName.trim();
    if (!trimmedName) return false;
    return vocabularies.some(vocab => 
      vocab.name.toLowerCase() === trimmedName.toLowerCase()
    );
  };

  const handleMoveVocab = (vocabName, direction) => {
    const currentIndex = vocabularies.findIndex(vocab => vocab.name === vocabName);
    if (currentIndex === -1) return;
    
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= vocabularies.length) return;
    
    const newVocabs = [...vocabularies];
    const [movedVocab] = newVocabs.splice(currentIndex, 1);
    newVocabs.splice(newIndex, 0, movedVocab);
    
    onDataChange({ ...data, vocabularies: newVocabs });
  };

  // Prepare data for the table
  const tableData = vocabularies.map((vocab, index) => ({
    ...vocab,
    tableId: `${vocab.name}-${index}` // Unique ID for table
  }));

  if (loading) {
    return (
      <Stack spacing="lg" align="center">
        <Loader size="md" />
        <Text>Loading vocabularies...</Text>
      </Stack>
    );
  }

  if (error) {
    return (
      <Alert color="red" title="Error" icon={<IconInfoCircle size={16} />}>
        {error}
      </Alert>
    );
  }

  return (
    <Stack spacing="xl">
      {/* Explanatory header */}
      <div>
        <Text>
          Configure vocabularies for your project. Vocabularies allow you to link tokens to 
          document-independent vocabulary entries, allowing you to track constructs such as
          morphemes, words, or multi-word expressions.
        </Text>
      </div>

      {/* Vocabularies Table */}
      <Paper p="md" withBorder>
        <Text size="md" fw={500} mb="md">Available Vocabularies</Text>
        
        <DataTable
          textSelectionDisabled
          withTableBorder
          withRowBorders
          highlightOnHover
          onRowClick={({ record }) => {
            handleVocabToggle(record.name, !record.enabled);
          }}
          styles={{
            table: {
              cursor: 'pointer'
            }
          }}
          columns={[
            {
              accessor: 'enabled', 
              title: 'Link',
              width: '10%',
              render: (record) => (
                record.enabled ? (
                  <IconCheck size={18} color="green" />
                ) : (
                  <IconX size={18} color="gray" />
                )
              )
            },
            {
              accessor: 'name',
              title: 'Vocabulary Name',
              width: '90%',
              render: (record) => {
                return (
                  <Group 
                    justify="space-between" 
                    onMouseEnter={() => setHoveredVocab(record.name)}
                    onMouseLeave={() => setHoveredVocab(null)}
                    style={{ width: '100%' }}
                  >
                    <Text 
                      c={record.enabled ? undefined : 'dimmed'}
                      fs={record.enabled ? undefined : 'italic'}
                    >
                      {record.name}
                    </Text>
                    <Group spacing="xs">
                      <Button
                        size="xs"
                        variant="light"
                        color="gray"
                        style={{ 
                          opacity: hoveredVocab === record.name ? 1 : 0,
                          transition: 'opacity 0.2s ease'
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMoveVocab(record.name, 'up');
                        }}
                        disabled={tableData.findIndex(item => item.name === record.name) === 0}
                      >
                        <IconChevronUp size={12} />
                      </Button>
                      <Button
                        size="xs"
                        variant="light"
                        color="gray"
                        style={{ 
                          opacity: hoveredVocab === record.name ? 1 : 0,
                          transition: 'opacity 0.2s ease'
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMoveVocab(record.name, 'down');
                        }}
                        disabled={tableData.findIndex(item => item.name === record.name) === tableData.length - 1}
                      >
                        <IconChevronDown size={12} />
                      </Button>
                      {/* Only show delete button for custom vocabs */}
                      {record.isCustom && (
                        <Button
                          size="xs"
                          color="red"
                          variant="light"
                          style={{ 
                            opacity: hoveredVocab === record.name ? 1 : 0,
                            transition: 'opacity 0.2s ease'
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleDeleteCustomVocab(record.name);
                          }}
                        >
                          <IconTrash size={14} />
                        </Button>
                      )}
                    </Group>
                  </Group>
                );
              }
            }
          ]}
          records={tableData}
          minHeight={200}
        />

        {/* Add Custom Vocab */}
        <Paper p="md">
          <Text size="md" fw={500} mb="md">Add New Vocabulary</Text>
          <Group>
            <TextInput
                placeholder="Enter vocabulary name"
                value={newVocabName}
                onChange={(event) => setNewVocabName(event.currentTarget.value)}
                onKeyDown={handleKeyPress}
                flex={1}
            />
            <Button
                leftSection={<IconPlus size={16} />}
                onClick={handleAddCustomVocab}
                disabled={!newVocabName.trim() || wouldBeDuplicate()}
            >
              Add Vocabulary
            </Button>
          </Group>
        </Paper>
      </Paper>
    </Stack>
  );
};

// Validation function for this step
VocabularyStep.isValid = (data) => {
  // Step is always valid - vocabularies are optional
  // Users can proceed without any vocabularies if they don't need this feature
  return true;
};