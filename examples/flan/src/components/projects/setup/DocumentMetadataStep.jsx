import { useState } from 'react';
import { 
  Stack, 
  Text, 
  Alert,
  Paper,
  TextInput,
  Button,
  Group,
  Switch
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { IconPlus, IconTrash, IconCheck, IconX, IconChevronUp, IconChevronDown } from '@tabler/icons-react';
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

export const DocumentMetadataStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, getClient }) => {
  const [newFieldName, setNewFieldName] = useState('');
  const [hoveredField, setHoveredField] = useState(null);

  // Initialize data with predefined fields if not already present
  if (!data?.enabledFields) {
    const initialFields = Object.entries(PREDEFINED_FIELDS).map(([name, enabled])=> ({
      name,
      enabled: enabled,
      isCustom: false
    }));
    onDataChange({ enabledFields: initialFields });
  }

  const enabledFields = data?.enabledFields || [];

  const handleFieldToggle = (fieldName, enabled) => {
    console.log('handleFieldToggle called with:', fieldName, enabled);
    console.log('Current enabledFields:', enabledFields);
    const updatedFields = enabledFields.map(field =>
      field.name === fieldName ? { ...field, enabled } : field
    );
    console.log('Updated fields:', updatedFields);
    onDataChange({ ...data, enabledFields: updatedFields });
  };

  const handleAddCustomField = () => {
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

    onDataChange({
      ...data,
      enabledFields: [...enabledFields, newField]
    });

    setNewFieldName('');
    notifications.show({
      title: 'Field Added',
      message: `"${trimmedName}" has been added to your metadata fields`,
      color: 'green'
    });
  };

  const handleDeleteCustomField = (fieldName) => {
    const updatedFields = enabledFields.filter(field => field.name !== fieldName);
    onDataChange({ ...data, enabledFields: updatedFields });
    
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

  const handleMoveField = (fieldName, direction) => {
    const currentIndex = enabledFields.findIndex(field => field.name === fieldName);
    if (currentIndex === -1) return;
    
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= enabledFields.length) return;
    
    const newFields = [...enabledFields];
    const [movedField] = newFields.splice(currentIndex, 1);
    newFields.splice(newIndex, 0, movedField);
    
    onDataChange({ ...data, enabledFields: newFields });
  };

  // Prepare data for the table
  const tableData = enabledFields.map((field, index) => ({
    ...field,
    id: `${field.name}-${index}` // Unique ID for table
  }));

  return (
    <Stack spacing="xl">
      {/* Explanatory header */}
      <div>
        <Text>
          Configure which metadata fields you want to collect for each document in your project.
        </Text>
      </div>

      {/* Metadata Fields Table */}
      <Paper p="md" withBorder>
        <Text size="md" fw={500} mb="md">Available Metadata Fields</Text>
        
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

// Validation function for this step
DocumentMetadataStep.isValid = (data) => {
  // Step is always valid - having no metadata fields is acceptable
  // This allows projects that don't need document metadata to proceed
  return true;
};