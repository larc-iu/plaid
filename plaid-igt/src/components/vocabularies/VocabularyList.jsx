import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Plus } from 'lucide-react';
import { DataTable } from '@ui/components/ui/data-table';
import { Button } from '@ui/components/ui/button';
import { Card } from '@ui/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@ui/components/ui/tooltip';
import { timeAgo, fullTimestamp } from '@ui/lib/formatTime.js';
import { notifyWarning, isPermissionError } from '@/utils/feedback';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { PARENT_KEY } from '@/domain/vocabDictionary';

export const VocabularyList = () => {
  useDocumentTitle('Vocabularies');
  const [vocabularies, setVocabularies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // vocabLayerId -> item count (number), or undefined while still loading.
  const [itemCounts, setItemCounts] = useState({});
  const [countsLoading, setCountsLoading] = useState(true);
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

  // Item counts come from a single grouped aggregate query: count vocab items
  // grouped by their layer, across every vocab the user can read. One round trip.
  useEffect(() => {
    if (!vocabularies.length) return;
    let cancelled = false;
    (async () => {
      setCountsLoading(true);
      if (!client) return;
      try {
        // Two grouped aggregates: every row, and the rows that are SENSES. An
        // entry is what is left. Counting rows and calling them entries read
        // 23 for a dictionary of 20 entries and 3 senses, and the reader beside
        // it said something different again, so a lexicographer got two answers
        // to "how big is this" and neither was the number of entries.
        //
        // A sense is a row carrying a parent (PARENT_KEY, see vocabDictionary).
        // The query language has no "this key is set" test and cannot bind a
        // variable to a metadata field, but a regex matching anything is the
        // same question: it matches a row that HAS the key and skips one that
        // does not.
        const [all, senses] = await Promise.all([
          client.query({
            where: [['vocab', '?v', { layer: '?l' }]],
            return: { group: ['?l'], aggregates: [['count']] },
          }),
          client.query({
            where: [['vocab', '?v', { layer: '?l', metadata: { [PARENT_KEY]: { regex: '.*' } } }]],
            return: { group: ['?l'], aggregates: [['count']] },
          }),
        ]);
        const byLayer = {};
        for (const [layerId, n] of all?.results || []) byLayer[layerId] = n;
        const sensesByLayer = {};
        for (const [layerId, n] of senses?.results || []) sensesByLayer[layerId] = n;
        const counts = {};
        for (const v of vocabularies) {
          counts[v.id] = Math.max(0, (byLayer[v.id] ?? 0) - (sensesByLayer[v.id] ?? 0));
        }
        if (!cancelled) setItemCounts(counts);
      } catch (err) {
        console.error('Vocab item-count query failed:', err);
        if (!cancelled) {
          setItemCounts({}); // leave counts unknown -> "—"
          // A user with no project access (e.g. a vocab-only maintainer) can't run
          // the count query — that's expected, not an error worth a toast.
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

  const renderItems = (vocabId) => {
    if (countsLoading && itemCounts[vocabId] === undefined) {
      return (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary align-middle" />
      );
    }
    const v = itemCounts[vocabId];
    return v == null ? '—' : v.toLocaleString();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  // Cells wrap their content in a real link so the row behaves like one
  // (middle-click, "open in new tab"), same as the project and document
  // tables. The cell keeps no padding of its own, so the link fills it.
  const linked = (vocabulary, className, children) => (
    <Link to={`/vocabularies/${vocabulary.id}`} className={className}>
      {children}
    </Link>
  );

  const columns = [
    {
      key: 'name',
      label: 'Vocabulary',
      sort: (v) => v.name?.toLowerCase() ?? '',
      className: 'p-0',
      render: (v) =>
        linked(
          v,
          'block px-4 py-3',
          <div className="min-w-0">
            <div className="truncate font-medium">{v.name}</div>
          </div>,
        ),
    },
    {
      key: 'items',
      label: 'Entries',
      // A vocabulary whose count could not be read counts as the smallest,
      // the way it did when the comparator gave it -1.
      sort: (v) => itemCounts[v.id] ?? null,
      align: 'right',
      className: 'p-0',
      render: (v) =>
        linked(
          v,
          'block px-4 py-3 text-right tabular-nums text-muted-foreground',
          renderItems(v.id),
        ),
    },
    {
      key: 'updated',
      label: 'Updated',
      sort: (v) => (v.timeModified ? new Date(v.timeModified).getTime() : null),
      align: 'right',
      className: 'p-0',
      render: (v) =>
        linked(
          v,
          'block whitespace-nowrap px-4 py-3 text-right text-muted-foreground',
          // Null for vocabularies created before the layer carried
          // timestamps: they read as unknown until their next edit.
          v.timeModified ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>{timeAgo(v.timeModified) || '—'}</span>
              </TooltipTrigger>
              <TooltipContent>{fullTimestamp(v.timeModified)}</TooltipContent>
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
        <h1 className="text-3xl font-bold tracking-tight">Vocabularies</h1>
        <Button asChild>
          <Link to="/vocabularies/new">
            <Plus className="h-4 w-4" /> New Vocabulary
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

      {vocabularies.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <p className="text-lg">No vocabularies found</p>
          <p className="mt-1 text-sm">Create your first vocabulary to get started.</p>
        </Card>
      ) : (
        <TooltipProvider>
          <DataTable
            rows={vocabularies}
            columns={columns}
            rowKey={(v) => v.id}
            id="vocabularies"
            defaultSort={{ key: 'name', dir: 'asc' }}
            search={{
              placeholder: 'Search vocabularies…',
              match: (v, q) => (v.name || '').toLowerCase().includes(q),
            }}
            noun="vocabulary"
          />
        </TooltipProvider>
      )}
    </div>
  );
};
