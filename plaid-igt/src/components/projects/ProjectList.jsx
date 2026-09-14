import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import {
  LinkedListPage,
  CountCell,
  TimeCell,
  NewLinkButton,
} from '@ui/components/shared/LinkedListPage.jsx';
import { wordCountsByProject } from '@ui/domain/layerCounts.js';
import { notifyWarning } from '@/utils/feedback';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { textIncludes } from '@ui/domain/collation.js';

// "Words" = the primary token layer (the orthographic word tokens); morphemes
// are sub-word units and shouldn't inflate the word count.
const wordLayerId = (project) => getIgtLayerInfo(project).primaryTokenLayer?.id;

export const ProjectList = () => {
  useDocumentTitle('Projects');
  const { client, logout } = useAuth();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // projectId -> word count (number), or null when the project has no primary
  // word-token layer. `undefined` (missing key) means "still loading".
  const [wordCounts, setWordCounts] = useState({});
  const [wordsLoading, setWordsLoading] = useState(true);

  const fetchProjects = async () => {
    try {
      setLoading(true);
      if (!client) throw new Error('Not authenticated');
      const projectList = await client.projects.list();
      setProjects(projectList);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        logout('expired');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!projects.length || !client) return;
    let cancelled = false;
    (async () => {
      setWordsLoading(true);
      try {
        const counts = await wordCountsByProject(client, projects, wordLayerId);
        if (!cancelled) setWordCounts(counts);
      } catch (err) {
        console.error('Word-count query failed:', err);
        if (!cancelled) {
          setWordCounts({}); // leave counts unknown -> "—"
          notifyWarning(
            'Word counts could not be loaded for the project list.',
            'Word counts unavailable',
          );
        }
      } finally {
        if (!cancelled) setWordsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projects, client]);

  const columns = [
    {
      key: 'name',
      label: 'Project',
      sort: (p) => p.name?.toLowerCase() ?? '',
      cell: (p) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{p.name}</div>
          <div className="truncate text-xs text-muted-foreground">ID: {p.id}</div>
        </div>
      ),
    },
    {
      key: 'documents',
      label: 'Docs',
      sort: (p) => p.documentCount ?? 0,
      align: 'right',
      cell: (p) => p.documentCount ?? 0,
    },
    {
      key: 'words',
      label: 'Words',
      // A project with no word layer counts as the smallest, the way it did
      // when the comparator gave it -1.
      sort: (p) => wordCounts[p.id] ?? null,
      align: 'right',
      cell: (p) => <CountCell value={wordCounts[p.id]} loading={wordsLoading} />,
    },
    {
      key: 'updated',
      label: 'Updated',
      sort: (p) => (p.lastModified ? new Date(p.lastModified).getTime() : null),
      align: 'right',
      cell: (p) => <TimeCell at={p.lastModified} />,
    },
  ];

  return (
    <LinkedListPage
      title="Projects"
      action={
        <NewLinkButton to="/projects/new">
          <Plus className="h-4 w-4" /> New Project
        </NewLinkButton>
      }
      href={(p) => `/projects/${p.id}`}
      rows={projects}
      columns={columns}
      loading={loading}
      error={error}
      empty={{
        title: 'No projects yet',
        hint: "Create one with New Project, or ask a project's maintainer for an invitation link.",
      }}
      tableId="projects"
      noun="project"
      defaultSort={{ key: 'updated', dir: 'desc' }}
      search={{
        placeholder: 'Search projects…',
        match: (p, q) => textIncludes(p.name || '', q),
      }}
    />
  );
};
