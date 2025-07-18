import { useState } from 'react';
import { Paper, Text, Alert } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { VocabularyManager } from './VocabularyManager';
import IconAlertTriangle from '@tabler/icons-react/dist/esm/icons/IconAlertTriangle.mjs';

export const VocabularySettings = ({ projectId, client }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  // Load current project vocabularies
  const handleLoadData = async () => {
    try {
      setIsLoading(true);
      setHasError(false);
      
      if (!client) {
        throw new Error('Not authenticated');
      }
      
      // Get all available vocabularies
      const allVocabs = await client.vocabLayers.list();
      
      // Get the project to see which vocabularies are linked
      const project = await client.projects.get(projectId);
      const linkedVocabIds = project.vocabLayers || [];
      
      // Transform to component format
      const vocabularies = allVocabs.map(vocab => ({
        name: vocab.name || vocab.id,
        id: vocab.id,
        enabled: linkedVocabIds.includes(vocab.id),
        isCustom: false // All existing vocabs from API are not custom
      }));
      
      return { vocabularies };
    } catch (error) {
      console.error('Failed to load vocabularies configuration:', error);
      setHasError(true);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Save changes to the API
  const handleSaveChanges = async (data) => {
    try {
      setIsLoading(true);
      setHasError(false);
      
      if (!client) {
        throw new Error('Not authenticated');
      }
      
      // Get current project state
      const project = await client.projects.get(projectId);
      const currentLinkedVocabIds = project.vocabLayers || [];
      
      // Determine which vocabularies should be linked
      const targetLinkedVocabIds = data.vocabularies
        .filter(vocab => vocab.enabled && !vocab.isCustom) // Only link existing, enabled vocabs
        .map(vocab => vocab.id);
      
      // Create new custom vocabularies first
      const customVocabs = data.vocabularies.filter(vocab => vocab.isCustom && vocab.enabled);
      for (const customVocab of customVocabs) {
        if (customVocab.id.startsWith('new-')) {
          // Create new vocabulary
          const newVocab = await client.vocabLayers.create(customVocab.name);
          // Link to project
          await client.projects.linkVocab(projectId, newVocab.id);
        }
      }
      
      // Handle linking/unlinking for existing vocabularies
      for (const vocabId of currentLinkedVocabIds) {
        if (!targetLinkedVocabIds.includes(vocabId)) {
          // Unlink vocabulary
          await client.projects.unlinkVocab(projectId, vocabId);
        }
      }
      
      for (const vocabId of targetLinkedVocabIds) {
        if (!currentLinkedVocabIds.includes(vocabId)) {
          // Link vocabulary
          await client.projects.linkVocab(projectId, vocabId);
        }
      }
      
      notifications.show({
        title: 'Settings Saved',
        message: 'Vocabulary configuration has been updated',
        color: 'green'
      });
    } catch (error) {
      console.error('Failed to save vocabularies configuration:', error);
      setHasError(true);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Handle errors
  const handleError = (error) => {
    setHasError(true);
    notifications.show({
      title: 'Configuration Error',
      message: 'Failed to update vocabularies configuration',
      color: 'red'
    });
  };

  if (hasError) {
    return (
      <Paper p="md" withBorder>
        <Alert 
          icon={<IconAlertTriangle size={16} />}
          title="Configuration Error" 
          color="red"
          variant="light"
        >
          <Text size="sm">
            Failed to load or save vocabularies configuration. Please refresh the page and try again.
          </Text>
        </Alert>
      </Paper>
    );
  }

  return (
    <Paper withBorder p="md">
      <Text size="lg" fw={500} mb="md">Vocabularies</Text>
      <Text size="sm" mb="md" c="dimmed">
        Link vocabularies to your project. Vocabularies allow you to link tokens to 
        document-independent vocabulary entries, allowing you to track constructs such as
        morphemes, words, or multi-word expressions.
      </Text>
      
      <VocabularyManager
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        showTitle={false}
        isSettings={true}
      />
    </Paper>
  );
};