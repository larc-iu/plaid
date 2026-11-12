import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { CountCell, TimeCell, NewLinkButton } from '@ui/components/shared/LinkedListPage.jsx';
import { DataTable } from '@ui/components/shared/data-table';
import { SearchInput } from '@ui/components/shared/list-search.jsx';
import { Card } from '@ui/components/ui/card';
import { TooltipProvider } from '@ui/components/ui/tooltip';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { LoadError } from '@ui/components/shared/LoadError.jsx';
import { EmptyState } from '@ui/components/shared/EmptyState.jsx';
import { TYPE } from '@ui/lib/typeScale.js';
import { notifyWarning, isPermissionError } from '@/utils/feedback';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { loadEntryCounts } from '@/domain/vocabEntryCounts.js';
import { compareText, textIncludes } from '@ui/domain/collation.js';
import { vocabImporting, withLiveMarks } from '@/domain/igtConfig';

// The vocabularies this person can read, grouped by the project each belongs
// to: a heading per project they can read, then "Other projects" for those
// whose project they cannot (a project of theirs links it).
export const VocabularyList = () => {
  useDocumentTitle('Vocabularies');
  const [vocabularies, setVocabularies] = useState([]);
  // The projects this person can read, for the group headings.
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  // vocabLayerId -> item count (number), or undefined while still loading.
  const [itemCounts, setItemCounts] = useState({});
  const [countsLoading, setCountsLoading] = useState(true);
  const { client, logout } = useAuth();

  const fetchVocabularies = async () => {
    try {
      setLoading(true);
      if (!client) throw new Error('Not authenticated');
      const [vocabList, projectList] = await Promise.all([
        client.vocabLayers.list().then((list) => withLiveMarks(client, list)),
        client.projects.list(),
      ]);
      setVocabularies(vocabList);
      setProjects(projectList || []);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        logout('expired');
        return;
      }
      setError('Failed to load vocabularies');
      console.error('Error fetching vocabularies:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVocabularies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Entry counts come from grouped aggregate queries across every vocabulary
  // the user can read (see loadEntryCounts).
  useEffect(() => {
    if (!vocabularies.length) return;
    let cancelled = false;
    (async () => {
      setCountsLoading(true);
      if (!client) return;
      try {
        const counts = await loadEntryCounts(
          client,
          vocabularies.map((v) => v.id),
        );
        if (!cancelled) setItemCounts(counts);
      } catch (err) {
        console.error('Vocab item-count query failed:', err);
        if (!cancelled) {
          setItemCounts({}); // leave counts unknown -> "—"
          if (!isPermissionError(err)) {
            notifyWarning(
              'Entry counts could not be loaded for the vocabulary list.',
              'Entry counts unavailable',
            );
          }
        }
      } finally {
        if (!cancelled) setCountsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vocabularies, client]);

  // `[{ key, title, rows }]`: the readable projects by name, then the rest.
  const groups = useMemo(() => {
    const shown = query.trim()
      ? vocabularies.filter((v) => textIncludes(v.name || '', query.trim()))
      : vocabularies;
    const named = new Map(projects.map((p) => [p.id, p]));
    const byProject = new Map();
    const others = [];
    for (const v of shown) {
      const home = named.get(v.project);
      if (!home) {
        others.push(v);
        continue;
      }
      if (!byProject.has(home.id)) byProject.set(home.id, { key: home.id, home, rows: [] });
      byProject.get(home.id).rows.push(v);
    }
    const list = [...byProject.values()]
      .sort((a, b) => compareText(a.home.name || '', b.home.name || ''))
      .map(({ key, home, rows }) => ({
        key,
        title: (
          <Link to={`/projects/${home.id}`} dir="auto" className="hover:underline">
            {home.name}
          </Link>
        ),
        rows,
      }));
    if (others.length) list.push({ key: 'others', title: 'Other projects', rows: others });
    return list;
  }, [vocabularies, projects, query]);

  const columns = [
    {
      key: 'name',
      label: 'Vocabulary',
      fill: true,
      sort: (v) => v.name?.toLowerCase() ?? '',
      cell: (v) => (
        <div className="flex min-w-0 items-center gap-2">
          <div dir="auto" className="truncate font-medium" title={v.name}>
            {v.name}
          </div>
          {vocabImporting(v.config) && (
            <span className="shrink-0 text-xs text-muted-foreground">Import did not finish</span>
          )}
        </div>
      ),
    },
    {
      key: 'items',
      label: 'Entries',
      // A vocabulary whose count could not be read counts as the smallest,
      // the way it did when the comparator gave it -1.
      sort: (v) => itemCounts[v.id] ?? null,
      align: 'right',
      nowrap: true,
      cell: (v) => <CountCell value={itemCounts[v.id]} loading={countsLoading} />,
    },
    {
      key: 'updated',
      label: 'Updated',
      sort: (v) => (v.timeModified ? new Date(v.timeModified).getTime() : null),
      align: 'right',
      nowrap: true,
      // Null for vocabularies created before the layer carried timestamps:
      // they read as unknown until their next edit.
      cell: (v) => <TimeCell at={v.timeModified} />,
    },
  ];
  // Every cell holds a real anchor, as LinkedListPage's do.
  const tableColumns = columns.map((column) => ({
    key: column.key,
    label: column.label,
    sort: column.sort,
    align: column.align,
    className: column.fill ? 'w-full min-w-40 max-w-0 p-0' : 'p-0',
    render: (row) => (
      <Link
        to={`/vocabularies/${row.id}`}
        className={[
          'block px-4 py-3',
          column.align === 'right' ? 'text-right tabular-nums text-muted-foreground' : '',
          column.nowrap ? 'whitespace-nowrap' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {column.cell(row)}
      </Link>
    ),
  }));

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className={TYPE.page}>Vocabularies</h1>
        <NewLinkButton to="/vocabularies/new">
          <Plus className="h-4 w-4" /> New vocabulary
        </NewLinkButton>
      </div>

      {error && (
        <LoadError onRetry={fetchVocabularies} className="mb-4">
          {error}
        </LoadError>
      )}

      {loading ? (
        <Loading />
      ) : vocabularies.length === 0 && error ? null : vocabularies.length === 0 ? (
        <Card>
          <EmptyState title="No vocabularies found" hint="Create one with New vocabulary." />
        </Card>
      ) : (
        <TooltipProvider>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search vocabularies…"
            className="mb-4 max-w-[16rem]"
          />
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No vocabularies match.</p>
          ) : (
            <div className="flex flex-col gap-6">
              {groups.map((g) => (
                <section key={g.key} data-group={g.key}>
                  <DataTable
                    title={g.title}
                    rows={g.rows}
                    columns={tableColumns}
                    rowKey={(row) => row.id}
                    id="vocabularies"
                    defaultSort={{ key: 'name', dir: 'asc' }}
                    noun="vocabulary"
                  />
                </section>
              ))}
            </div>
          )}
        </TooltipProvider>
      )}
    </div>
  );
};
