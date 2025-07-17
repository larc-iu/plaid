import { Stack, Text, Badge } from '@mantine/core';
import { FieldsManager } from '../settings/FieldsManager.jsx';

export const FieldsStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, getClient }) => {
  
  // Initialize data with defaults if not already present
  if (!data?.fields) {
    onDataChange({ 
      fields: [
        { name: 'Gloss', scope: 'Token', isCustom: false },
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
          Configure annotation fields for your project. <Badge color="blue" variant="light" size="sm">Token</Badge> scope 
          fields apply to individual words or morphemes, while <Badge color="green" variant="light" size="sm">Sentence</Badge> scope 
          fields apply to entire sentences or phrases.
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