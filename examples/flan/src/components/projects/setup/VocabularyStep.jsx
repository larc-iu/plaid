import { useState, useEffect } from 'react';
import { Stack, Text } from '@mantine/core';
import { VocabularyManager } from '../settings/VocabularyManager.jsx';

export const VocabularyStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, getClient }) => {
  
  // Load vocabularies from API on mount
  const handleLoadData = async () => {
    try {
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
      
      return { vocabularies: initialVocabs };
    } catch (err) {
      console.error('Error fetching vocabularies:', err);
      throw err;
    }
  };

  // Handle saving changes - interface with parent's onDataChange
  const handleSaveChanges = async (newData) => {
    onDataChange(newData);
  };

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

      {/* Use the reusable manager component */}
      <VocabularyManager
        initialData={data}
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        showTitle={true}
        isSettings={false}
      />
    </Stack>
  );
};

// Validation function for this step
VocabularyStep.isValid = (data) => {
  // Step is always valid - vocabularies are optional
  // Users can proceed without any vocabularies if they don't need this feature
  return true;
};