import { useEffect, useRef, useState } from 'react';
import { planItemConcordance, loadConcordanceGroups } from './vocabConcordance';

// How many documents' sentences one batch of the concordance brings in.
const CONC_BATCH = 8;

// The concordance for the open entry: a cheap plan (the queries) and then
// document groups loaded a batch at a time, more arriving as the sentinel at
// the bottom scrolls into view or its Load-more button is pressed. `skipId`
// is the id of an entry that is not saved yet, which has no concordance.
export function useItemConcordance({ client, vocabularyId, selectedId, skipId }) {
  const [concPlan, setConcPlan] = useState(null);
  const [concGroups, setConcGroups] = useState([]);
  const [concLoaded, setConcLoaded] = useState(0); // # of docs loaded so far
  const [concLoading, setConcLoading] = useState(false); // plan + first batch
  const [concLoadingMore, setConcLoadingMore] = useState(false);
  const [concError, setConcError] = useState('');
  const concReq = useRef(0);
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef(null);
  const loadMoreRef = useRef(() => {});

  // Plan the concordance + load the first batch whenever a real item is selected.
  useEffect(() => {
    if (!selectedId || selectedId === skipId) {
      setConcPlan(null);
      setConcGroups([]);
      setConcLoaded(0);
      setConcError('');
      return;
    }
    const my = ++concReq.current;
    loadingMoreRef.current = false;
    setConcPlan(null);
    setConcGroups([]);
    setConcLoaded(0);
    setConcError('');
    setConcLoading(true);
    planItemConcordance(client, vocabularyId, selectedId)
      .then(async (plan) => {
        if (concReq.current !== my) return;
        setConcPlan(plan);
        const first = plan.docs.slice(0, CONC_BATCH);
        const groups = await loadConcordanceGroups(client, plan.hitIds, first);
        if (concReq.current !== my) return;
        setConcGroups(groups);
        setConcLoaded(first.length);
        setConcLoading(false);
      })
      .catch((err) => {
        if (concReq.current !== my) return;
        console.error('Concordance failed:', err);
        setConcError('Could not load usage examples.');
        setConcLoading(false);
      });
    // Runs once per selection; the client is read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, vocabularyId]);

  // Load the next batch of documents (called by the infinite-scroll sentinel or
  // its Load-more button). A synchronous ref guards against double-firing.
  const concHasMore = !!concPlan && concLoaded < concPlan.docs.length;
  const loadMore = async () => {
    if (!concPlan || loadingMoreRef.current || concLoaded >= concPlan.docs.length) return;
    const my = concReq.current;
    loadingMoreRef.current = true;
    setConcLoadingMore(true);
    try {
      const next = concPlan.docs.slice(concLoaded, concLoaded + CONC_BATCH);
      const groups = await loadConcordanceGroups(client, concPlan.hitIds, next);
      if (concReq.current !== my) return;
      setConcGroups((prev) => [...prev, ...groups]);
      setConcLoaded((prev) => prev + next.length);
    } catch (err) {
      console.error('Load more concordance failed:', err);
    } finally {
      loadingMoreRef.current = false;
      if (concReq.current === my) setConcLoadingMore(false);
    }
  };
  loadMoreRef.current = loadMore;

  // Auto-load more when the sentinel scrolls into view.
  useEffect(() => {
    if (!concHasMore) return undefined;
    const el = sentinelRef.current;
    if (!el) return undefined;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreRef.current();
      },
      { rootMargin: '300px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [concHasMore, concLoaded]);

  return {
    concPlan,
    concGroups,
    concLoaded,
    concLoading,
    concLoadingMore,
    concError,
    concHasMore,
    loadMore,
    sentinelRef,
  };
}
