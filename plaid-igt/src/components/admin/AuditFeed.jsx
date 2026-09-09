import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SearchInput, ListCount, ListPager, ListHint } from '@/components/ui/list-search';
import { usePagedList } from '@/hooks/usePagedList';
import { notifyError } from '@/utils/feedback';
import { AuditEntries, entryLabel } from './AuditEntries';

// A paged audit feed. `fetchPage({cursor, limit})` returns the server's
// `{entries, nextCursor}` newest-first, and this holds what has been loaded so
// far: the pager walks it, the search box filters it, and "Load older" asks
// the server for the next chunk.
//
// A window's worth of history is unbounded, so it is never all pulled at once.
// A chunk is what a reader can page through without waiting, and asking for
// more is a decision they make.

const CHUNK = 200;

export const AuditFeed = ({ fetchPage, showUser = false, empty = 'Nothing yet.', resetKey }) => {
  const [entries, setEntries] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setSearch('');
    try {
      const page = await fetchPage({ limit: CHUNK });
      setEntries(page.entries || []);
      setCursor(page.nextCursor || null);
    } catch (err) {
      console.error('Error loading the audit feed:', err);
      notifyError(err.message || 'Failed to load recent changes', 'Error');
      setEntries([]);
      setCursor(null);
    } finally {
      setLoading(false);
    }
    // `resetKey` is what re-scopes the feed (the window, the project). The
    // fetcher is a fresh closure on every render, so it cannot be the dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    load();
  }, [load]);

  const loadOlder = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage({ limit: CHUNK, cursor });
      setEntries((prev) => [...prev, ...(page.entries || [])]);
      setCursor(page.nextCursor || null);
    } catch (err) {
      notifyError(err.message || 'Failed to load older changes', 'Error');
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => {
      const haystack = [
        entryLabel(e),
        e.user?.displayName,
        e.user?.id,
        ...(e.documents || []).map((d) => d.name),
        ...(e.projects || []).map((p) => p.name),
      ];
      return haystack.some((v) => v && v.toLowerCase().includes(q));
    });
  }, [entries, search]);

  const paged = usePagedList(filtered, { resetKey: `${resetKey}:${search}` });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-3 pt-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search changes…"
          className="max-w-xs"
        />
        <ListCount shown={filtered.length} total={entries.length} noun="change" />
      </div>
      <div className="border-t">
        <ListPager {...paged} onPage={paged.setPage} position="top" />
        {loading ? (
          <p className="p-3 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <AuditEntries
            entries={paged.pageItems}
            showUser={showUser}
            empty={entries.length === 0 ? empty : 'No changes match.'}
          />
        )}
        <ListPager {...paged} onPage={paged.setPage} position="bottom" />
      </div>
      {cursor && !loading && (
        <div className="flex items-center gap-2 px-3 pb-3">
          <Button size="sm" variant="outline" onClick={loadOlder} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load older'}
          </Button>
          <ListHint>Older changes are not loaded yet.</ListHint>
        </div>
      )}
    </div>
  );
};
