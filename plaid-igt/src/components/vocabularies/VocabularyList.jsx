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
import { loadEntryCounts } from '@/domain/vocabEntryCounts.js';
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
      fill: true,
      sort: (v) => v.name?.toLowerCase() ?? '',
      cell: (v) => (
        <div className="min-w-0">
          <div className="truncate font-medium" title={v.name}>
            {v.name}
          </div>
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

  return (
    <LinkedListPage
      title="Vocabularies"
      action={
        <NewLinkButton to="/vocabularies/new">
          <Plus className="h-4 w-4" /> New vocabulary
        </NewLinkButton>
      }
      href={(v) => `/vocabularies/${v.id}`}
      rows={vocabularies}
      columns={columns}
      loading={loading}
      error={error}
      empty={{
        title: 'No vocabularies found',
        hint: 'Create one with New vocabulary.',
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
