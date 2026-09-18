import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { ProjectForm } from './ProjectForm';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { notifyWarning } from '../../utils/feedback.jsx';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { Button } from '@ui/components/ui/button';
import { LinkedListPage, CountCell, TimeCell } from '@ui/components/shared/LinkedListPage.jsx';
import { wordCountsByProject } from '@ui/domain/layerCounts.js';
import { textIncludes } from '@ui/domain/collation.js';

const wordLayerId = (project) => getUmrLayerInfo(project).wordTokenLayer?.id;

export const ProjectList = () => {
  useDocumentTitle('Projects');
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  // projectId -> word count, or null when the project has no word layer.
  // A missing key means still loading.
  const [wordCounts, setWordCounts] = useState({});
  const [wordsLoading, setWordsLoading] = useState(true);
  const { getClient, logout } = useAuth();
  const navigate = useNavigate();

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      const projectList = await client.projects.list();
      setProjects(projectList);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // A rejected token is invalid: clear it before redirecting, so /login
        // does not bounce straight back here.
        logout('expired');
        return;
      }
      setError('Failed to load projects');
      console.error('Error fetching projects:', err);
    } finally {
      setLoading(false);
    }
  };

  // Once on mount. `fetchProjects` is redefined every render.
  useEffect(() => {
    fetchProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!projects.length) return;
    const client = getClient();
    if (!client) return;
    let cancelled = false;
    (async () => {
      setWordsLoading(true);
      try {
        const counts = await wordCountsByProject(client, projects, wordLayerId);
        if (!cancelled) setWordCounts(counts);
      } catch (err) {
        console.error('Word-count query failed:', err);
        if (!cancelled) {
          setWordCounts({});
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
  }, [projects, getClient]);

  const handleProjectCreated = (project) => {
    setShowCreateForm(false);
    if (project?.id) {
      navigate(`/projects/${project.id}/documents`);
    } else {
      fetchProjects();
    }
  };

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
      // A project with no word layer counts as the smallest, which is what a
      // blank means here.
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
    <>
      <ProjectForm
        isOpen={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        onSuccess={handleProjectCreated}
      />

      <LinkedListPage
        className=""
        title="Projects"
        action={
          <Button onClick={() => setShowCreateForm(true)}>
            <Plus className="h-4 w-4" /> New UMR project
          </Button>
        }
        href={(p) => `/projects/${p.id}/documents`}
        rows={projects}
        columns={columns}
        loading={loading}
        error={error}
        empty={{
          title: 'No projects yet',
          hint: "Create one with New UMR project, or ask a project's maintainer for an invitation link.",
        }}
        tableId="projects"
        noun="project"
        defaultSort={{ key: 'updated', dir: 'desc' }}
        search={{
          placeholder: 'Search projects…',
          match: (p, q) => textIncludes(p.name || '', q),
        }}
      />
    </>
  );
};
