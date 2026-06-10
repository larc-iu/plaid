import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { UD_NAMESPACE, getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { useManagedProject } from './useManagedProject.js';
import {
  Container, Title, Text, Button, Group, Stack, Paper, TextInput, Modal, Alert, Center, Loader,
} from '@mantine/core';

// "General" tab: project-wide settings that aren't vocab/colors. Currently the
// tokenizer locale (used by the segmenter) and the destructive project-delete
// action, deliberately tucked behind a type-the-name confirmation since it's
// rarely needed.
export const ProjectGeneral = ({ embedded = false }) => {
  const { projectId, project, loading, fetchProject, canConfigure } = useManagedProject();
  const navigate = useNavigate();
  const { getClient } = useAuth();

  const [savingLocale, setSavingLocale] = useState(false);
  const [tokenizerLocale, setTokenizerLocale] = useState(''); // BCP-47, '' = 'und'

  // Delete (danger zone) — type-the-name-to-confirm.
  const [deleteModalOpened, setDeleteModalOpened] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  // Seed the locale editor from the project's text-layer config.
  useEffect(() => {
    if (!project) return;
    const info = getUdLayerInfo(project);
    setTokenizerLocale(info.textLayer?.config?.[UD_NAMESPACE]?.tokenizerLocale || '');
  }, [project]);

  const handleSaveLocale = async () => {
    setSavingLocale(true);
    try {
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      const info = getUdLayerInfo(project);
      if (!info.textLayer) throw new Error('Project has no configured text layer.');
      const loc = tokenizerLocale.trim();
      if (loc) await client.textLayers.setConfig(info.textLayer.id, UD_NAMESPACE, 'tokenizerLocale', loc);
      else await client.textLayers.deleteConfig(info.textLayer.id, UD_NAMESPACE, 'tokenizerLocale');
      await fetchProject();
      notifySuccess('Tokenizer locale saved.');
    } catch (err) {
      console.error('Failed to save tokenizer locale:', err);
      notifyError(err.message || 'Failed to save tokenizer locale.');
    } finally {
      setSavingLocale(false);
    }
  };

  const isDeleteConfirmValid =
    !!project && deleteConfirmText.trim().toLowerCase() === project.name.toLowerCase();

  const handleDeleteProject = async () => {
    if (!isDeleteConfirmValid) {
      notifyError('Project name does not match. Please type the exact project name.', 'Invalid confirmation');
      return;
    }
    try {
      setIsDeleting(true);
      await getClient().projects.delete(projectId);
      notifySuccess(`Project "${project.name}" has been deleted`);
      navigate('/projects');
    } catch (err) {
      console.error('Error deleting project:', err);
      notifyError('Failed to delete project: ' + (err.message || 'Unknown error'));
      setIsDeleting(false);
      setDeleteModalOpened(false);
    }
  };

  if (loading) {
    return <Center py={48}><Loader /></Center>;
  }

  if (!project || !canConfigure) {
    return null;
  }

  const info = getUdLayerInfo(project);

  const content = (
    <Stack gap="xl">
      <Paper withBorder p="lg" radius="md">
        <Title order={2} size="h4" mb="xs">Tokenizer locale</Title>
        <Text size="sm" c="dimmed" mb="md">
          Language tag used for whitespace/word tokenization (<code>Intl.Segmenter</code>). Drives
          script-specific segmentation — especially <code>ja</code>, <code>zh</code>, <code>th</code>, which
          are segmented by dictionary lookup when given the locale. A BCP-47 tag (e.g. <code>en</code>,
          <code> ja</code>, <code>zh-Hans</code>); leave empty for generic (<code>und</code>).
        </Text>
        {info.textLayer ? (
          <Group align="flex-end" gap="sm">
            <TextInput
              value={tokenizerLocale}
              onChange={(e) => setTokenizerLocale(e.target.value)}
              placeholder="und"
              w={220}
            />
            <Button color="dark" loading={savingLocale} onClick={handleSaveLocale}>
              Save
            </Button>
          </Group>
        ) : (
          <Alert color="gray" variant="light">
            Configure the project's UD layers first before setting a tokenizer locale.
          </Alert>
        )}
      </Paper>

      <Paper withBorder radius="md" style={{ borderColor: 'var(--mantine-color-red-4)' }}>
        <Group px="lg" py="md" style={{ borderBottom: '1px solid var(--mantine-color-red-2)' }}>
          <Title order={3} size="h4" c="red">Danger Zone</Title>
        </Group>
        <Stack px="lg" py="md" gap="sm" align="flex-start">
          <Text size="sm" fw={500}>Delete this project</Text>
          <Text size="sm" c="dimmed">
            Permanently delete <strong>{project.name}</strong> and all of its documents, annotations,
            and configuration. This action cannot be undone.
          </Text>
          <Button
            color="red"
            variant="light"
            onClick={() => { setDeleteConfirmText(''); setDeleteModalOpened(true); }}
          >
            Delete Project
          </Button>
        </Stack>
      </Paper>

      <Modal
        opened={deleteModalOpened}
        onClose={() => { if (!isDeleting) setDeleteModalOpened(false); }}
        title="Delete Project"
        centered
      >
        <Stack gap="md">
          <Alert color="red" title="This action is irreversible">
            You are about to permanently delete the project <strong>{project.name}</strong> and all of
            its associated data including documents, annotations, and configuration.
          </Alert>
          <TextInput
            label={<>To confirm, type the project name <strong>{project.name}</strong></>}
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            placeholder="Enter project name"
            error={deleteConfirmText && !isDeleteConfirmValid ? 'Project name does not match' : undefined}
            data-autofocus
            onKeyDown={(e) => { if (e.key === 'Enter' && isDeleteConfirmValid) handleDeleteProject(); }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteModalOpened(false)} disabled={isDeleting}>
              Cancel
            </Button>
            <Button color="red" onClick={handleDeleteProject} disabled={!isDeleteConfirmValid} loading={isDeleting}>
              Delete Project
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );

  return embedded ? content : <Container size="lg" py="xl">{content}</Container>;
};
