import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal, TextInput, Button, Group, Stack, Alert } from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext';

export const DocumentForm = ({ projectId, isOpen, onClose }) => {
  const [documentName, setDocumentName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { getClient } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();

    const name = documentName.trim();
    if (!name) {
      setError('Document name is required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const client = getClient();
      const created = await client.documents.create(projectId, name);
      // A new document has no tokens yet, so the Annotate tab would just say
      // "tokenize first" — open it directly in the Text Editor instead. We stay
      // in the loading state through navigation: this list route (and the modal
      // with it) unmounts, so there's no need to reset it.
      navigate(`/projects/${projectId}/documents/${created.id}/edit`);
    } catch (err) {
      setError('Failed to create document');
      console.error('Error creating document:', err);
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
