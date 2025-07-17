import { useState } from 'react';
import { 
  Stack, 
  Text, 
  Paper,
  TextInput,
  Button,
  Group,
  Select,
  Radio,
  Badge,
  TagsInput
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { IconPlus, IconTrash, IconChevronUp, IconChevronDown } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';

// Default annotation fields
const DEFAULT_FIELDS = [
  {
    name: 'Gloss',
    scope: 'Token',
    isCustom: false
  },
  {
    name: 'Translation',
    scope: 'Sentence', 
    isCustom: false
  }
];

// Default ignored tokens configuration
const DEFAULT_IGNORED_TOKENS = {
  mode: 'unicode-punctuation',
  unicodePunctuationExceptions: [],
  explicitIgnoredTokens: []
};

export const FieldsStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, getClient }) => {
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldScope, setNewFieldScope] = useState('Token');
  const [hoveredField, setHoveredField] = useState(null);

  // Initialize data with defaults if not already present
  if (!data?.fields) {
    onDataChange({ 
      fields: DEFAULT_FIELDS,
      ignoredTokens: DEFAULT_IGNORED_TOKENS
    });
  }

  const fields = data?.fields || [];
  const ignoredTokens = data?.ignoredTokens || DEFAULT_IGNORED_TOKENS;

  const handleAddField = () => {
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
    const isDuplicate = fields.some(field => 
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
      scope: newFieldScope,
      isCustom: true
    };

    onDataChange({
      ...data,
      fields: [...fields, newField]
    });

    setNewFieldName('');
    setNewFieldScope('Token');
    notifications.show({
      title: 'Field Added',
      message: `"${trimmedName}" has been added with ${newFieldScope} scope`,
      color: 'green'
    });
  };

  const handleDeleteField = (fieldName) => {
    const updatedFields = fields.filter(field => field.name !== fieldName);
    onDataChange({ ...data, fields: updatedFields });
    
    notifications.show({
      title: 'Field Removed',
      message: `"${fieldName}" has been removed`,
      color: 'blue'
    });
  };

  const handleMoveField = (fieldName, direction) => {
    const currentIndex = fields.findIndex(field => field.name === fieldName);
    if (currentIndex === -1) return;
    
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= fields.length) return;
    
    const newFields = [...fields];
    const [movedField] = newFields.splice(currentIndex, 1);
    newFields.splice(newIndex, 0, movedField);
    
    onDataChange({ ...data, fields: newFields });
  };

  const handleKeyPress = (event) => {
    if (event.key === 'Enter') {
      handleAddField();
    }
  };

  // Check if new field name would be a duplicate
  const wouldBeDuplicate = () => {
    const trimmedName = newFieldName.trim();
    if (!trimmedName) return false;
    return fields.some(field => 
      field.name.toLowerCase() === trimmedName.toLowerCase()
    );
  };

  const handleIgnoredTokensModeChange = (mode) => {
    onDataChange({
      ...data,
      ignoredTokens: {
        ...ignoredTokens,
        mode
      }
    });
  };

  const handleExceptionsChange = (exceptions) => {
    onDataChange({
      ...data,
      ignoredTokens: {
        ...ignoredTokens,
        unicodePunctuationExceptions: exceptions
      }
    });
  };

  const handleExplicitTokensChange = (tokens) => {
    onDataChange({
      ...data,
      ignoredTokens: {
        ...ignoredTokens,
        explicitIgnoredTokens: tokens
      }
    });
  };

  // Prepare data for the table
  const tableData = fields.map((field, index) => ({
    ...field,
    id: `${field.name}-${index}` // Unique ID for table
  }));

  return (
    <Stack spacing="xl">
      {/* Explanatory header */}
      <div>
        <Text>
          Configure annotation fields for your project. <Badge color="blue" variant="light" size="sm">Token</Badge> scope 
          fields apply to individual words or morphemes, while <Badge color="green" variant="light" size="sm">Sentence</Badge> scope 
          fields apply to entire sentences or phrases.
        </Text>
      </div>

      {/* Annotation Fields Section */}
      <Paper p="md" withBorder>
        <Text size="md" fw={500} mb="md">Annotation Fields</Text>
        
        <DataTable
          textSelectionDisabled
          withTableBorder
          withRowBorders
          highlightOnHover
          columns={[
            {
              accessor: 'name',
              title: 'Field Name',
              width: '70%',
              render: (record) => {
                return (
                  <Group 
                    justify="space-between" 
                    onMouseEnter={() => setHoveredField(record.name)}
                    onMouseLeave={() => setHoveredField(null)}
                    style={{ width: '100%' }}
                  >
                    <Text>{record.name}</Text>
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
                          event.stopPropagation();
                          handleDeleteField(record.name);
                        }}
                      >
                        <IconTrash size={14} />
                      </Button>
                    </Group>
                  </Group>
                );
              }
            },
            {
              accessor: 'scope',
              title: 'Scope',
              width: '30%',
              render: (record) => (
                <Badge 
                  color={record.scope === 'Token' ? 'blue' : 'green'} 
                  variant="light"
                  size="sm"
                >
                  {record.scope}
                </Badge>
              )
            }
          ]}
          records={tableData}
          minHeight={150}
        />

        {/* Add Field Form */}
        <Paper p="md">
          <Text size="md" fw={500} mb="md">Add Field</Text>
          <Group>
            <TextInput
              placeholder="Enter field name"
              value={newFieldName}
              onChange={(event) => setNewFieldName(event.currentTarget.value)}
              onKeyDown={handleKeyPress}
              flex={1}
            />
            <Select
              value={newFieldScope}
              onChange={setNewFieldScope}
              data={[
                { value: 'Token', label: 'Token' },
                { value: 'Sentence', label: 'Sentence' }
              ]}
              w={120}
            />
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={handleAddField}
              disabled={!newFieldName.trim() || wouldBeDuplicate()}
            >
              Add Field
            </Button>
          </Group>
        </Paper>
      </Paper>

      {/* Ignored Tokens Section */}
      <Paper p="md" withBorder>
        <Text size="md" fw={500} mb="md">Ignored Tokens</Text>
        <Text size="sm" c="dimmed" mb="lg">
          Configure which tokens should be ignored when applying <Badge color="blue" variant="light" size="sm">Token</Badge> scope annotations.
        </Text>

        <Radio.Group
          value={ignoredTokens.mode}
          onChange={handleIgnoredTokensModeChange}
        >
          <Stack spacing="lg">
            <Radio
              value="unicode-punctuation"
              label="Unicode Punctuation (Recommended)"
              description="Automatically ignore all Unicode punctuation characters (category 'P')"
            />
            
            {ignoredTokens.mode === 'unicode-punctuation' && (
              <Paper p="md" ml="xl" withBorder>
                <Text size="sm" fw={500} mb="xs">
                  Punctuation Exceptions
                </Text>
                <Text size="xs" c="dimmed" mb="md">
                  These punctuation marks will NOT be ignored and can receive <Badge color="blue" variant="light" size="sm">Token</Badge> scope annotations:
                </Text>
                <TagsInput
                  placeholder={"Add punctuation to include (e.g. ', \", -)"}
                  value={ignoredTokens.unicodePunctuationExceptions}
                  onChange={handleExceptionsChange}
                  splitChars={[',']}
                />
              </Paper>
            )}

            <Radio
              value="explicit-list"
              label="Explicit List"
              description="Manually specify which tokens to ignore"
            />
            
            {ignoredTokens.mode === 'explicit-list' && (
              <Paper p="md" ml="xl" withBorder>
                <Text size="sm" fw={500} mb="xs">
                  Ignored Tokens
                </Text>
                <Text size="xs" c="dimmed" mb="md">
                  These specific tokens will be ignored for <Badge color="blue" variant="light" size="sm">Token</Badge> scope annotations:
                </Text>
                <TagsInput
                  placeholder="Add tokens to ignore (e.g. . , ; !)"
                  value={ignoredTokens.explicitIgnoredTokens}
                  onChange={handleExplicitTokensChange}
                  splitChars={[',']}
                />
              </Paper>
            )}
          </Stack>
        </Radio.Group>
      </Paper>
    </Stack>
  );
};

// Validation function for this step
FieldsStep.isValid = (data) => {
  // Must have at least one annotation field
  return data?.fields && data.fields.length > 0;
};