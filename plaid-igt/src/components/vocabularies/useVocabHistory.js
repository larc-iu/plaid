import { useCallback, useEffect, useRef, useState } from 'react';
import { humanizeError, statusOf } from '@ui/lib/errors.js';
import { notifyError } from '@/utils/feedback';
import { OPS_SHOWN } from '@ui/hooks/useDocumentHistory.js';
import { t } from '@ui/lib/i18n.js';

// A vocabulary's history rail and the past state it shows: the entries of the
// vocabulary as they were after the history entry the reader picked, read-only.
// The shape of plaid-ui's useHistoryView for a document, over the vocabulary's
// own log (`vocabLayers.audit`) and its as-of read (`vocabLayers.get` with a
// time), which a document's hook cannot reach.
//
// The rail lists every change to the vocabulary and its entries, or, opened
// from one entry (`openHistory(itemId)`), only the changes that wrote that
// entry. Links are not in it: a link is annotation, and shows in its
// document's history.
//
// `selected` flips the moment an entry is picked, so the screen goes read-only
// at once. `past` (`{ time, vocabulary }`) is what is on screen, and lands when
// its read does. A read overtaken by a later pick is dropped.
// The rail's entries, every page of them, each with at most its oldest
// OPS_SHOWN actions and `opCount`, as a document's rail reads them: one Bulk
// Edit of 5,000 entries made every open of the rail ship all 5,000 (SCL4-5).
// `itemId` keeps the changes that wrote that one entry.
const readEntries = async (client, vocabularyId, itemId) => {
  const entries = [];
  let cursor;
  do {
    const page = await client.vocabLayers.auditPage(vocabularyId, {
      limit: 1000,
      opsLimit: OPS_SHOWN,
      itemId: itemId ?? undefined,
      cursor,
    });
    entries.push(...(page?.entries || []));
    cursor = page?.nextCursor;
  } while (cursor);
  return entries;
};

export function useVocabHistory({ client, vocabularyId, onExpired }) {
  const [open, setOpen] = useState(false);
  // The entry whose changes the rail lists, or null for the whole vocabulary.
  const [itemId, setItemId] = useState(null);
  const scopeRef = useRef(null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [past, setPast] = useState(null);
  const [loadingPast, setLoadingPast] = useState(false);
  const readRef = useRef(0);
  const pickRef = useRef(0);
  const loadedRef = useRef(false);
  // The entry whose state is on screen: where a failed read puts the rail back.
  const shownRef = useRef(null);
  const expiredRef = useRef(onExpired);
  expiredRef.current = onExpired;

  // Walking to another vocabulary keeps the screen mounted: the rail and any
  // past state were the last one's, and every read still out is dropped.
  useEffect(() => {
    readRef.current += 1;
    pickRef.current += 1;
    loadedRef.current = false;
    shownRef.current = null;
    scopeRef.current = null;
    setItemId(null);
    setOpen(false);
    setEntries([]);
    setError('');
    setLoading(false);
    setSelected(null);
    setPast(null);
    setLoadingPast(false);
  }, [vocabularyId]);

  const expired = (err) => {
    if (statusOf(err) !== 401) return false;
    expiredRef.current?.();
    return true;
  };

  const readLog = useCallback(async () => {
    if (!client || !vocabularyId) return;
    const mine = ++readRef.current;
    if (!loadedRef.current) setLoading(true);
    try {
      const list = await readEntries(client, vocabularyId, scopeRef.current);
      if (mine !== readRef.current) return;
      loadedRef.current = true;
      setEntries(list || []);
      setError('');
    } catch (err) {
      if (mine !== readRef.current || expired(err)) return;
      console.error('Error reading the vocabulary history:', err);
      setError(humanizeError(err, t('The history could not be read.')));
    } finally {
      if (mine === readRef.current) setLoading(false);
    }
  }, [client, vocabularyId]);

  // The next OPS_SHOWN actions of an entry the read cut: the same entry read
  // again from its last action held, which comes back first and is dropped.
  const [loadingMore, setLoadingMore] = useState(null);
  const loadMoreOps = async (entryId) => {
    const entry = entries.find((e) => e.id === entryId);
    const last = entry?.ops?.[entry.ops.length - 1];
    if (!entry || !last || !client) return;
    const mine = readRef.current;
    setLoadingMore(entryId);
    try {
      const page = await client.vocabLayers.auditPage(vocabularyId, {
        entryId,
        startTime: last.time,
        opsLimit: OPS_SHOWN + 1,
        itemId: scopeRef.current ?? undefined,
      });
      if (mine !== readRef.current) return;
      const more = page?.entries?.[0]?.ops || [];
      setEntries((prev) =>
        prev.map((e) => {
          if (e.id !== entryId) return e;
          const held = new Set((e.ops || []).map((op) => op.id));
          return { ...e, ops: [...(e.ops || []), ...more.filter((op) => !held.has(op.id))] };
        }),
      );
    } catch (err) {
      if (expired(err)) return;
      notifyError(err, t('Failed to load more actions'));
    } finally {
      setLoadingMore(null);
    }
  };

  // `id` is an entry's, or anything else (a click event) for the whole
  // vocabulary. A new scope starts from an empty list.
  const openHistory = (id) => {
    const scope = typeof id === 'string' ? id : null;
    if (scope !== scopeRef.current) {
      scopeRef.current = scope;
      loadedRef.current = false;
      setEntries([]);
      setError('');
    }
    setItemId(scope);
    setOpen(true);
    readLog();
  };

  // When the rail is one entry's, a change in it holds only the operations
  // that wrote that entry, and ends where the last of them did: partway
  // through an import that went on to make more entries. Picked whole, the
  // vocabulary is read as of the end of the whole change. A single operation
  // picked is read as of its own end.
  const wholeChangeEnd = async (entry) => {
    if (!scopeRef.current || !entries.some((e) => e.id === entry.id)) return entry.time;
    const page = await client.vocabLayers.auditPage(vocabularyId, {
      entryId: entry.id,
      opsLimit: 1,
    });
    return page?.entries?.[0]?.endTime || entry.time;
  };

  const select = async (entry) => {
    const mine = ++pickRef.current;
    setSelected(entry);
    if (!entry) {
      shownRef.current = null;
      setPast(null);
      setLoadingPast(false);
      return;
    }
    setLoadingPast(true);
    try {
      const time = await wholeChangeEnd(entry);
      if (mine !== pickRef.current) return;
      const vocabulary = await client.vocabLayers.get(vocabularyId, true, time);
      if (mine !== pickRef.current) return;
      shownRef.current = entry;
      setPast({ time, vocabulary });
    } catch (err) {
      if (mine !== pickRef.current || expired(err)) return;
      console.error('Error reading the vocabulary at a past time:', err);
      notifyError(err, t('Failed to load that state'));
      setSelected(shownRef.current);
    } finally {
      if (mine === pickRef.current) setLoadingPast(false);
    }
  };

  const closeHistory = () => {
    setOpen(false);
    scopeRef.current = null;
    loadedRef.current = false;
    setItemId(null);
    if (selected) select(null);
  };

  // Back to the live vocabulary, with the rail read again: after a restore
  // (or its undo) the log has a new newest entry.
  const backToNow = async () => {
    await select(null);
    if (open) await readLog();
  };

  return {
    open,
    itemId,
    openHistory,
    closeHistory,
    entries,
    loading,
    error,
    readLog,
    loadMoreOps,
    loadingMore,
    selected,
    select,
    past,
    loadingPast,
    backToNow,
  };
}
