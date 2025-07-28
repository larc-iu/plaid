import React, { useEffect, useState } from 'react';
import { useSnapshot } from 'valtio';
import { 
  Stack, 
  Title, 
  Text, 
  Paper,
  Textarea,
  Button,
  Group,
  Alert,
  Divider
} from '@mantine/core';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconEdit from '@tabler/icons-react/dist/esm/icons/IconEdit.mjs';
import IconDeviceFloppy from '@tabler/icons-react/dist/esm/icons/IconDeviceFloppy.mjs';
import IconX from '@tabler/icons-react/dist/esm/icons/IconX.mjs';
import { useBaselineOperations } from './useBaselineOperations.js';
import documentsStore from '../../../stores/documentsStore';

export function DocumentBaseline({ projectId, documentId, reload, client, readOnly = false }) {
  const storeSnap = useSnapshot(documentsStore);
  const docSnap = storeSnap[projectId]?.[documentId];
  const ops = useBaselineOperations(projectId, documentId, reload, client);
  
  // Local state for text input to prevent cursor jumping
  const [localText, setLocalText] = useState('');

  // Check for dirty tokenization on component mount
  useEffect(() => {
    ops.checkDirtyTokenization();
  }, []);

  // Sync local text with valtio state when editing starts
  useEffect(() => {
    if (ops.isEditing) {
      setLocalText(ops.editedText);
    }
  }, [ops.isEditing, ops.editedText]);

  const handleTextChange = (e) => {
    const newText = e.target.value;
    setLocalText(newText);
    ops.updateEditedText(newText);
  };

  return (
    <Stack spacing="lg" mt="md">
      <Paper withBorder p="md">
        <Stack spacing="md">
          <Group justify="space-between" align="center">
            <div>
              <Title order={3}>Baseline Text</Title>
              <Text size="sm" c="dimmed">
                Edit the primary text content for this document
              </Text>
            </div>
            {!ops.isEditing && !readOnly && (
              <Button
                leftSection={<IconEdit size={16} />}
                variant="light"
                size="sm"
                onClick={ops.handleEdit}
              >
                Edit Text
              </Button>
            )}
          </Group>

          <Divider />

          {ops.isEditing ? (
            <Stack spacing="md">
              <Textarea
                label="Document Text"
                value={localText}
                onChange={handleTextChange}
                placeholder="Enter the document text..."
                minRows={10}
                maxRows={20}
                autosize
                required
              />

              <Alert icon={<IconInfoCircle size={16} />} color="yellow">
                <Text size="sm">
                  <strong>Note:</strong> Editing the baseline text will affect all existing 
                  tokens and annotations. Make sure to review your changes carefully.
                </Text>
              </Alert>

              <Group justify="flex-end">
                <Button
                  variant="outline"
                  leftSection={<IconX size={16} />}
                  onClick={ops.handleCancel}
                  disabled={ops.saving}
                >
                  Cancel
                </Button>
                <Button
                  leftSection={<IconDeviceFloppy size={16} />}
                  onClick={ops.handleSave}
                  loading={ops.saving}
                >
                  Save Changes
                </Button>
              </Group>
            </Stack>
          ) : (
            <Stack spacing="md">
              <div>
                <Paper bg="gray.0" p="md" radius="md">
                  <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                    {ops.parsedDocument?.document?.text?.body || ''}
                  </Text>
                </Paper>
              </div>

              {!ops.primaryTextLayer && (
                <Alert icon={<IconInfoCircle size={16} />} color="red">
                  No primary text layer found for this project. Text editing is not available.
                </Alert>
              )}
            </Stack>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
};