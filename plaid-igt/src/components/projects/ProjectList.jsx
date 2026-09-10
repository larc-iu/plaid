import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Plus } from 'lucide-react';
import { DataTable } from '@ui/components/ui/data-table';
import { Button } from '@ui/components/ui/button';
import { Card } from '@ui/components/ui/card';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@ui/components/ui/tooltip';
import { notifyWarning } from '@/utils/feedback';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { timeAgo, fullTimestamp } from '@ui/utils/formatTime';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

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

  // Word counts come from a single grouped aggregate query: count tokens grouped
  // by their token layer across every readable project, then map each project's
  // primary (word) token-layer id to its count. One round trip for the whole list.
  useEffect(() => {
    if (!projects.length) return;
    let cancelled = false;
    (async () => {
      setWordsLoading(true);
      if (!client) return;
      try {
        // `layer: '?l'` binds a layer *variable* (a bare "?name" string).
        const res = await client.query({
          where: [['token', '?t', { layer: '?l' }]],
          return: { group: ['?l'], aggregates: [['count']] },
        });
        const byLayer = new Map((res?.results || []).map(([layerId, n]) => [layerId, n]));
        const byProject = {};
        for (const p of projects) {
          // "Words" = the primary token layer (the orthographic word tokens);
          // morphemes are sub-word units and shouldn't inflate the word count.
          const wordLayerId = getIgtLayerInfo(p).primaryTokenLayer?.id;
          byProject[p.id] = wordLayerId ? (byLayer.get(wordLayerId) ?? 0) : null;
        }
        if (!cancelled) setWordCounts(byProject);
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

  const renderWords = (projectId) => {
    if (wordsLoading && wordCounts[projectId] === undefined) {
      return (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary align-middle" />
      );
    }
    const v = wordCounts[projectId];
    return v == null ? '—' : v.toLocaleString();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  // Every cell wraps its content in a real link (rather than a row onClick) so
  // the row behaves like one: middle-click and right-click "open in new tab"
  // work natively. Same shape as the document table. The cell keeps no padding
  // of its own, so the link fills it.
  const linked = (project, className, children) => (
    <Link to={`/projects/${project.id}`} className={className}>
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
      // A project with no word layer counts as the smallest, the way it did
      // when the comparator gave it -1.
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
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
        <Button asChild>
          <Link to="/projects/new">
            <Plus className="h-4 w-4" /> New Project
          </Link>
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

      {projects.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <p className="text-lg">No projects yet</p>
          <p className="mt-1 text-sm">
            Create one with New Project, or ask a project's maintainer for an invitation link.
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
