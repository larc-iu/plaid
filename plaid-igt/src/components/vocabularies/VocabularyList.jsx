import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Plus, ArrowUp, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { notifyWarning, isPermissionError } from '@/utils/feedback';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

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

export const VocabularyList = () => {
  useDocumentTitle('Vocabularies');
  const navigate = useNavigate();
  const [vocabularies, setVocabularies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // vocabLayerId -> item count (number), or undefined while still loading.
  const [itemCounts, setItemCounts] = useState({});
  const [countsLoading, setCountsLoading] = useState(true);
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const { client, logout } = useAuth();

  const fetchVocabularies = async () => {
    try {
      setLoading(true);
      if (!client) throw new Error('Not authenticated');
      const vocabList = await client.vocabLayers.list();
      setVocabularies(vocabList);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        logout();
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

  // Item counts come from a single grouped aggregate query: count vocab items
  // grouped by their layer, across every vocab the user can read. One round trip.
  useEffect(() => {
    if (!vocabularies.length) return;
    let cancelled = false;
    (async () => {
      setCountsLoading(true);
      if (!client) return;
      try {
        const res = await client.query({
          where: [['vocab', '?v', { layer: '?l' }]],
          return: { group: ['?l'], aggregates: [['count']] },
        });
        const byLayer = {};
        for (const [layerId, n] of res?.results || []) byLayer[layerId] = n;
        const counts = {};
        for (const v of vocabularies) counts[v.id] = byLayer[v.id] ?? 0;
        if (!cancelled) setItemCounts(counts);
      } catch (err) {
        console.error('Vocab item-count query failed:', err);
        if (!cancelled) {
          setItemCounts({}); // leave counts unknown -> "—"
          // A user with no project access (e.g. a vocab-only maintainer) can't run
          // the count query — that's expected, not an error worth a toast.
          if (!isPermissionError(err)) {
            notifyWarning('Item counts could not be loaded for the vocabulary list.', 'Item counts unavailable');
          }
        }
      } finally {
        if (!cancelled) setCountsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [vocabularies, client]);

  const onSort = (key) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const sortedVocabularies = useMemo(() => {
    const extract = {
      name: (v) => v.name?.toLowerCase() ?? '',
      items: (v) => (itemCounts[v.id] == null ? -1 : itemCounts[v.id]),
      maintainers: (v) => v.maintainers?.length ?? 0,
    }[sort.key];
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...vocabularies].sort((a, b) => {
      const av = extract(a);
      const bv = extract(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [vocabularies, itemCounts, sort]);

  const renderItems = (vocabId) => {
    if (countsLoading && itemCounts[vocabId] === undefined) {
      return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary align-middle" />;
    }
    const v = itemCounts[vocabId];
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
        <h1 className="text-3xl font-bold tracking-tight">Vocabularies</h1>
        <Button onClick={() => navigate('/vocabularies/new')}>
          <Plus className="h-4 w-4" /> New Vocabulary
        </Button>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {vocabularies.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <p className="text-lg">No vocabularies found</p>
          <p className="mt-1 text-sm">Create your first vocabulary to get started.</p>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className="px-4 py-2 text-left">
                  <SortHeader field="name" label="Vocabulary" sort={sort} onSort={onSort} />
                </th>
                <th className="px-4 py-2 text-right">
                  <SortHeader field="items" label="Items" sort={sort} onSort={onSort} className="justify-end" />
                </th>
                <th className="px-4 py-2 text-right">
                  <SortHeader field="maintainers" label="Maintainers" sort={sort} onSort={onSort} className="justify-end" />
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedVocabularies.map((vocabulary) => (
                <tr
                  key={vocabulary.id}
                  onClick={() => navigate(`/vocabularies/${vocabulary.id}`)}
                  className="cursor-pointer border-b last:border-0 hover:bg-accent/40"
                >
                  <td className="px-4 py-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{vocabulary.name}</div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {renderItems(vocabulary.id)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {vocabulary.maintainers?.length ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
