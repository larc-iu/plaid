import { useState } from 'react';
import { Modal, TextInput, Button, Group, Stack, Alert, Paper, Text, List } from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext';
import { createUdProject } from '../../domain/udProjectSetup.js';

export const ProjectForm = ({ isOpen, onClose, onSuccess }) => {
  const [projectName, setProjectName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { getClient } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!projectName.trim()) {
      setError('Project name is required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const created = await createUdProject(getClient(), projectName);
      onSuccess(created);
    } catch (err) {
      console.error('Error creating project:', err);
      setError(err?.message || 'Failed to create project with layers');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={isOpen} onClose={onClose} title="Create New UD Project" size="sm" centered>
      <form onSubmit={handleSubmit}>
        <Stack gap="md">
          {error && <Alert color="red">{error}</Alert>}

          <TextInput
            label="Project Name"
            name="projectName"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="Enter project name"
            required
            disabled={loading}
            data-autofocus
          />

          <Paper bg="gray.0" p="md" radius="md">
            <Text size="sm" c="dimmed">
              This will create a new project with all necessary layers for Universal Dependencies
              annotation:
            </Text>
            <List size="sm" spacing={4} mt="xs" c="dimmed">
              <List.Item>Text layer</List.Item>
              <List.Item>Token hierarchy: Sentences &rarr; Tokens &rarr; Words</List.Item>
              <List.Item>Span layers for: Form, Lemma, UPOS, XPOS, Features</List.Item>
              <List.Item>Relation layer for dependency parsing</List.Item>
            </List>
          </Paper>

          <Group justify="flex-end" gap="sm">
            <Button type="button" variant="default" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" color="dark" loading={loading}>
              Create Project
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
};
