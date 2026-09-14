import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import {
  LinkedListPage,
  CountCell,
  TimeCell,
  NewLinkButton,
} from '@ui/components/shared/LinkedListPage.jsx';
import { notifyWarning, isPermissionError } from '@/utils/feedback';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { PARENT_KEY } from '@/domain/vocabDictionary';
import { textIncludes } from '@ui/domain/collation.js';

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
          // the count query, which is expected, not an error worth a toast.
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

  const columns = [
    {
      key: 'name',
      label: 'Vocabulary',
      sort: (v) => v.name?.toLowerCase() ?? '',
      cell: (v) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{v.name}</div>
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

  return (
    <LinkedListPage
      title="Vocabularies"
      action={
        <NewLinkButton to="/vocabularies/new">
          <Plus className="h-4 w-4" /> New Vocabulary
        </NewLinkButton>
      }
      href={(v) => `/vocabularies/${v.id}`}
      rows={vocabularies}
      columns={columns}
      loading={loading}
      error={error}
      empty={{
        title: 'No vocabularies found',
        hint: 'Create your first vocabulary to get started.',
      }}
      tableId="vocabularies"
      noun="vocabulary"
      defaultSort={{ key: 'name', dir: 'asc' }}
      search={{
        placeholder: 'Search vocabularies…',
        match: (v, q) => textIncludes(v.name || '', q),
      }}
    />
  );
};
