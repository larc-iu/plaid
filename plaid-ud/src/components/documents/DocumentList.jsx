import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Title, Button, Alert, Paper, Stack, Group, Text, Box, Center, Loader,
  ActionIcon, Tooltip, Breadcrumbs, Anchor,
} from '@mantine/core';
import { IconPlus, IconTrash, IconPencil, IconUpload, IconSettings } from '@tabler/icons-react';
import { useAuth } from '../../contexts/AuthContext';
import { DocumentForm } from './DocumentForm';
import { ImportModal } from './ImportModal';
import { confirmDelete, notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { canEditProject, canManageProject } from '../../utils/permissions.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { timeAgo, fullTimestamp } from '../../utils/formatTime.js';
import { SortButton } from '../common/SortHeader.jsx';
import { nextSort, sortBy } from '../../utils/sorting.js';
import classes from '../common/listRow.module.css';
import { EntityAvatar } from '../common/EntityAvatar.jsx';

// Fixed metric-column widths, shared by the header and every row so they align.
const W_WORDS = 84;
const W_UPDATED = 124;
const W_ACTION = 72; // edit + delete icons

export const DocumentList = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  // documentId -> word count. Docs with a word layer but no tokens are absent
  // (rendered as 0); `hasWordLayer` false means the project isn't UD-configured.
  const [wordCounts, setWordCounts] = useState({});
  const [hasWordLayer, setHasWordLayer] = useState(true);
  const [wordsLoading, setWordsLoading] = useState(true);
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const { user, getClient, logout } = useAuth();

  const fetchProjectAndDocuments = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }

      // Fetch project and its documents (documents are no longer embedded
      // on the project; they come from the dedicated listDocuments endpoint).
      const [projectData, docsList] = await Promise.all([
        client.projects.get(projectId),
        client.projects.listDocuments(projectId),
      ]);
      setProject(projectData);
      setDocuments(docsList || []);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // Clear the rejected token before redirecting, else /login bounces back.
        logout();
        return;
      }
      setError('Failed to load project and documents');
      console.error('Error fetching project:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjectAndDocuments();
  }, [projectId]);

  // Per-document word counts: one aggregate query over the project's word-layer
  // tokens, grouped by document. Recomputed when the project (hence its word
  // layer) changes; the document list itself doesn't affect the query.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    (async () => {
      setWordsLoading(true);
      const client = getClient();
      // "Words" = the morpheme layer: in the sentence>word>morpheme UD model the
      // morpheme layer holds the syntactic words (CoNLL-U token rows), which is
      // what a word count should mean.
      const wordLayerId = getUdLayerInfo(project).morphemeTokenLayer?.id;
      if (!wordLayerId || !client) {
        if (!cancelled) { setHasWordLayer(false); setWordCounts({}); setWordsLoading(false); }
        return;
      }
      try {
        const res = await client.query({
          where: [['token', '?t', { layer: wordLayerId, doc: { var: '?d' } }]],
          return: { group: ['?d'], aggregates: [['count']] },
        });
        const byDoc = {};
        for (const [docId, n] of (res?.results || [])) byDoc[docId] = n;
        if (!cancelled) { setHasWordLayer(true); setWordCounts(byDoc); }
      } catch (err) {
        console.error('Word-count query failed:', err);
        if (!cancelled) { setHasWordLayer(false); setWordCounts({}); }
      } finally {
        if (!cancelled) setWordsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [project, getClient]);

  const handleDelete = (documentId, documentName) => {
    confirmDelete({
      title: 'Delete document',
      message: `Are you sure you want to delete document "${documentName}"? This action cannot be undone.`,
      onConfirm: async () => {
        try {
          await getClient().documents.delete(documentId);
          notifySuccess(`Deleted "${documentName}"`);
          await fetchProjectAndDocuments(); // Refresh the list
        } catch (err) {
          notifyError(err.message || 'Unknown error', 'Failed to delete document');
          console.error('Error deleting document:', err);
        }
      },
    });
  };

  const handleDocumentCreated = () => {
    setShowCreateForm(false);
    fetchProjectAndDocuments(); // Refresh the list
  };

  const handleImportSuccess = () => {
    setShowImportModal(false);
    fetchProjectAndDocuments(); // Refresh the list
  };

  const onSort = (key) => setSort(nextSort(key));

  const sortedDocuments = useMemo(() => {
    const extract = {
      name: (d) => d.name?.toLowerCase() ?? '',
      words: (d) => (hasWordLayer ? (wordCounts[d.id] ?? 0) : null),
      updated: (d) => d.timeModified ?? null,
    }[sort.key];
    return sortBy(documents, extract, sort.dir);
  }, [documents, wordCounts, hasWordLayer, sort]);

  if (loading) {
    return <Center py={48}><Loader /></Center>;
  }

  if (!project) {
    return <Alert color="red">Project not found</Alert>;
  }

  // Maintainers configure the project; writers (and up) create/import/delete
  // documents. Readers get a view-only list.
  const canManage = canManageProject(project, user);
  const canEdit = canEditProject(project, user);

  // If the project's UD layers aren't set up yet, "Project Settings" should land
  // on the standalone setup/repair page rather than the tabbed settings (which
  // assume a configured project). Otherwise it opens the tabbed settings.
  const projectConfigured = getUdLayerInfo(project).isConfigured;
  const settingsTo = projectConfigured
    ? `/projects/${projectId}/management`
    : `/projects/${projectId}/configuration`;

  const renderWords = (documentId) => {
    if (wordsLoading) return <Loader size={12} />;
    if (!hasWordLayer) return '—';
    return (wordCounts[documentId] ?? 0).toLocaleString();
  };

  return (
    <>
      <Breadcrumbs mb="lg">
        <Anchor component={Link} to="/projects" size="sm">Projects</Anchor>
        <Text size="sm" c="dimmed">{project.name}</Text>
      </Breadcrumbs>

      <Group justify="space-between" mb="lg">
        <Title order={2}>Documents in {project.name}</Title>
        <Group gap="sm">
          {canManage && (
            <Button
              component={Link}
              to={settingsTo}
              color="grape"
              leftSection={<IconSettings size={16} />}
            >
              Project Settings
            </Button>
          )}
          {canEdit && (
            <Button variant="default" leftSection={<IconUpload size={16} />} onClick={() => setShowImportModal(true)}>
              Import
            </Button>
          )}
          {canEdit && (
            <Button color="dark" leftSection={<IconPlus size={16} />} onClick={() => setShowCreateForm(true)}>
              New Document
            </Button>
          )}
        </Group>
      </Group>

      {error && <Alert color="red" mb="md">{error}</Alert>}

      <DocumentForm
        projectId={projectId}
        isOpen={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        onSuccess={handleDocumentCreated}
      />

      <ImportModal
        projectId={projectId}
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSuccess={handleImportSuccess}
      />

      {documents.length === 0 ? (
        <Center py={48}>
          <Text c="dimmed">No documents yet. Create your first document to start annotating!</Text>
        </Center>
      ) : (
        <Paper withBorder radius="md">
          {/* Sortable column header */}
          <Group
            gap="sm"
            wrap="nowrap"
            px="md"
            py="xs"
            style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}
          >
            <SortButton field="name" sort={sort} onSort={onSort} align="left">Document</SortButton>
            <SortButton field="words" sort={sort} onSort={onSort} width={W_WORDS}>Words</SortButton>
            <SortButton field="updated" sort={sort} onSort={onSort} width={W_UPDATED}>Updated</SortButton>
            <Box w={W_ACTION} />
          </Group>

          <Stack gap={0}>
            {sortedDocuments.map((document) => (
              <Box
                key={document.id}
                className={classes.row}
                onClick={() => navigate(`/projects/${projectId}/documents/${document.id}/annotate`)}
                p="md"
              >
                <Group gap="sm" wrap="nowrap">
                  <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                    <EntityAvatar id={document.id} size={36} />
                    <div style={{ minWidth: 0 }}>
                      <Text fw={500} size="lg" truncate>{document.name}</Text>
                      <Text size="xs" c="dimmed" truncate>ID: {document.id}</Text>
                    </div>
                  </Group>

                  <Box ta="right" w={W_WORDS}><Text size="sm" c="dimmed" component="span">{renderWords(document.id)}</Text></Box>
                  <Tooltip label={fullTimestamp(document.timeModified)} disabled={!document.timeModified} withinPortal>
                    <Text size="sm" c="dimmed" ta="right" w={W_UPDATED}>{timeAgo(document.timeModified) || '—'}</Text>
                  </Tooltip>

                  <Group gap="xs" wrap="nowrap" w={W_ACTION} justify="flex-end">
                    <Tooltip label={canEdit ? 'Edit text' : 'View text'}>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/projects/${projectId}/documents/${document.id}/edit`);
                        }}
                      >
                        <IconPencil size={18} />
                      </ActionIcon>
                    </Tooltip>
                    {canEdit && (
                      <Tooltip label="Delete document">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          onClick={(e) => { e.stopPropagation(); handleDelete(document.id, document.name); }}
                        >
                          <IconTrash size={18} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                </Group>
              </Box>
            ))}
          </Stack>
        </Paper>
      )}
    </>
  );
};
