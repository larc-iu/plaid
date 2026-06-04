import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Title, Button, Alert, Paper, Stack, Group, Text, Box, Center, Loader, Tooltip,
} from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useAuth } from '../../contexts/AuthContext';
import { ProjectForm } from './ProjectForm';
import { EntityAvatar } from '../common/EntityAvatar.jsx';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { timeAgo, fullTimestamp } from '../../utils/formatTime.js';
import { SortButton } from '../common/SortHeader.jsx';
import { nextSort, sortBy } from '../../utils/sorting.js';
import classes from '../common/listRow.module.css';

// Fixed metric-column widths, shared by the header and every row so they align.
const W_DOCS = 64;
const W_WORDS = 84;
const W_UPDATED = 124;

export const ProjectList = () => {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  // projectId -> word count (number), or null when the project has no UD word
  // layer. `undefined` (missing key) means "still loading".
  const [wordCounts, setWordCounts] = useState({});
  const [wordsLoading, setWordsLoading] = useState(true);
  const [sort, setSort] = useState({ key: 'updated', dir: 'desc' });
  const { getClient } = useAuth();
  const navigate = useNavigate();

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }
      const projectList = await client.projects.list();
      setProjects(projectList);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // Redirect to login instead of showing error
        window.location.href = '/login';
        return;
      }
      setError('Failed to load projects');
      console.error('Error fetching projects:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  // Word counts come from a single grouped aggregate query: count tokens grouped
  // by their token layer across every readable project, then map each project's
  // UD word-layer id to its count. One round trip for the whole list.
  useEffect(() => {
    if (!projects.length) return;
    let cancelled = false;
    (async () => {
      setWordsLoading(true);
      const client = getClient();
      if (!client) return;
      try {
        // `layer: '?l'` binds a layer *variable* (a bare "?name" string); the
        // `{var}` form is only for scalar values (doc/value/begin/end/form).
        const res = await client.query({
          where: [['token', '?t', { layer: '?l' }]],
          return: { group: ['?l'], aggregates: [['count']] },
        });
        const byLayer = new Map((res?.results || []).map(([layerId, n]) => [layerId, n]));
        const byProject = {};
        for (const p of projects) {
          // "Words" = the morpheme layer: in the sentence>word>morpheme UD model
          // the morpheme layer holds the syntactic words (the CoNLL-U token rows
          // where annotations live), which is what a word count should mean.
          const wordLayerId = getUdLayerInfo(p).morphemeTokenLayer?.id;
          byProject[p.id] = wordLayerId ? (byLayer.get(wordLayerId) ?? 0) : null;
        }
        if (!cancelled) setWordCounts(byProject);
      } catch (err) {
        console.error('Word-count query failed:', err);
        if (!cancelled) setWordCounts({}); // leave counts unknown -> "—"
      } finally {
        if (!cancelled) setWordsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projects, getClient]);

  const handleProjectCreated = () => {
    setShowCreateForm(false);
    fetchProjects(); // Refresh the list
  };

  const onSort = (key) => setSort(nextSort(key));

  const sortedProjects = useMemo(() => {
    const extract = {
      name: (p) => p.name?.toLowerCase() ?? '',
      documents: (p) => p.documentCount ?? 0,
      words: (p) => (wordCounts[p.id] == null ? null : wordCounts[p.id]),
      updated: (p) => p.lastModified ?? null,
    }[sort.key];
    return sortBy(projects, extract, sort.dir);
  }, [projects, wordCounts, sort]);

  if (loading) {
    return <Center py={48}><Loader /></Center>;
  }

  const renderWords = (projectId) => {
    if (wordsLoading && wordCounts[projectId] === undefined) return <Loader size={12} />;
    const v = wordCounts[projectId];
    return v == null ? '—' : v.toLocaleString();
  };

  return (
    <>
      <Group justify="space-between" mb="lg">
        <Title order={2}>Projects</Title>
        <Button color="dark" leftSection={<IconPlus size={16} />} onClick={() => setShowCreateForm(true)}>
          New UD Project
        </Button>
      </Group>

      {error && <Alert color="red" mb="md">{error}</Alert>}

      <ProjectForm
        isOpen={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        onSuccess={handleProjectCreated}
      />

      {projects.length === 0 ? (
        <Center py={48}>
          <Text c="dimmed">No projects yet. Create your first UD project to get started!</Text>
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
            <SortButton field="name" sort={sort} onSort={onSort} align="left">Project</SortButton>
            <SortButton field="documents" sort={sort} onSort={onSort} width={W_DOCS}>Docs</SortButton>
            <SortButton field="words" sort={sort} onSort={onSort} width={W_WORDS}>Words</SortButton>
            <SortButton field="updated" sort={sort} onSort={onSort} width={W_UPDATED}>Updated</SortButton>
          </Group>

          <Stack gap={0}>
            {sortedProjects.map((project) => (
              <Box
                key={project.id}
                className={classes.row}
                onClick={() => navigate(`/projects/${project.id}/documents`)}
                p="md"
              >
                <Group gap="sm" wrap="nowrap">
                  <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                    <EntityAvatar id={project.id} size={36} />
                    <div style={{ minWidth: 0 }}>
                      <Text fw={500} size="lg" truncate>{project.name}</Text>
                      <Text size="xs" c="dimmed" truncate>ID: {project.id}</Text>
                    </div>
                  </Group>

                  <Text size="sm" c="dimmed" ta="right" w={W_DOCS}>{project.documentCount ?? 0}</Text>
                  <Box ta="right" w={W_WORDS}><Text size="sm" c="dimmed" component="span">{renderWords(project.id)}</Text></Box>
                  <Tooltip label={fullTimestamp(project.lastModified)} disabled={!project.lastModified} withinPortal>
                    <Text size="sm" c="dimmed" ta="right" w={W_UPDATED}>{timeAgo(project.lastModified) || '—'}</Text>
                  </Tooltip>
                </Group>
              </Box>
            ))}
          </Stack>
        </Paper>
      )}
    </>
  );
};
