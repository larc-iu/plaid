import { useState, useEffect } from 'react';
import { 
  Stack, 
  Text, 
  Paper,
  TextInput,
  Button,
  Group
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import IconPlus from '@tabler/icons-react/dist/esm/icons/IconPlus.mjs';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';
import IconCheck from '@tabler/icons-react/dist/esm/icons/IconCheck.mjs';
import IconX from '@tabler/icons-react/dist/esm/icons/IconX.mjs';
import IconChevronUp from '@tabler/icons-react/dist/esm/icons/IconChevronUp.mjs';
import IconChevronDown from '@tabler/icons-react/dist/esm/icons/IconChevronDown.mjs';
import { notifications } from '@mantine/notifications';

// Predefined metadata fields common in linguistic annotation
const PREDEFINED_FIELDS = {
  'Date': true,
  'Speakers': true,
  'Location': true,
  'Genre': false,
  'Recording Quality': false,
  'Transcriber': false
};

export const DocumentMetadataManager = ({ 
  initialData,
  onLoadData,
  onSaveChanges,
  onError,
  isLoading = false,
  showTitle = true
}) => {
  const [enabledFields, setEnabledFields] = useState([]);
  const [newFieldName, setNewFieldName] = useState('');
  const [hoveredField, setHoveredField] = useState(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize data on mount
  useEffect(() => {
    const initializeData = async () => {
      try {
        let fieldsData = initialData;
        
        // If no initial data provided, try loading from callback
        if (!fieldsData && onLoadData) {
          fieldsData = await onLoadData();
        }
        
        // If still no data, use predefined fields as default
        if (!fieldsData?.enabledFields) {
          fieldsData = {
            enabledFields: Object.entries(PREDEFINED_FIELDS).map(([name, enabled]) => ({
              name,
              enabled,
              isCustom: false
            }))
          };
        }
        
        setEnabledFields(fieldsData.enabledFields);
        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to load metadata configuration:', error);
        // Still set as initialized even on error, so we show the default fields
        const defaultFields = Object.entries(PREDEFINED_FIELDS).map(([name, enabled]) => ({
          name,
          enabled,
          isCustom: false
        }));
        setEnabledFields(defaultFields);
        setIsInitialized(true);
        
        if (onError) {
          onError(error);
        } else {
          notifications.show({
            title: 'Load Error',
            message: 'Failed to load metadata configuration',
            color: 'red'
          });
        }
      }
    };

    initializeData();
  }, [initialData]);

  const saveChanges = async (newFields) => {
    try {
      if (onSaveChanges) {
        await onSaveChanges({ enabledFields: newFields });
      }
      setEnabledFields(newFields);
    } catch (error) {
      console.error('Failed to save metadata configuration:', error);
      if (onError) {
        onError(error);
      } else {
        notifications.show({
          title: 'Save Error',
          message: 'Failed to save metadata configuration',
          color: 'red'
        });
      }
    }
  };

  const handleFieldToggle = async (fieldName, enabled) => {
    const updatedFields = enabledFields.map(field =>
      field.name === fieldName ? { ...field, enabled } : field
    );
    await saveChanges(updatedFields);
  };

  const handleAddCustomField = async () => {
    const trimmedName = newFieldName.trim();
    
    if (!trimmedName) {
      notifications.show({
        title: 'Invalid Field Name',
        message: 'Field name cannot be empty',
        color: 'red'
      });
      return;
    }

    // Check for duplicate names (case insensitive)
    const isDuplicate = enabledFields.some(field => 
      field.name.toLowerCase() === trimmedName.toLowerCase()
    );

    if (isDuplicate) {
      notifications.show({
        title: 'Duplicate Field',
        message: 'A field with this name already exists',
        color: 'red'
      });
      return;
    }

    const newField = {
      name: trimmedName,
      enabled: true, // New custom fields are enabled by default
      isCustom: true
    };

    const updatedFields = [...enabledFields, newField];
    await saveChanges(updatedFields);

    setNewFieldName('');
    notifications.show({
      title: 'Field Added',
      message: `"${trimmedName}" has been added to your metadata fields`,
      color: 'green'
    });
  };

  const handleDeleteCustomField = async (fieldName) => {
    const updatedFields = enabledFields.filter(field => field.name !== fieldName);
    await saveChanges(updatedFields);
    
    notifications.show({
      title: 'Field Removed',
      message: `"${fieldName}" has been removed`,
      color: 'blue'
    });
  };

  const handleKeyPress = (event) => {
    if (event.key === 'Enter') {
      handleAddCustomField();
    }
  };

  // Check if new field name would be a duplicate
  const wouldBeDuplicate = () => {
    const trimmedName = newFieldName.trim();
    if (!trimmedName) return false;
    return enabledFields.some(field => 
      field.name.toLowerCase() === trimmedName.toLowerCase()
    );
  };

  const handleMoveField = async (fieldName, direction) => {
    const currentIndex = enabledFields.findIndex(field => field.name === fieldName);
    if (currentIndex === -1) return;
    
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= enabledFields.length) return;
    
    const newFields = [...enabledFields];
    const [movedField] = newFields.splice(currentIndex, 1);
    newFields.splice(newIndex, 0, movedField);
    
    await saveChanges(newFields);
  };

  // Don't render until initialized (but don't block on external isLoading)
  if (!isInitialized) {
    return (
      <Paper p="md" withBorder>
        <Text>Loading metadata configuration...</Text>
      </Paper>
    );
  }

  // Prepare data for the table
  const tableData = enabledFields.map((field, index) => ({
    ...field,
    id: `${field.name}-${index}` // Unique ID for table
  }));

  return (
    <Stack spacing="xl">
      {/* Metadata Fields Table */}
      <Paper p="md" withBorder>
        {showTitle && <Text size="md" fw={500} mb="md">Available Metadata Fields</Text>}
        
        <DataTable
          textSelectionDisabled
          withTableBorder
          withRowBorders
          highlightOnHover
          onRowClick={({ record }) => {
            handleFieldToggle(record.name, !record.enabled);
          }}
          styles={{
            table: {
              cursor: 'pointer'
            }
          }}
          columns={[
            {
              accessor: 'enabled', 
              title: 'Enabled',
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
              title: 'Field Name',
              width: '90%',
              render: (record) => {
                return (
                  <Group 
                    justify="space-between" 
                    onMouseEnter={() => setHoveredField(record.name)}
                    onMouseLeave={() => setHoveredField(null)}
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
                          opacity: hoveredField === record.name ? 1 : 0,
                          transition: 'opacity 0.2s ease'
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMoveField(record.name, 'up');
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
                          opacity: hoveredField === record.name ? 1 : 0,
                          transition: 'opacity 0.2s ease'
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMoveField(record.name, 'down');
                        }}
                        disabled={tableData.findIndex(item => item.name === record.name) === tableData.length - 1}
                      >
                        <IconChevronDown size={12} />
                      </Button>
                      <Button
                        size="xs"
                        color="red"
                        variant="light"
                        style={{ 
                          opacity: hoveredField === record.name ? 1 : 0,
                          transition: 'opacity 0.2s ease'
                        }}
                        onClick={(event) => {
                          event.stopPropagation(); // Prevent row click when clicking delete
                          if (record.isCustom) {
                            handleDeleteCustomField(record.name);
                          } else {
                            // For predefined fields, reset to default value instead of deleting
                            const defaultEnabled = PREDEFINED_FIELDS[record.name] || false;
                            handleFieldToggle(record.name, defaultEnabled);
                          }
                        }}
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

        {/* Add Custom Field */}
        <Paper p="md">
          <Text size="md" fw={500} mb="md">Add Custom Field</Text>
          <Group>
            <TextInput
                placeholder="Enter custom field name"
                value={newFieldName}
                onChange={(event) => setNewFieldName(event.currentTarget.value)}
                onKeyDown={handleKeyPress}
                flex={1}
            />
            <Button
                leftSection={<IconPlus size={16} />}
                onClick={handleAddCustomField}
                disabled={!newFieldName.trim() || wouldBeDuplicate()}
            >
              Add Field
            </Button>
          </Group>
        </Paper>
      </Paper>
    </Stack>
  );
};