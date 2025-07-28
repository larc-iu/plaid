import React, { useState, useEffect, useRef } from 'react';
import { 
  Popover, 
  Text, 
  Stack, 
  Tabs,
  ScrollArea,
  Button,
  TextInput,
  Group,
  Divider,
  ActionIcon
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { DataTable } from 'mantine-datatable';
import IconPlus from '@tabler/icons-react/dist/esm/icons/IconPlus.mjs';
import IconArrowLeft from '@tabler/icons-react/dist/esm/icons/IconArrowLeft.mjs';
import IconX from '@tabler/icons-react/dist/esm/icons/IconX.mjs';
import { useStrictClient } from '../contexts/StrictModeContext.jsx';

// Levenshtein distance function for string similarity
const levenshteinDistance = (str1, str2) => {
  const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));

  for (let i = 0; i <= str1.length; i++) {
    matrix[0][i] = i;
  }
  for (let j = 0; j <= str2.length; j++) {
    matrix[j][0] = j;
  }

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1, // deletion
        matrix[j - 1][i] + 1, // insertion
        matrix[j - 1][i - 1] + indicator // substitution
      );
    }
  }

  return matrix[str2.length][str1.length];
};

export const VocabLinkPopover = ({ 
  vocabularies, 
  token, 
  operations,
  children,
  readOnly = false 
}) => {
  const client = useStrictClient();
  const [selectedVocab, setSelectedVocab] = useState(null);
  const [localState, setLocalState] = useState({ type: 'none' });
  const [opened, setOpened] = useState(false);
  const popoverIdRef = useRef(`vocab-popover-${Math.random().toString(36).substr(2, 9)}`);
  
  const [isCreating, setIsCreating] = useState(false);
  const [newItemForm, setNewItemForm] = useState('');
  const [newItemFields, setNewItemFields] = useState({});

  // Convert vocabularies object to array and get vocab items
  const vocabsArray = Object.values(vocabularies || {});
  
  // Set default selected vocab if not set
  useEffect(() => {
    if (!selectedVocab && vocabsArray.length > 0) {
      setSelectedVocab(vocabsArray[0].id);
    }
  }, [vocabsArray, selectedVocab]);

  // Reset on token ID change (document reload)
  useEffect(() => {
    setLocalState({ type: 'none' });
    setIsCreating(false);
    setNewItemForm('');
    setNewItemFields({});
    setOpened(false);
  }, [token.id]);

  // Listen for close events from other popovers
  useEffect(() => {
    const handleCloseOtherPopovers = (event) => {
      if (event.detail !== popoverIdRef.current) {
        setOpened(false);
      }
    };

    window.addEventListener('closeVocabPopovers', handleCloseOtherPopovers);
    return () => {
      window.removeEventListener('closeVocabPopovers', handleCloseOtherPopovers);
    };
  }, []);

  // Hotkey to close popover with Escape
  useHotkeys([
    ['Escape', () => {
      if (opened) {
        setOpened(false);
      }
    }]
  ]);

  // Determine which vocab item to display based on local state
  const displayVocabItem = localState.type === 'unlinked' ? null :
    localState.type === 'linked' ? localState.item : token.vocabItem;

  const handleClick = (event) => {
    // Don't open popover in read-only mode
    if (readOnly) return;
    
    // Close all other vocab popovers
    window.dispatchEvent(new CustomEvent('closeVocabPopovers', { detail: popoverIdRef.current }));
    setOpened(true);
  };

  const handleVocabItemClick = async (vocabItem) => {
    // Close popover
    setOpened(false);

    // Check if this is the currently selected item - if so, unlink it
    const existingItem = displayVocabItem;
    if (existingItem && existingItem.id === vocabItem.id) {
      // Unlink the selected item
      setLocalState({ type: 'unlinked' });

      try {
        await operations.handleVocabOperation(() => client.vocabLinks.delete(existingItem.linkId));
      } catch (error) {
        setLocalState({ type: 'none' }); // Reset on error
      }
      return;
    }
    
    // Set local state for immediate UI feedback
    setLocalState({ type: 'linked', item: vocabItem });
    
    try {
      // Use batch operation to delete existing link and create new one
      await operations.handleVocabOperation(async () => {
        await client.beginBatch();
        
        // Delete existing vocab link if there is one
        if (existingItem) {
          await client.vocabLinks.delete(existingItem.linkId);
        }

        // Create new vocab link between token and vocab item
        await client.vocabLinks.create(vocabItem.id, [token.id]);
        
        const result = await client.submitBatch();
        
        // Update local state with link ID from server response
        setLocalState({ 
          type: 'linked', 
          item: { ...vocabItem, linkId: result[result.length - 1].body.id } 
        });
      });
    } catch (error) {
      setLocalState({ type: 'none' }); // Reset on error
    }
  };

  const handleCreateNew = () => {
    setIsCreating(true);
  };

  const handleBackToList = () => {
    setIsCreating(false);
    setNewItemForm('');
    setNewItemFields({});
  };

  const handleCreateNewItem = async () => {
    if (!newItemForm.trim()) {
      return;
    }

    const selectedVocabData = vocabsArray.find(v => v.id === selectedVocab);
    if (!selectedVocabData) {
      return;
    }

    // Reset create state
    setOpened(false);
    setIsCreating(false);
    setNewItemForm('');
    setNewItemFields({});

    try {
      await operations.handleVocabOperation(async () => {
        // Create the vocab item OUTSIDE of the batch
        const metadata = Object.keys(newItemFields).length > 0 ? newItemFields : undefined;
        const createResult = await client.vocabItems.create(selectedVocab, newItemForm.trim(), metadata);
        
        // Create the vocab item object for immediate display
        const newVocabItem = {
          id: createResult.id,
          form: newItemForm.trim(),
          metadata: metadata || {},
          vocabId: selectedVocab,
          vocabName: selectedVocabData.name
        };
        
        // Set local state to immediately show the new vocab item
        setLocalState({ type: 'linked', item: newVocabItem });
        
        // Use batch operation to delete existing link and create new one
        await client.beginBatch();
        
        // Delete existing vocab link if there is one
        const existingItem = token.vocabItem; // Always use server state
        if (existingItem) {
          await client.vocabLinks.delete(existingItem.linkId);
        }

        // Create vocab link between token and the new vocab item
        await client.vocabLinks.create(newVocabItem.id, [token.id]);
        
        const batchResult = await client.submitBatch();
        
        // Update local state with link ID from server response
        setLocalState({ 
          type: 'linked', 
          item: { ...newVocabItem, linkId: batchResult[batchResult.length - 1].body.id } 
        });
      });
      
    } catch (error) {
      setLocalState({ type: 'none' }); // Reset on error
    }
  };

  // Don't render if no vocabularies
  if (!vocabularies || vocabsArray.length === 0) {
    return children;
  }
  
  const selectedVocabData = vocabsArray.find(v => v.id === selectedVocab);

  return (
    <Popover 
      width={300}
      shadow="md" 
      position="bottom"
      withArrow
      opened={opened}
      onClose={() => setOpened(false)}
      closeOnClickOutside={false}
      closeOnEscape={true}
      trapFocus={false}
    >
      <Popover.Target>
        <div style={{ display: 'inline-block', cursor: readOnly ? 'default' : 'pointer' }} onClick={handleClick}>
          <div>
            {children}
          </div>
          {/* Vocabulary item form display - always render div for alignment */}
          <div style={{
            fontSize: '0.85em',
            color: '#666666',
            fontStyle: 'italic',
            marginTop: '2px',
            lineHeight: '1.1',
            minHeight: '1.1em' // Ensure consistent height even when empty
          }}>
            {displayVocabItem?.form || '\u00A0'} {/* Non-breaking space when no item */}
          </div>
        </div>
      </Popover.Target>
      
      <Popover.Dropdown>
        <div style={{ position: 'relative' }}>
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={() => setOpened(false)}
            style={{
              position: 'absolute',
              top: -21,
              right: -25,
              zIndex: 1000,
              backgroundColor: 'white',
              border: '1px solid #dee2e6',
              borderRadius: '50%'
            }}
          >
            <IconX size={14} />
          </ActionIcon>
          <Stack spacing="sm" style={{ minHeight: 300 }}>
          {isCreating ? (
            // Create new vocab item form
            <>
              <Group justify="space-between">
                <Text size="sm" fw={500}>Create New Item</Text>
                <Button
                  variant="subtle"
                  size="xs"
                  leftSection={<IconArrowLeft size={12} />}
                  onClick={handleBackToList}
                >
                  Back
                </Button>
              </Group>
              
              {vocabsArray.length > 1 && (
                <>
                  <Text size="xs" c="dimmed">
                    Creating in vocabulary: {vocabsArray.find(v => v.id === selectedVocab)?.name}
                  </Text>
                  <Divider />
                </>
              )}
              
              <CreateNewItemForm
                selectedVocab={selectedVocab}
                vocabularies={vocabularies}
                newItemForm={newItemForm}
                setNewItemForm={setNewItemForm}
                newItemFields={newItemFields}
                setNewItemFields={setNewItemFields}
                onCreateItem={handleCreateNewItem}
              />
            </>
          ) : (
            // Vocab items list
            <>
              {vocabsArray.length > 1 ? (
                <Tabs value={selectedVocab} onChange={setSelectedVocab}>
                  {vocabsArray.map(vocab => (
                      <Tabs.Panel key={vocab.id} value={vocab.id} pt="sm">
                        <VocabItemsGrid
                            vocab={vocab}
                            onItemClick={handleVocabItemClick}
                            existingVocabItem={displayVocabItem}
                            tokenForm={token.content}
                        />
                      </Tabs.Panel>
                  ))}
                  <Tabs.List>
                    {vocabsArray.map(vocab => (
                      <Tabs.Tab key={vocab.id} value={vocab.id}>
                        {vocab.name}
                      </Tabs.Tab>
                    ))}
                  </Tabs.List>
                </Tabs>
              ) : (
                <VocabItemsGrid
                  vocab={selectedVocabData}
                  onItemClick={handleVocabItemClick}
                  existingVocabItem={displayVocabItem}
                  tokenForm={token.content}
                />
              )}

              <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconPlus size={12} />}
                  onClick={handleCreateNew}
              >
                Create New
              </Button>
            </>
          )}
          </Stack>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
};

const CreateNewItemForm = ({ 
  selectedVocab, 
  vocabularies, 
  newItemForm, 
  setNewItemForm, 
  newItemFields, 
  setNewItemFields, 
  onCreateItem 
}) => {
  const selectedVocabData = Object.values(vocabularies)[0]?.id === selectedVocab ? 
    Object.values(vocabularies)[0] : 
    Object.values(vocabularies).find(v => v.id === selectedVocab);

  // Get fields that can be edited inline
  const inlineFields = [];
  if (selectedVocabData?.config?.plaid?.fields) {
    Object.entries(selectedVocabData.config.plaid.fields).forEach(([fieldName, fieldConfig]) => {
      if (fieldName.toLowerCase() !== 'form' && fieldConfig?.inline) {
        inlineFields.push(fieldName);
      }
    });
  }

  return (
    <Stack spacing="xs">
      <TextInput
        label="Form"
        placeholder="Enter form"
        size="sm"
        value={newItemForm}
        onChange={(event) => setNewItemForm(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onCreateItem();
          }
        }}
      />
      
      {inlineFields.length > 0 && (
        <>
          {inlineFields.map(fieldName => (
            <TextInput
              key={fieldName}
              label={fieldName}
              placeholder={fieldName}
              size="sm"
              value={newItemFields[fieldName] || ''}
              onChange={(event) => setNewItemFields({
                ...newItemFields,
                [fieldName]: event.currentTarget.value
              })}
            />
          ))}
        </>
      )}
      
      <Button
        onClick={onCreateItem}
        disabled={!newItemForm.trim()}
        size="xs"
        fullWidth
      >
        Create & Link
      </Button>
    </Stack>
  );
};

const VocabItemsGrid = ({ vocab, onItemClick, existingVocabItem, tokenForm }) => {
  const [searchQuery, setSearchQuery] = React.useState('');
  
  if (!vocab?.items || vocab.items.length === 0) {
    return (
      <Text size="sm" c="dimmed" ta="center" py="md">
        No vocabulary items available
      </Text>
    );
  }

  // Get fields that should be shown inline
  const inlineFields = [];
  if (vocab.config?.plaid?.fields) {
    Object.entries(vocab.config.plaid.fields).forEach(([fieldName, fieldConfig]) => {
      if (fieldName.toLowerCase() !== 'form' && fieldConfig?.inline) {
        inlineFields.push(fieldName);
      }
    });
  }

  // Filter items based on search query
  const filteredItems = vocab.items.filter(item => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    
    // Search in form
    if (item.form?.toLowerCase().includes(query)) return true;
    
    // Search in metadata fields
    if (item.metadata) {
      for (const [key, value] of Object.entries(item.metadata)) {
        if (value?.toString().toLowerCase().includes(query)) return true;
      }
    }
    
    return false;
  });
  
  // Sort items - existing vocab item first, then by edit distance to token form
  // Create plain copies of items to avoid valtio snapshot immutability issues
  const sortedItems = filteredItems.map(item => ({ ...item }));
  
  // Calculate edit distances and sort by similarity to token form
  if (tokenForm) {
    const tokenFormLower = tokenForm.toLowerCase();
    sortedItems.forEach(item => {
      item._editDistance = levenshteinDistance(tokenFormLower, item.form?.toLowerCase() || '');
    });
    
    // Sort by edit distance (smaller distance = more similar = higher priority)
    sortedItems.sort((a, b) => a._editDistance - b._editDistance);
  }
  
  // Move existing vocab item to front regardless of edit distance
  if (existingVocabItem && existingVocabItem.id) {
    const existingIndex = sortedItems.findIndex(item => item.id === existingVocabItem.id);
    if (existingIndex > -1) {
      const [existingItem] = sortedItems.splice(existingIndex, 1);
      sortedItems.unshift(existingItem);
    }
  }

  // Prepare columns for DataTable
  const columns = [
    {
      accessor: 'form',
      title: 'Form',
      width: inlineFields.length > 0 ? '50%' : '100%'
    },
    // Add columns for inline fields
    ...inlineFields.map(fieldName => ({
      accessor: fieldName,
      title: fieldName,
      width: `${50 / inlineFields.length}%`,
      render: (record) => record.metadata?.[fieldName] || ''
    }))
  ];

  return (
    <Stack spacing="xs">
      <ScrollArea h={250}>
        <DataTable
          textSelectionDisabled
          withTableBorder
          withRowBorders
          highlightOnHover
          columns={columns}
          records={sortedItems}
          noRecordsText={searchQuery ? "No items match your search" : "No vocabulary items available"}
          onRowClick={({ record }) => onItemClick(record)}
          rowStyle={(record) => {
            // Highlight existing vocab item in green
            if (record.id === existingVocabItem?.id) {
              return { backgroundColor: '#d3f9d8' }; // Light green
            }
            return {};
          }}
          styles={{
            table: { cursor: 'pointer' }
          }}
        />
      </ScrollArea>
      <TextInput
          placeholder="Search items..."
          size="xs"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          styles={{
            input: { height: 28 }
          }}
      />
    </Stack>
  );
};