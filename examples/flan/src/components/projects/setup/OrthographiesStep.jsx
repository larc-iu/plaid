import { Stack, Text } from '@mantine/core';
import { OrthographiesManager } from '../settings/OrthographiesManager.jsx';

export const OrthographiesStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, getClient }) => {
  
  // Handle saving changes - interface with parent's onDataChange
  const handleSaveChanges = async (newData) => {
    onDataChange(newData);
  };

  return (
    <Stack spacing="xl">
      {/* Explanatory header */}
      <div>
        <Text>
          Configure orthographic representations for your project. The <strong>Baseline</strong> orthography 
          represents your token layer and cannot be removed. You can add additional orthographies like IPA, 
          alternative writing systems, or normalized forms.
        </Text>
      </div>

      {/* Use the reusable manager component */}
      <OrthographiesManager
        initialData={data}
        onSaveChanges={handleSaveChanges}
        showTitle={true}
      />
    </Stack>
  );
};

// Validation function for this step
OrthographiesStep.isValid = (data) => {
  // Step is always valid - baseline orthography is always present
  // Having additional orthographies is optional
  return true;
};