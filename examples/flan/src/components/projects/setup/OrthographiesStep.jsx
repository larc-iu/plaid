import { useState } from 'react';
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
import { IconPlus, IconTrash, IconChevronUp, IconChevronDown } from '@tabler/icons-react';
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

export const OrthographiesStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, getClient }) => {
  const [newOrthographyName, setNewOrthographyName] = useState('');
  const [hoveredOrthography, setHoveredOrthography] = useState(null);

  // Initialize data with default orthographies if not already present
  if (!data?.orthographies) {
    onDataChange({ orthographies: DEFAULT_ORTHOGRAPHIES });
  }

  const orthographies = data?.orthographies || [];

  const handleAddCustomOrthography = () => {
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

    onDataChange({
      ...data,
      orthographies: [...orthographies, newOrthography]
    });

    setNewOrthographyName('');
    notifications.show({
      title: 'Orthography Added',
      message: `"${trimmedName}" has been added to your orthographies`,
      color: 'green'
    });
  };

  const handleDeleteOrthography = (orthographyName) => {
    // Cannot delete baseline orthography
    const orthography = orthographies.find(o => o.name === orthographyName);
    if (orthography?.isBaseline) {
      return;
    }

    const updatedOrthographies = orthographies.filter(orth => orth.name !== orthographyName);
    onDataChange({ ...data, orthographies: updatedOrthographies });
    
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

  const handleMoveOrthography = (orthographyName, direction) => {
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
    
    onDataChange({ ...data, orthographies: newOrthographies });
  };

  // Prepare data for the table
  const tableData = orthographies.map((orth, index) => ({
    ...orth,
    id: `${orth.name}-${index}` // Unique ID for table
  }));

  return (
    <Stack spacing="xl">
      {/* Explanatory header */}
      <div>
        <Text>
          Configure orthographic representations for your project. The <strong>Baseline</strong> orthography 
          represents your token layer and cannot be removed. You can add additional orthographies like IPA, 
          alternative writing systems, or normalized forms.
        </Text>
      </div>

      {/* Orthographies Table */}
      <Paper p="md" withBorder>
        <Text size="md" fw={500} mb="md">Available Orthographies</Text>
        
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

// Validation function for this step
OrthographiesStep.isValid = (data) => {
  // Step is always valid - baseline orthography is always present
  // Having additional orthographies is optional
  return true;
};