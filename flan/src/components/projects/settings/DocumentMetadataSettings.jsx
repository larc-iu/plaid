import { useState } from 'react';
import { Paper, Text, Alert } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { DocumentMetadataManager } from './DocumentMetadataManager.jsx';
import IconAlertTriangle from '@tabler/icons-react/dist/esm/icons/IconAlertTriangle.mjs';

export const DocumentMetadataSettings = ({ projectId, client }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  // Helper to check if a field is predefined
  const isPredefinedField = (fieldName) => {
    const predefinedFields = ['Date', 'Speakers', 'Location', 'Genre', 'Recording Quality', 'Transcriber'];
    return predefinedFields.includes(fieldName);
  };

  // Load current project configuration
  const handleLoadData = async () => {
    try {
      setIsLoading(true);
      setHasError(false);
      
      if (!client) {
        throw new Error('Not authenticated');
      }
      const project = await client.projects.get(projectId);
      
      // Extract current metadata configuration
      const currentConfig = project.config?.plaid?.documentMetadata;
      
      if (currentConfig && Array.isArray(currentConfig)) {
        // Convert API format back to component format
        return {
          enabledFields: currentConfig.map(field => ({
            name: field.name,
            enabled: true, // All fields in the config are enabled
            isCustom: !isPredefinedField(field.name)
          }))
        };
      }
      
      // Return null to use default predefined fields
      return null;
    } catch (error) {
      console.error('Failed to load document metadata configuration:', error);
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
      
      // Convert to API format (only store enabled fields with just name)
      const enabledFields = data.enabledFields.filter(field => field.enabled);
      const apiConfig = enabledFields.map(field => ({
        name: field.name
      }));
      
      await client.projects.setConfig(projectId, "plaid", "documentMetadata", apiConfig);
      
      notifications.show({
        title: 'Settings Saved',
        message: 'Document metadata configuration has been updated',
        color: 'green'
      });
    } catch (error) {
      console.error('Failed to save document metadata configuration:', error);
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
      message: 'Failed to update document metadata configuration',
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
            Failed to load or save document metadata configuration. Please refresh the page and try again.
          </Text>
        </Alert>
      </Paper>
    );
  }

  return (
    <Paper withBorder p="md">
      <Text size="lg" fw={500} mb="md">Document Metadata</Text>
      <Text size="sm" mb="md" c="dimmed">
        Configure which metadata fields are available when creating or editing documents in this project.
      </Text>
      
      <DocumentMetadataManager
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        isLoading={isLoading}
        showTitle={false}
      />
    </Paper>
  );
};