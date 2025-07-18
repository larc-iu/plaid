import { Stack, Text } from '@mantine/core';
import { DocumentMetadataManager } from '../settings/DocumentMetadataManager.jsx';

export const DocumentMetadataStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, client }) => {
  
  // Handle saving changes - interface with parent's onDataChange
  const handleSaveChanges = async (newData) => {
    onDataChange(newData);
  };

  return (
    <Stack spacing="xl">
      {/* Explanatory header */}
      <div>
        <Text>
          Configure which metadata fields you want to collect for each document in your project.
        </Text>
      </div>

      {/* Use the reusable manager component */}
      <DocumentMetadataManager
        initialData={data}
        onSaveChanges={handleSaveChanges}
        showTitle={true}
      />
    </Stack>
  );
};

// Validation function for this step
DocumentMetadataStep.isValid = (data) => {
  // Step is always valid - having no metadata fields is acceptable
  // This allows projects that don't need document metadata to proceed
  return true;
};