import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Title, Button, Alert, Paper, Stack, Group, Text, Box, Center, Loader,
  Tooltip, Pagination, TextInput, CloseButton,
} from '@mantine/core';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { useAuth } from '../../contexts/AuthContext';
import { DocumentForm } from './DocumentForm';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { canEditProject } from '../../utils/permissions.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { timeAgo, fullTimestamp } from '../../utils/formatTime.js';
import { SortButton } from '../common/SortHeader.jsx';
import { nextSort, sortBy } from '../../utils/sorting.js';
import classes from '../common/listRow.module.css';
import { EntityAvatar } from '../common/EntityAvatar.jsx';

// Fixed metric-column widths, shared by the header and every row so they align.
const W_WORDS = 84;
const W_UPDATED = 124;
const PAGE_SIZE = 100; // documents shown per page (the full list is paged client-side)

export const DocumentList = () => {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  // documentId -> word count. Docs with a word layer but no tokens are absent
  // (rendered as 0); `hasWordLayer` false means the project isn't UD-configured.
  const [wordCounts, setWordCounts] = useState({});
  const [hasWordLayer, setHasWordLayer] = useState(true);
  const [wordsLoading, setWordsLoading] = useState(true);
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
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

  // A row links to the Annotate tab by default; but a document with no tokens
  // yet has nothing to annotate (the tab would just say "tokenize first"), so
  // point it at the Text Editor. Only divert once word counts have loaded and
  // confirm zero tokens — while they're still loading we keep the default so a
  // tokenized doc clicked early isn't mis-routed. (Deleting a document now lives
  // on a "Delete Document" button at the bottom of the Text Editor.)
  const rowHref = (documentId) => {
    const knownEmpty = hasWordLayer && !wordsLoading && (wordCounts[documentId] ?? 0) === 0;
    return `/projects/${projectId}/documents/${documentId}/${knownEmpty ? 'edit' : 'annotate'}`;
  };

  const onSort = (key) => { setSort(nextSort(key)); setPage(1); };
  const onFilter = (value) => { setFilter(value); setPage(1); };

  const sortedDocuments = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = q ? documents.filter((d) => (d.name || '').toLowerCase().includes(q)) : documents;
    const extract = {
      name: (d) => d.name?.toLowerCase() ?? '',
      words: (d) => (hasWordLayer ? (wordCounts[d.id] ?? 0) : null),
      updated: (d) => d.timeModified ?? null,
    }[sort.key];
    return sortBy(matched, extract, sort.dir);
  }, [documents, wordCounts, hasWordLayer, sort, filter]);

  // Page the sorted list at PAGE_SIZE. `currentPage` is clamped so deleting
  // documents off the last page falls back into range instead of showing blank.
  const totalPages = Math.max(1, Math.ceil(sortedDocuments.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageDocuments = sortedDocuments.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  if (loading) {
    return <Center py={48}><Loader /></Center>;
  }

  if (!project) {
    return <Alert color="red">Project not found</Alert>;
  }

  // Writers (and up) create/delete documents. Readers get a view-only list.
  // (Search, Project Settings, and Import/Export now live in the ProjectTabs bar.)
  const canEdit = canEditProject(project, user);

  const renderWords = (documentId) => {
    if (wordsLoading) return <Loader size={12} />;
    if (!hasWordLayer) return '—';
    return (wordCounts[documentId] ?? 0).toLocaleString();
  };

  return (
    <>
      <ProjectTabs projectId={projectId} project={project} />

      <Group justify="space-between" mb="lg">
        <Title order={2}>Documents in {project.name}</Title>
        <Group gap="sm">
          <TextInput
            placeholder="Filter by name…"
            value={filter}
            onChange={(e) => onFilter(e.currentTarget.value)}
            leftSection={<IconSearch size={16} />}
            rightSection={filter
              ? <CloseButton size="sm" onClick={() => onFilter('')} aria-label="Clear filter" />
              : null}
            w={240}
          />
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
      />

      {documents.length === 0 ? (
        <Center py={48}>
          <Text c="dimmed">No documents yet. Create your first document to start annotating!</Text>
        </Center>
      ) : sortedDocuments.length === 0 ? (
        <Center py={48}>
          <Text c="dimmed">No documents match “{filter.trim()}”.</Text>
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
          </Group>

          <Stack gap={0}>
            {pageDocuments.map((document) => (
              <Box
                key={document.id}
                component={Link}
                to={rowHref(document.id)}
                className={classes.row}
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
                </Group>
              </Box>
            ))}
          </Stack>
        </Paper>
      )}

      {totalPages > 1 && (
        <Group justify="center" mt="lg">
          <Pagination total={totalPages} value={currentPage} onChange={setPage} />
        </Group>
      )}
    </>
  );
};
