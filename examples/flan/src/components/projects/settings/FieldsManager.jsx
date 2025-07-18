import { useState, useEffect } from 'react';
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
import IconPlus from '@tabler/icons-react/dist/esm/icons/IconPlus.mjs';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';
import IconChevronUp from '@tabler/icons-react/dist/esm/icons/IconChevronUp.mjs';
import IconChevronDown from '@tabler/icons-react/dist/esm/icons/IconChevronDown.mjs';
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

export const FieldsManager = ({ 
  initialData,
  onLoadData,
  onSaveChanges,
  onError,
  showTitle = true
}) => {
  const [fields, setFields] = useState([]);
  const [ignoredTokens, setIgnoredTokens] = useState(DEFAULT_IGNORED_TOKENS);
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldScope, setNewFieldScope] = useState('Token');
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
        
        // If still no data, use defaults
        if (!fieldsData?.fields) {
          fieldsData = {
            fields: DEFAULT_FIELDS,
            ignoredTokens: DEFAULT_IGNORED_TOKENS
          };
        }
        
        setFields(fieldsData.fields);
        setIgnoredTokens(fieldsData.ignoredTokens || DEFAULT_IGNORED_TOKENS);
        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to load fields configuration:', error);
        // Still set as initialized even on error, so we show the default fields
        setFields(DEFAULT_FIELDS);
        setIgnoredTokens(DEFAULT_IGNORED_TOKENS);
        setIsInitialized(true);
        
        if (onError) {
          onError(error);
        } else {
          notifications.show({
            title: 'Load Error',
            message: 'Failed to load fields configuration',
            color: 'red'
          });
        }
      }
    };

    initializeData();
  }, [initialData]);

  const saveChanges = async (newFields, newIgnoredTokens) => {
    try {
      if (onSaveChanges) {
        await onSaveChanges({ 
          fields: newFields, 
          ignoredTokens: newIgnoredTokens 
        });
      }
      setFields(newFields);
      setIgnoredTokens(newIgnoredTokens);
    } catch (error) {
      console.error('Failed to save fields configuration:', error);
      if (onError) {
        onError(error);
      } else {
        notifications.show({
          title: 'Save Error',
          message: 'Failed to save fields configuration',
          color: 'red'
        });
      }
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

    const updatedFields = [...fields, newField];
    await saveChanges(updatedFields, ignoredTokens);

    setNewFieldName('');
    setNewFieldScope('Token');
    notifications.show({
      title: 'Field Added',
      message: `"${trimmedName}" has been added with ${newFieldScope} scope`,
      color: 'green'
    });
  };

  const handleDeleteField = async (fieldName) => {
    const updatedFields = fields.filter(field => field.name !== fieldName);
    await saveChanges(updatedFields, ignoredTokens);
    
    notifications.show({
      title: 'Field Removed',
      message: `"${fieldName}" has been removed`,
      color: 'blue'
    });
  };

  const handleMoveField = async (fieldName, direction) => {
    const currentIndex = fields.findIndex(field => field.name === fieldName);
    if (currentIndex === -1) return;
    
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= fields.length) return;
    
    const newFields = [...fields];
    const [movedField] = newFields.splice(currentIndex, 1);
    newFields.splice(newIndex, 0, movedField);
    
    await saveChanges(newFields, ignoredTokens);
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

  const handleIgnoredTokensModeChange = async (mode) => {
    const updatedIgnoredTokens = {
      ...ignoredTokens,
      mode
    };
    await saveChanges(fields, updatedIgnoredTokens);
  };

  const handleExceptionsChange = async (exceptions) => {
    const updatedIgnoredTokens = {
      ...ignoredTokens,
      unicodePunctuationExceptions: exceptions
    };
    await saveChanges(fields, updatedIgnoredTokens);
  };

  const handleExplicitTokensChange = async (tokens) => {
    const updatedIgnoredTokens = {
      ...ignoredTokens,
      explicitIgnoredTokens: tokens
    };
    await saveChanges(fields, updatedIgnoredTokens);
  };

  // Don't render until initialized
  if (!isInitialized) {
    return (
      <Paper p="md" withBorder>
        <Text>Loading fields configuration...</Text>
      </Paper>
    );
  }

  // Prepare data for the table
  const tableData = fields.map((field, index) => ({
    ...field,
    id: `${field.name}-${index}` // Unique ID for table
  }));

  return (
    <Stack spacing="xl">
      {/* Annotation Fields Section */}
      <Paper p="md" withBorder>
        {showTitle && <Text size="md" fw={500} mb="md">Annotation Fields</Text>}
        
        <DataTable
          textSelectionDisabled
          withTableBorder
          withRowBorders
          highlightOnHover
          columns={[
            {
              accessor: 'scope',
              title: 'Scope',
              width: '15%',
              render: (record) => (
                  <Badge
                      color={record.scope === 'Token' ? 'blue' : 'green'}
                      variant="light"
                      size="sm"
                  >
                    {record.scope}
                  </Badge>
              )
            },
            {
              accessor: 'name',
              title: 'Field Name',
              width: '85%',
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
        <Text size="sm" c="dimmed" mb="lg" component="div">
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