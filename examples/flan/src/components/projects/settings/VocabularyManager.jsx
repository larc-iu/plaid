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
  Modal
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import IconPlus from '@tabler/icons-react/dist/esm/icons/IconPlus.mjs';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';
import IconCheck from '@tabler/icons-react/dist/esm/icons/IconCheck.mjs';
import IconX from '@tabler/icons-react/dist/esm/icons/IconX.mjs';
import IconChevronUp from '@tabler/icons-react/dist/esm/icons/IconChevronUp.mjs';
import IconChevronDown from '@tabler/icons-react/dist/esm/icons/IconChevronDown.mjs';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconUnlink from '@tabler/icons-react/dist/esm/icons/IconUnlink.mjs';
import IconAlertTriangle from '@tabler/icons-react/dist/esm/icons/IconAlertTriangle.mjs';
import { notifications } from '@mantine/notifications';
import { useDisclosure } from '@mantine/hooks';

export const VocabularyManager = ({ 
  initialData,
  onLoadData,
  onSaveChanges,
  onError,
  showTitle = true,
  isSettings = false // New prop to control behavior differences
}) => {
  const [vocabularies, setVocabularies] = useState([]);
  const [newVocabName, setNewVocabName] = useState('');
  const [hoveredVocab, setHoveredVocab] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);
  const [unlinkModalOpened, { open: openUnlinkModal, close: closeUnlinkModal }] = useDisclosure(false);
  const [vocabToUnlink, setVocabToUnlink] = useState(null);

  // Initialize data on mount
  useEffect(() => {
    const initializeData = async () => {
      try {
        setLoading(true);
        let vocabData = initialData;
        
        // If no initial data provided, try loading from callback
        if (!vocabData && onLoadData) {
          vocabData = await onLoadData();
        }
        
        // If still no data, use empty array
        if (!vocabData?.vocabularies) {
          vocabData = { vocabularies: [] };
        }
        
        setVocabularies(vocabData.vocabularies);
        setIsInitialized(true);
        setError('');
      } catch (err) {
        console.error('Failed to load vocabularies configuration:', err);
        setError('Failed to load vocabularies');
        setVocabularies([]);
        setIsInitialized(true);
        
        if (onError) {
          onError(err);
        } else {
          notifications.show({
            title: 'Load Error',
            message: 'Failed to load vocabularies configuration',
            color: 'red'
          });
        }
      } finally {
        setLoading(false);
      }
    };

    initializeData();
  }, [initialData]);

  const saveChanges = async (newVocabularies) => {
    try {
      if (onSaveChanges) {
        await onSaveChanges({ vocabularies: newVocabularies });
      }
      setVocabularies(newVocabularies);
    } catch (error) {
      console.error('Failed to save vocabularies configuration:', error);
      if (onError) {
        onError(error);
      } else {
        notifications.show({
          title: 'Save Error',
          message: 'Failed to save vocabularies configuration',
          color: 'red'
        });
      }
    }
  };

  const handleVocabToggle = async (vocabName, enabled) => {
    // For settings mode, handle unlinking with confirmation
    if (isSettings && !enabled) {
      const vocab = vocabularies.find(v => v.name === vocabName);
      if (vocab) {
        setVocabToUnlink(vocab);
        openUnlinkModal();
        return;
      }
    }
    
    const updatedVocabs = vocabularies.map(vocab =>
      vocab.name === vocabName ? { ...vocab, enabled } : vocab
    );
    await saveChanges(updatedVocabs);
  };

  const handleConfirmUnlink = async () => {
    if (!vocabToUnlink) return;
    
    const updatedVocabs = vocabularies.map(vocab =>
      vocab.name === vocabToUnlink.name ? { ...vocab, enabled: false } : vocab
    );
    await saveChanges(updatedVocabs);
    
    closeUnlinkModal();
    setVocabToUnlink(null);
  };

  const handleAddCustomVocab = async () => {
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

    const updatedVocabs = [...vocabularies, newVocab];
    await saveChanges(updatedVocabs);

    setNewVocabName('');
    notifications.show({
      title: 'Vocabulary Added',
      message: `"${trimmedName}" has been added to your vocabularies`,
      color: 'green'
    });
  };

  const handleDeleteCustomVocab = async (vocabName) => {
    const updatedVocabs = vocabularies.filter(vocab => vocab.name !== vocabName);
    await saveChanges(updatedVocabs);
    
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

  const handleMoveVocab = async (vocabName, direction) => {
    const currentIndex = vocabularies.findIndex(vocab => vocab.name === vocabName);
    if (currentIndex === -1) return;
    
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= vocabularies.length) return;
    
    const newVocabs = [...vocabularies];
    const [movedVocab] = newVocabs.splice(currentIndex, 1);
    newVocabs.splice(newIndex, 0, movedVocab);
    
    await saveChanges(newVocabs);
  };

  // Don't render until initialized
  if (!isInitialized || loading) {
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

  // Prepare data for the table
  const tableData = vocabularies.map((vocab, index) => ({
    ...vocab,
    tableId: `${vocab.name}-${index}` // Unique ID for table
  }));

  return (
    <Stack spacing="xl">
      {/* Vocabularies Table */}
      <Paper p="md" withBorder>
        {showTitle && <Text size="md" fw={500} mb="md">Available Vocabularies</Text>}
        
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
                      {/* Only show move buttons in setup mode */}
                      {!isSettings && (
                        <>
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
                        </>
                      )}
                      
                      {/* Show unlink button for enabled vocabs in settings mode */}
                      {isSettings && record.enabled && (
                        <Button
                          size="xs"
                          color="orange"
                          variant="light"
                          style={{ 
                            opacity: hoveredVocab === record.name ? 1 : 0,
                            transition: 'opacity 0.2s ease'
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleVocabToggle(record.name, false);
                          }}
                        >
                          <IconUnlink size={14} />
                        </Button>
                      )}
                      
                      {/* Only show delete button for custom vocabs in setup mode */}
                      {!isSettings && record.isCustom && (
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

        {/* Add Custom Vocab - only in setup mode */}
        {!isSettings && (
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
        )}
      </Paper>

      {/* Unlink Confirmation Modal */}
      <Modal
        opened={unlinkModalOpened}
        onClose={closeUnlinkModal}
        title="Unlink Vocabulary"
        size="md"
        centered
      >
        <Stack spacing="md">
          <Alert
            icon={<IconAlertTriangle size={16} />}
            title="Warning"
            color="orange"
            variant="light"
          >
            <Text size="sm">
              You are about to unlink the vocabulary <strong>"{vocabToUnlink?.name}"</strong> from this project.
            </Text>
            <Text size="sm" mt="xs">
              This will delete all vocabulary item links for this vocabulary in this project. 
              The vocabulary itself will remain available for other projects.
            </Text>
          </Alert>

          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={closeUnlinkModal}
            >
              Cancel
            </Button>
            <Button
              color="orange"
              onClick={handleConfirmUnlink}
              leftSection={<IconUnlink size={16} />}
            >
              Unlink Vocabulary
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
};