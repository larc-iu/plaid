import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth } from '../../contexts/useAuth.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { appRoutes } from '../../lib/uiConfig.js';
import { notifyWarning } from '../../lib/notify.js';
import { Button } from '../ui/button';
import { LinkedListPage, CountCell, TimeCell } from './LinkedListPage.jsx';
import { wordCountsByProject } from '../../domain/layerCounts.js';
import { textIncludes } from '../../domain/collation.js';

/**
 * Every project this reader can see, and the way into a new one.
 *
 * `wordLayerId(project)` is the app's: which token layer a word count means
 * differs (plaid-ud counts its morpheme layer, where the CoNLL-U rows live).
 * `newProject` is the label on the button and in the empty state, and `form` is
 * the app's new-project dialog.
 */
export const ProjectListPage = ({ wordLayerId, newProject, form: NewProject }) => {
  useDocumentTitle('Projects');
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  // projectId -> word count (number), or null when the project has no word
  // layer. `undefined` (missing key) means "still loading".
  const [wordCounts, setWordCounts] = useState({});
  const [wordsLoading, setWordsLoading] = useState(true);
  const { getClient, logout } = useAuth();
  const navigate = useNavigate();
  const routes = appRoutes();

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      setProjects(await client.projects.list());
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // A rejected token is invalid: log out (which clears the stored token)
        // before redirecting, so /login does not bounce straight back here.
        logout('expired');
        return;
      }
      setError('Failed to load projects');
      console.error('Error fetching projects:', err);
    } finally {
      setLoading(false);
    }
  };

  // Once on mount. `fetchProjects` is redefined every render, so naming it
  // here would refetch on every render.
  useEffect(() => {
    fetchProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!projects.length) return undefined;
    const client = getClient();
    if (!client) return undefined;
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
  }, [projects, getClient, wordLayerId]);

  const handleProjectCreated = (project) => {
    setShowCreateForm(false);
    // Jump straight into the new project. If the id is somehow missing, fall
    // back to refreshing the list in place.
    if (project?.id) navigate(routes.documents(project.id));
    else fetchProjects();
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
      <NewProject
        isOpen={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        onSuccess={handleProjectCreated}
      />

      <LinkedListPage
        className=""
        title="Projects"
        action={
          <Button onClick={() => setShowCreateForm(true)}>
            <Plus className="h-4 w-4" /> {newProject}
          </Button>
        }
        href={(p) => routes.documents(p.id)}
        rows={projects}
        columns={columns}
        loading={loading}
        error={error}
        empty={{
          title: 'No projects yet',
          hint: `Create one with ${newProject}, or ask a project's maintainer for an invitation link.`,
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
