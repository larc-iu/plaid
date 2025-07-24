import React, { useState, useEffect } from 'react';
import { 
  HoverCard, 
  Text, 
  Stack, 
  Tabs,
  ScrollArea,
  Button,
  TextInput,
  Group,
  Divider
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import IconPlus from '@tabler/icons-react/dist/esm/icons/IconPlus.mjs';
import IconArrowLeft from '@tabler/icons-react/dist/esm/icons/IconArrowLeft.mjs';
import { useStrictClient } from '../contexts/StrictModeContext.jsx';
import { useStrictModeErrorHandler } from '../hooks/useStrictModeErrorHandler';

export const VocabLinkHoverCard = ({ 
  vocabularies, 
  token, 
  onDocumentReload,
  children 
}) => {
  const client = useStrictClient();
  const handleStrictModeError = useStrictModeErrorHandler(onDocumentReload);
  const [selectedVocab, setSelectedVocab] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const [localVocabItem, setLocalVocabItem] = useState(null);
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

  // Reset local state when token.vocabItem changes from external source (document reload)
  useEffect(() => {
    setLocalVocabItem(null);
    setIsCreating(false);
    setNewItemForm('');
    setNewItemFields({});
  }, [token.vocabItem]);

  // Determine which vocab item to display - local state overrides token.vocabItem
  // If localVocabItem is the special "unlinked" state, don't display any item
  const displayVocabItem = localVocabItem?.unlinked ? null : (localVocabItem || token.vocabItem);

  const handleVocabItemClick = async (vocabItem) => {
    try {
      // Immediately close the hover card
      setIsOpen(false);
      
      // Check if this is the currently selected item - if so, unlink it
      const existingItem = displayVocabItem;
      if (existingItem && existingItem.id === vocabItem.id) {
        // Unlink the selected item
        // Set local state to a special "unlinked" state to prevent showing the item
        setLocalVocabItem({ unlinked: true }); 
        
        try {
          await client.vocabLinks.delete(existingItem.linkId);
        } catch (error) {
          handleStrictModeError(error, 'delete vocab link');
        }
        return;
      }
      
      // Set local state to immediately show the vocab item
      setLocalVocabItem(vocabItem);
      
      // Use batch operation to delete existing link and create new one
      await client.beginBatch();
      
      try {
        // Delete existing vocab link if there is one
        if (existingItem) {
          await client.vocabLinks.delete(existingItem.linkId);
        }

        // Create new vocab link between token and vocab item
        await client.vocabLinks.create(vocabItem.id, [token.id]);
        
        const result = await client.submitBatch();
        setLocalVocabItem({ ...vocabItem, linkId: result[result.length - 1].body.id })
      } catch (batchError) {
        handleStrictModeError(batchError, 'create vocab link');
        throw batchError;
      }
    } catch (error) {
      handleStrictModeError(error, 'create vocab link');
      setLocalVocabItem(null);
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

    try {
      const selectedVocabData = vocabsArray.find(v => v.id === selectedVocab);
      if (!selectedVocabData) {
        throw new Error('No vocabulary selected');
      }

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

      // Immediately close the hover card and reset create state
      setIsOpen(false);
      setIsCreating(false);
      setNewItemForm('');
      setNewItemFields({});
      
      // Set local state to immediately show the new vocab item
      setLocalVocabItem(newVocabItem);
      
      // Use batch operation to delete existing link and create new one
      client.beginBatch();
      
      try {
        // Delete existing vocab link if there is one
        const existingItem = displayVocabItem;
        if (existingItem) {
          client.vocabLinks.delete(existingItem.linkId);
        }

        // Create vocab link between token and the new vocab item
        client.vocabLinks.create(newVocabItem.id, [token.id]);
        
        const batchResult = await client.submitBatch();
        setLocalVocabItem({ ...vocabItem, linkId: batchResult[result.length - 1].body.id })
      } catch (batchError) {
        handleStrictModeError(batchError, 'create new vocab item');
        throw batchError;
      }
      
    } catch (error) {
      handleStrictModeError(error, 'create new vocab item');
      setLocalVocabItem(null);
    }
  };

  // Don't render if no vocabularies
  if (!vocabularies || vocabsArray.length === 0) {
    return children;
  }
  
  const selectedVocabData = vocabsArray.find(v => v.id === selectedVocab);

  return (
    <HoverCard 
      width={400} 
      shadow="md" 
      position="top"
      withArrow
      openDelay={100}
      closeDelay={100}
      opened={isOpen}
      onChange={setIsOpen}
    >
      <HoverCard.Target>
        <div style={{ display: 'inline-block', cursor: 'pointer' }}>
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
      </HoverCard.Target>
      
      <HoverCard.Dropdown>
        <Stack spacing="sm">
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
              <Group justify="space-between">
                <Text size="sm" fw={500}>Link to vocabulary item</Text>
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconPlus size={12} />}
                  onClick={handleCreateNew}
                >
                  Create New
                </Button>
              </Group>
              
              {vocabsArray.length > 1 ? (
                <Tabs value={selectedVocab} onChange={setSelectedVocab}>
                  <Tabs.List>
                    {vocabsArray.map(vocab => (
                      <Tabs.Tab key={vocab.id} value={vocab.id}>
                        {vocab.name}
                      </Tabs.Tab>
                    ))}
                  </Tabs.List>
                  
                  {vocabsArray.map(vocab => (
                    <Tabs.Panel key={vocab.id} value={vocab.id} pt="sm">
                      <VocabItemsGrid 
                        vocab={vocab} 
                        onItemClick={handleVocabItemClick}
                        existingVocabItem={displayVocabItem}
                      />
                    </Tabs.Panel>
                  ))}
                </Tabs>
              ) : (
                <VocabItemsGrid 
                  vocab={selectedVocabData} 
                  onItemClick={handleVocabItemClick}
                  existingVocabItem={displayVocabItem}
                />
              )}
            </>
          )}
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
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
  if (selectedVocabData?.config?.flan?.fields) {
    Object.entries(selectedVocabData.config.flan.fields).forEach(([fieldName, fieldConfig]) => {
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

const VocabItemsGrid = ({ vocab, onItemClick, existingVocabItem }) => {
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
  if (vocab.config?.flan?.fields) {
    Object.entries(vocab.config.flan.fields).forEach(([fieldName, fieldConfig]) => {
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
  
  // Sort items - existing vocab item first, then others
  const sortedItems = [...filteredItems];
  if (existingVocabItem && existingVocabItem.id) {
    const existingIndex = sortedItems.findIndex(item => item.id === existingVocabItem.id);
    if (existingIndex > -1) {
      // Move existing item to front
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
      <TextInput
        placeholder="Search items..."
        size="xs"
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.currentTarget.value)}
        styles={{
          input: { height: 28 }
        }}
      />
      <ScrollArea h={200}>
        <DataTable
          textSelectionDisabled
          withTableBorder
          withRowBorders
          highlightOnHover
          columns={columns}
          records={sortedItems}
          minHeight={150}
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
    </Stack>
  );
};