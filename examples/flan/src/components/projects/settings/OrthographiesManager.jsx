import { useState, useEffect } from 'react';
import { 
  Stack, 
  Text, 
  Paper,
  TextInput,
  Button,
  Group,
  Badge
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import IconPlus from '@tabler/icons-react/dist/esm/icons/IconPlus.mjs';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';
import IconChevronUp from '@tabler/icons-react/dist/esm/icons/IconChevronUp.mjs';
import IconChevronDown from '@tabler/icons-react/dist/esm/icons/IconChevronDown.mjs';
import { notifications } from '@mantine/notifications';

// Predefined orthography setup
const DEFAULT_ORTHOGRAPHIES = [
  {
    name: 'Baseline',
    isBaseline: true, // Cannot be deleted
    isCustom: false
  },
  {
    name: 'IPA',
    isBaseline: false,
    isCustom: false
  }
];

export const OrthographiesManager = ({ 
  initialData,
  onLoadData,
  onSaveChanges,
  onError,
  showTitle = true
}) => {
  const [orthographies, setOrthographies] = useState([]);
  const [newOrthographyName, setNewOrthographyName] = useState('');
  const [hoveredOrthography, setHoveredOrthography] = useState(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize data on mount
  useEffect(() => {
    const initializeData = async () => {
      try {
        let orthographiesData = initialData;
        
        // If no initial data provided, try loading from callback
        if (!orthographiesData && onLoadData) {
          orthographiesData = await onLoadData();
        }
        
        // If still no data, use default orthographies
        if (!orthographiesData?.orthographies) {
          orthographiesData = {
            orthographies: DEFAULT_ORTHOGRAPHIES
          };
        }
        
        setOrthographies(orthographiesData.orthographies);
        setIsInitialized(true);
        
        // Important: If we're using default data and onSaveChanges exists, 
        // save the defaults to the parent setup wizard
        if (!initialData?.orthographies && onSaveChanges) {
          await onSaveChanges(orthographiesData);
        }
      } catch (error) {
        console.error('Failed to load orthographies configuration:', error);
        // Still set as initialized even on error, so we show the default orthographies
        const defaultData = { orthographies: DEFAULT_ORTHOGRAPHIES };
        setOrthographies(DEFAULT_ORTHOGRAPHIES);
        setIsInitialized(true);
        
        // Save defaults even on error
        if (onSaveChanges) {
          try {
            await onSaveChanges(defaultData);
          } catch (saveError) {
            console.error('Failed to save default orthographies:', saveError);
          }
        }
        
        if (onError) {
          onError(error);
        } else {
          notifications.show({
            title: 'Load Error',
            message: 'Failed to load orthographies configuration',
            color: 'red'
          });
        }
      }
    };

    initializeData();
  }, [initialData]);

  const saveChanges = async (newOrthographies) => {
    try {
      if (onSaveChanges) {
        await onSaveChanges({ orthographies: newOrthographies });
      }
      setOrthographies(newOrthographies);
    } catch (error) {
      console.error('Failed to save orthographies configuration:', error);
      if (onError) {
        onError(error);
      } else {
        notifications.show({
          title: 'Save Error',
          message: 'Failed to save orthographies configuration',
          color: 'red'
        });
      }
    }
  };

  const handleAddCustomOrthography = async () => {
    const trimmedName = newOrthographyName.trim();
    
    if (!trimmedName) {
      notifications.show({
        title: 'Invalid Orthography Name',
        message: 'Orthography name cannot be empty',
        color: 'red'
      });
      return;
    }

    // Check for duplicate names (case insensitive)
    const isDuplicate = orthographies.some(orth => 
      orth.name.toLowerCase() === trimmedName.toLowerCase()
    );

    if (isDuplicate) {
      notifications.show({
        title: 'Duplicate Orthography',
        message: 'An orthography with this name already exists',
        color: 'red'
      });
      return;
    }

    const newOrthography = {
      name: trimmedName,
      isBaseline: false,
      isCustom: true
    };

    const updatedOrthographies = [...orthographies, newOrthography];
    await saveChanges(updatedOrthographies);

    setNewOrthographyName('');
    notifications.show({
      title: 'Orthography Added',
      message: `"${trimmedName}" has been added to your orthographies`,
      color: 'green'
    });
  };

  const handleDeleteOrthography = async (orthographyName) => {
    // Cannot delete baseline orthography
    const orthography = orthographies.find(o => o.name === orthographyName);
    if (orthography?.isBaseline) {
      return;
    }

    const updatedOrthographies = orthographies.filter(orth => orth.name !== orthographyName);
    await saveChanges(updatedOrthographies);
    
    notifications.show({
      title: 'Orthography Removed',
      message: `"${orthographyName}" has been removed`,
      color: 'blue'
    });
  };

  const handleKeyPress = (event) => {
    if (event.key === 'Enter') {
      handleAddCustomOrthography();
    }
  };

  // Check if new orthography name would be a duplicate
  const wouldBeDuplicate = () => {
    const trimmedName = newOrthographyName.trim();
    if (!trimmedName) return false;
    return orthographies.some(orth => 
      orth.name.toLowerCase() === trimmedName.toLowerCase()
    );
  };

  const handleMoveOrthography = async (orthographyName, direction) => {
    // Cannot move baseline orthography (it must stay first)
    const orthography = orthographies.find(o => o.name === orthographyName);
    if (orthography?.isBaseline) {
      return;
    }

    const currentIndex = orthographies.findIndex(orth => orth.name === orthographyName);
    if (currentIndex === -1) return;
    
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    
    // Don't allow moving above baseline (index 0)
    if (newIndex <= 0 || newIndex >= orthographies.length) return;
    
    const newOrthographies = [...orthographies];
    const [movedOrthography] = newOrthographies.splice(currentIndex, 1);
    newOrthographies.splice(newIndex, 0, movedOrthography);
    
    await saveChanges(newOrthographies);
  };

  // Don't render until initialized
  if (!isInitialized) {
    return (
      <Paper p="md" withBorder>
        <Text>Loading orthographies configuration...</Text>
      </Paper>
    );
  }

  // Prepare data for the table
  const tableData = orthographies.map((orth, index) => ({
    ...orth,
    id: `${orth.name}-${index}` // Unique ID for table
  }));

  return (
    <Stack spacing="xl">
      {/* Orthographies Table */}
      <Paper p="md" withBorder>
        {showTitle && <Text size="md" fw={500} mb="md">Available Orthographies</Text>}
        
        <DataTable
          textSelectionDisabled
          withTableBorder
          withRowBorders
          highlightOnHover
          columns={[
            {
              accessor: 'name',
              title: 'Orthography Name',
              width: '100%',
              render: (record) => {
                return (
                  <Group 
                    justify="space-between" 
                    onMouseEnter={() => setHoveredOrthography(record.name)}
                    onMouseLeave={() => setHoveredOrthography(null)}
                    style={{ width: '100%' }}
                  >
                    <Group spacing="sm">
                      <Text>{record.name}</Text>
                      {record.isBaseline && (
                        <Badge size="xs" variant="light" color="blue">
                          Required
                        </Badge>
                      )}
                    </Group>
                    <Group spacing="xs">
                      <Button
                        size="xs"
                        variant="light"
                        color="gray"
                        style={{ 
                          opacity: hoveredOrthography === record.name && !record.isBaseline ? 1 : 0,
                          transition: 'opacity 0.2s ease'
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMoveOrthography(record.name, 'up');
                        }}
                        disabled={record.isBaseline || tableData.findIndex(item => item.name === record.name) <= 1}
                      >
                        <IconChevronUp size={12} />
                      </Button>
                      <Button
                        size="xs"
                        variant="light"
                        color="gray"
                        style={{ 
                          opacity: hoveredOrthography === record.name && !record.isBaseline ? 1 : 0,
                          transition: 'opacity 0.2s ease'
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMoveOrthography(record.name, 'down');
                        }}
                        disabled={record.isBaseline || tableData.findIndex(item => item.name === record.name) === tableData.length - 1}
                      >
                        <IconChevronDown size={12} />
                      </Button>
                      <Button
                        size="xs"
                        color="red"
                        variant="light"
                        style={{ 
                          opacity: hoveredOrthography === record.name && !record.isBaseline ? 1 : 0,
                          transition: 'opacity 0.2s ease'
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!record.isBaseline) {
                            handleDeleteOrthography(record.name);
                          }
                        }}
                        disabled={record.isBaseline}
                      >
                        <IconTrash size={14} />
                      </Button>
                    </Group>
                  </Group>
                );
              }
            }
          ]}
          records={tableData}
          minHeight={200}
        />

        {/* Add Custom Orthography */}
        <Paper p="md">
          <Text size="md" fw={500} mb="md">Add Custom Orthography</Text>
          <Group>
            <TextInput
                placeholder="Enter orthography name"
                value={newOrthographyName}
                onChange={(event) => setNewOrthographyName(event.currentTarget.value)}
                onKeyDown={handleKeyPress}
                flex={1}
            />
            <Button
                leftSection={<IconPlus size={16} />}
                onClick={handleAddCustomOrthography}
                disabled={!newOrthographyName.trim() || wouldBeDuplicate()}
            >
              Add Orthography
            </Button>
          </Group>
        </Paper>
      </Paper>
    </Stack>
  );
};