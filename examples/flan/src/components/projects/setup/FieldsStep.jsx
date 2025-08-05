import { Stack, Text, Badge } from '@mantine/core';
import { FieldsManager } from '../settings/FieldsManager.jsx';

export const FieldsStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, client }) => {
  
  // Initialize data with defaults if not already present
  if (!data?.fields) {
    onDataChange({ 
      fields: [
        { name: 'Gloss', scope: 'Word', isCustom: false },
        { name: 'Translation', scope: 'Sentence', isCustom: false }
      ],
      ignoredTokens: {
        mode: 'unicode-punctuation',
        unicodePunctuationExceptions: [],
        explicitIgnoredTokens: []
      }
    });
  }
  
  // Handle saving changes - interface with parent's onDataChange
  const handleSaveChanges = async (newData) => {
    onDataChange(newData);
  };

  return (
    <Stack spacing="xl">
      {/* Explanatory header */}
      <div>
        <Text>
          Configure annotation fields for your project. 
          <Badge color="blue" variant="light" size="sm">Word</Badge> scope fields apply to words,{' '}
          <Badge color="violet" variant="light" size="sm">Morpheme</Badge> scope fields apply to morphemes, and{' '}
          <Badge color="green" variant="light" size="sm">Sentence</Badge> scope fields apply to entire sentences.
        </Text>
      </div>

      {/* Use the reusable manager component */}
      <FieldsManager
        initialData={data}
        onSaveChanges={handleSaveChanges}
        showTitle={true}
      />
    </Stack>
  );
};

// Validation function for this step
FieldsStep.isValid = (data) => {
  // Must have at least one annotation field
  return data?.fields && data.fields.length > 0;
};