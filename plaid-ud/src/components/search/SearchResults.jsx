import { useMemo, useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { pageSlice, TALL_LIST_PAGE_SIZE } from '@ui/hooks/usePagedList';
import { ListPager } from '@ui/components/ui/list-search';
import { segmentize } from './grewToHighlight.js';

// Renders grouped sentence matches. `groups` come from groupResults():
// [{ docId, sentenceId, text, highlights }]. Each sentence is a real link to
// the annotation editor (deep-linked via ?sent=), built by `hrefFor`. The full
// match set is paged client-side (the query API returns all matches at once —
// it has no offset/cursor), at the shared tall-row page size: a hit is a whole
// sentence under a document heading, not a table row.
export const SearchResults = ({
  groups,
  count,
  truncated,
  warnings,
  searched,
  docName,
  hrefFor,
}) => {
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [groups]);

  // Memoized so `pageItems` keeps its identity across renders that change
  // neither the results nor the page — the grouping below keys on it.
  const paged = useMemo(() => pageSlice(groups, page, TALL_LIST_PAGE_SIZE), [groups, page]);
  const { pageItems } = paged;

  // Group only the current page's sentences by document for rendering.
  const byDoc = useMemo(() => {
    const m = new Map();
    for (const g of pageItems) {
      if (!m.has(g.docId)) m.set(g.docId, []);
      m.get(g.docId).push(g);
    }
    return [...m.entries()];
  }, [pageItems]);

  return (
    <div className="flex flex-col gap-4">
      {warnings?.length > 0 && (
        <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex flex-col gap-0.5">
            {warnings.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>
        </div>
      )}

      {searched && (
        <p className="text-sm text-muted-foreground">
          {groups.length === 0
            ? 'No matching sentences.'
            : `${groups.length} matching sentence${groups.length === 1 ? '' : 's'}` +
              (truncated ? ` (capped at ${count}, refine the query for more)` : '')}
        </p>
      )}

      <ListPager {...paged} onPage={setPage} position="top" className="rounded-md border" />

      {byDoc.map(([docId, sentences]) => (
        <div key={docId} className="overflow-hidden rounded-md border">
          <div className="truncate border-b px-4 py-2 text-sm font-semibold">
            {docName(docId) || docId}
          </div>
          <div className="flex flex-col">
            {sentences.map((s, idx) => (
              <Link
                key={s.sentenceId}
                to={hrefFor(s.docId, s.sentenceId)}
                className={`block p-4 text-sm leading-relaxed hover:bg-muted/50 ${idx ? 'border-t' : ''}`}
              >
                {segmentize(s.text, s.highlights).map((seg, i) =>
                  seg.hl ? (
                    <mark key={i} className="rounded-sm bg-yellow-200 px-0.5 text-foreground">
                      {seg.text}
                    </mark>
                  ) : (
                    <span key={i}>{seg.text}</span>
                  ),
                )}
              </Link>
            ))}
          </div>
        </div>
      ))}

      <ListPager {...paged} onPage={setPage} className="rounded-md border" />
    </div>
  );
};
