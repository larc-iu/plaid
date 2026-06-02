import { useState } from 'react';
import { Modal, TextInput, Button, Group, Stack, Alert } from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext';

export const DocumentForm = ({ projectId, isOpen, onClose, onSuccess }) => {
  const [documentName, setDocumentName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { getClient } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!documentName.trim()) {
      setError('Document name is required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const client = getClient();
      await client.documents.create(projectId, documentName);
      onSuccess();
    } catch (err) {
      setError('Failed to create document');
      console.error('Error creating document:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={isOpen} onClose={onClose} title="Create New Document" size="sm" centered>
      <form onSubmit={handleSubmit}>
        <Stack gap="md">
          {error && <Alert color="red">{error}</Alert>}

          <TextInput
            label="Document Name"
            name="documentName"
            value={documentName}
            onChange={(e) => setDocumentName(e.target.value)}
            placeholder="Enter document name"
            required
            disabled={loading}
            data-autofocus
          />

          <Group justify="flex-end" gap="sm">
            <Button type="button" variant="default" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" color="dark" loading={loading}>
              Create Document
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
};
