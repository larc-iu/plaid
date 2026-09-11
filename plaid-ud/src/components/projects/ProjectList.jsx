import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { ProjectForm } from './ProjectForm';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { timeAgo, fullTimestamp } from '../../utils/formatTime.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Button } from '@ui/components/ui/button';
import { Card } from '@ui/components/ui/card';
import { DataTable } from '@ui/components/ui/data-table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@ui/components/ui/tooltip';

export const ProjectList = () => {
  useDocumentTitle('Projects');
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  // projectId -> word count (number), or null when the project has no UD word
  // layer. `undefined` (missing key) means "still loading".
  const [wordCounts, setWordCounts] = useState({});
  const [wordsLoading, setWordsLoading] = useState(true);
  const { getClient, logout } = useAuth();
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
        // A rejected token is invalid — log out (clears the stored token) before
        // redirecting, so /login doesn't bounce straight back here (infinite loop).
        logout();
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
    return () => {
      cancelled = true;
    };
  }, [projects, getClient]);

  const handleProjectCreated = (project) => {
    setShowCreateForm(false);
    // Jump straight into the new project. If the id is somehow missing, fall
    // back to refreshing the list in place.
    if (project?.id) {
      navigate(`/projects/${project.id}/documents`);
    } else {
      fetchProjects();
    }
  };

  const renderWords = (projectId) => {
    if (wordsLoading && wordCounts[projectId] === undefined) return '…';
    const v = wordCounts[projectId];
    return v == null ? '—' : v.toLocaleString();
  };

  // A row is a link to the project, so each cell holds the anchor rather than
  // the row holding an onClick: middle-click and cmd-click then work the way
  // they do on any link, and the whole row is still a target.
  const linked = (project, className, children) => (
    <Link to={`/projects/${project.id}/documents`} className={className}>
      {children}
    </Link>
  );

  const columns = [
    {
      key: 'name',
      label: 'Project',
      sort: (p) => p.name?.toLowerCase() ?? '',
      className: 'p-0',
      render: (p) =>
        linked(
          p,
          'block px-4 py-3',
          <div className="min-w-0">
            <div className="truncate font-medium">{p.name}</div>
            <div className="truncate text-xs text-muted-foreground">ID: {p.id}</div>
          </div>,
        ),
    },
    {
      key: 'documents',
      label: 'Docs',
      sort: (p) => p.documentCount ?? 0,
      align: 'right',
      className: 'p-0',
      render: (p) =>
        linked(
          p,
          'block px-4 py-3 text-right tabular-nums text-muted-foreground',
          p.documentCount ?? 0,
        ),
    },
    {
      key: 'words',
      label: 'Words',
      // A project with no word layer counts as the smallest, which is what a
      // blank means here.
      sort: (p) => wordCounts[p.id] ?? null,
      align: 'right',
      className: 'p-0',
      render: (p) =>
        linked(
          p,
          'block px-4 py-3 text-right tabular-nums text-muted-foreground',
          renderWords(p.id),
        ),
    },
    {
      key: 'updated',
      label: 'Updated',
      sort: (p) => (p.lastModified ? new Date(p.lastModified).getTime() : null),
      align: 'right',
      className: 'p-0',
      render: (p) =>
        linked(
          p,
          'block px-4 py-3 text-right text-muted-foreground',
          p.lastModified ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>{timeAgo(p.lastModified) || '—'}</span>
              </TooltipTrigger>
              <TooltipContent>{fullTimestamp(p.lastModified)}</TooltipContent>
            </Tooltip>
          ) : (
            '—'
          ),
        ),
    },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
        <Button onClick={() => setShowCreateForm(true)}>
          <Plus className="h-4 w-4" /> New UD project
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <ProjectForm
        isOpen={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        onSuccess={handleProjectCreated}
      />

      {loading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : projects.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <p className="text-lg">No projects yet</p>
          <p className="mt-1 text-sm">
            Create one with New UD project, or ask a project&apos;s maintainer for an invitation
            link.
          </p>
        </Card>
      ) : (
        <TooltipProvider>
          <DataTable
            rows={projects}
            columns={columns}
            rowKey={(p) => p.id}
            id="projects"
            defaultSort={{ key: 'updated', dir: 'desc' }}
            search={{
              placeholder: 'Search projects…',
              match: (p, q) => (p.name || '').toLowerCase().includes(q),
            }}
            noun="project"
          />
        </TooltipProvider>
      )}
    </div>
  );
};
