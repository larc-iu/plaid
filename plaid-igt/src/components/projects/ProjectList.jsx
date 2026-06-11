import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Plus, ArrowUp, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { notifyWarning } from '@/utils/feedback';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';

// Sortable column header button (renders an arrow for the active column).
const SortHeader = ({ field, label, sort, onSort, className }) => {
  const active = sort.key === field;
  const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={cn(
        'inline-flex items-center gap-1 font-medium text-muted-foreground transition-colors hover:text-foreground',
        active && 'text-foreground',
        className
      )}
    >
      {label}
      {active && <Arrow className="h-3 w-3" />}
    </button>
  );
};

export const ProjectList = () => {
  const navigate = useNavigate();
  const { client, logout } = useAuth();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // projectId -> word count (number), or null when the project has no primary
  // word-token layer. `undefined` (missing key) means "still loading".
  const [wordCounts, setWordCounts] = useState({});
  const [wordsLoading, setWordsLoading] = useState(true);
  const [sort, setSort] = useState({ key: 'updated', dir: 'desc' });

  const fetchProjects = async () => {
    try {
      setLoading(true);
      if (!client) throw new Error('Not authenticated');
      const projectList = await client.projects.list();
      setProjects(projectList);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        logout();
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
          notifyWarning('Word counts could not be loaded for the project list.', 'Word counts unavailable');
        }
      } finally {
        if (!cancelled) setWordsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projects, client]);

  const onSort = (key) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const sortedProjects = useMemo(() => {
    const extract = {
      name: (p) => p.name?.toLowerCase() ?? '',
      documents: (p) => p.documentCount ?? 0,
      words: (p) => (wordCounts[p.id] == null ? -1 : wordCounts[p.id]),
      updated: (p) => (p.lastModified ? new Date(p.lastModified).getTime() : 0),
    }[sort.key];
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...projects].sort((a, b) => {
      const av = extract(a);
      const bv = extract(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [projects, wordCounts, sort]);

  const renderWords = (projectId) => {
    if (wordsLoading && wordCounts[projectId] === undefined) {
      return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary align-middle" />;
    }
    const v = wordCounts[projectId];
    return v == null ? '—' : v.toLocaleString();
  };

  if (loading) {
    return (
      <div className="tw flex items-center justify-center py-24 text-muted-foreground">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  return (
    <div className="tw mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
        <Button onClick={() => navigate('/projects/new')}>
          <Plus className="h-4 w-4" /> New Project
        </Button>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {projects.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <p className="text-lg">No projects found</p>
          <p className="mt-1 text-sm">You don&apos;t have access to any projects yet.</p>
        </Card>
      ) : (
        <TooltipProvider>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className="px-4 py-2 text-left">
                    <SortHeader field="name" label="Project" sort={sort} onSort={onSort} />
                  </th>
                  <th className="px-4 py-2 text-right">
                    <SortHeader field="documents" label="Docs" sort={sort} onSort={onSort} className="justify-end" />
                  </th>
                  <th className="px-4 py-2 text-right">
                    <SortHeader field="words" label="Words" sort={sort} onSort={onSort} className="justify-end" />
                  </th>
                  <th className="px-4 py-2 text-right">
                    <SortHeader field="updated" label="Updated" sort={sort} onSort={onSort} className="justify-end" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedProjects.map((project) => (
                  <tr
                    key={project.id}
                    onClick={() => navigate(`/projects/${project.id}`)}
                    className="cursor-pointer border-b last:border-0 hover:bg-accent/40"
                  >
                    <td className="px-4 py-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{project.name}</div>
                        <div className="truncate text-xs text-muted-foreground">ID: {project.id}</div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {project.documentCount ?? 0}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {renderWords(project.id)}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {project.lastModified ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>{timeAgo(project.lastModified) || '—'}</span>
                          </TooltipTrigger>
                          <TooltipContent>{fullTimestamp(project.lastModified)}</TooltipContent>
                        </Tooltip>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TooltipProvider>
      )}
    </div>
  );
};
