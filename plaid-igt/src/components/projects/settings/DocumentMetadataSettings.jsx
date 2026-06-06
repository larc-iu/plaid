import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { DocumentMetadataManager } from './DocumentMetadataManager.jsx';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { readDocumentMetadata, IGT_NAMESPACE } from '@/domain/igtConfig';

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
      const currentConfig = readDocumentMetadata(project.config);

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

      await client.projects.setConfig(projectId, IGT_NAMESPACE, "documentMetadata", apiConfig);

      notifySuccess('Document metadata configuration has been updated', 'Settings Saved');
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
    notifyError('Failed to update document metadata configuration', 'Configuration Error');
  };

  if (hasError) {
    return (
      <div className="tw rounded-lg border border-destructive/50 bg-destructive/5 p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <p className="text-sm font-medium text-destructive">Configuration Error</p>
            <p className="text-sm text-muted-foreground">
              Failed to load or save document metadata configuration. Please refresh the page and try again.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tw rounded-lg border bg-card p-4">
      <p className="text-lg font-medium">Document Metadata</p>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        Configure which metadata fields are available when creating or editing documents in this project.
      </p>

      <DocumentMetadataManager
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        isLoading={isLoading}
        showTitle={false}
      />
    </div>
  );
};
