import { useState } from 'react';
import {
  Modal, TextInput, Textarea, Button, Group, Stack, Alert, Tabs, FileInput, Paper, Text, Code,
} from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { notifyWarning } from '../../utils/feedback.jsx';

export const ImportModal = ({ projectId, isOpen, onClose, onSuccess }) => {
  const [importText, setImportText] = useState('');
  const [documentName, setDocumentName] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [importMethod, setImportMethod] = useState('paste'); // 'paste' or 'upload'
  const { getClient } = useAuth();

  const handleFile = (file) => {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      setImportText(event.target.result);
      // Extract document name from filename (remove .conllu extension)
      const fileName = file.name.replace(/\.conllu$/i, '');
      if (!documentName) {
        setDocumentName(fileName);
      }
    };
    reader.onerror = () => {
      setError('Failed to read file');
    };
    reader.readAsText(file);
  };

  const performImport = async () => {
    if (!documentName.trim()) {
      setError('Document name is required');
      return;
    }
    if (!importText.trim()) {
      setError('No content to import');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const client = getClient();
      const { importWarnings } = await ConlluDocument.importFromConllu(client, projectId, documentName, importText);
      // Sticky on purpose: these report deliberately-unsupported data that was
      // dropped — the user must see them, not catch a fading toast.
      (importWarnings || []).forEach(msg =>
        notifyWarning(msg, 'Some annotations were not imported', { autoClose: false })
      );
      setSuccess(true);
      setTimeout(() => { onSuccess(); }, 2000);
    } catch (err) {
      console.error('Import failed:', err);
      setError(`Import failed: ${err.message || 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={success ? 'Import Successful!' : 'Import CoNLL-U Document'}
      size="lg"
      centered
    >
      <Stack gap="md">
        {success && (
          <Alert color="green">Document imported successfully! Redirecting...</Alert>
        )}

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

        <Tabs value={importMethod} onChange={setImportMethod}>
          <Tabs.List>
            <Tabs.Tab value="paste">Paste Text</Tabs.Tab>
            <Tabs.Tab value="upload">Upload File</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="paste" pt="md">
            <Textarea
              label="CoNLL-U Text"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="Paste your CoNLL-U formatted text here..."
              minRows={15}
              autosize
              maxRows={20}
              disabled={loading}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            />
          </Tabs.Panel>

          <Tabs.Panel value="upload" pt="md">
            <FileInput
              label="CoNLL-U File"
              accept=".conllu,.txt"
              placeholder="Choose file..."
              onChange={handleFile}
              disabled={loading}
              clearable
            />
            {importText && (
              <Paper bg="gray.0" p="md" radius="md" mt="md">
                <Text size="sm" c="dimmed" mb="xs">File loaded. Preview:</Text>
                <Code block style={{ maxHeight: 160, overflow: 'auto' }}>
                  {importText.substring(0, 500)}
                  {importText.length > 500 && '...'}
                </Code>
              </Paper>
            )}
          </Tabs.Panel>
        </Tabs>

        <Group justify="flex-end" gap="sm" pt="sm">
          <Button type="button" variant="default" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={performImport}
            loading={loading}
            disabled={!importText.trim() || !documentName.trim()}
          >
            Import
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
