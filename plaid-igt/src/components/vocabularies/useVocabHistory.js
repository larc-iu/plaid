import { useCallback, useEffect, useRef, useState } from 'react';
import { humanizeError, statusOf } from '@ui/lib/errors.js';
import { notifyError } from '@/utils/feedback';

// A vocabulary's history rail and the past state it shows: the entries of the
// vocabulary as they were after the history entry the reader picked, read-only.
// The shape of plaid-ui's useHistoryView for a document, over the vocabulary's
// own log (`vocabLayers.audit`) and its as-of read (`vocabLayers.get` with a
// time), which a document's hook cannot reach.
//
// The rail lists every change to the vocabulary and its entries. Links are not
// in it: a link is annotation, and shows in its document's history.
//
// `selected` flips the moment an entry is picked, so the screen goes read-only
// at once. `past` (`{ time, vocabulary }`) is what is on screen, and lands when
// its read does. A read overtaken by a later pick is dropped.
export function useVocabHistory({ client, vocabularyId, onExpired }) {
  const [open, setOpen] = useState(false);
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
      const list = await client.vocabLayers.audit(vocabularyId);
      if (mine !== readRef.current) return;
      loadedRef.current = true;
      setEntries(list || []);
      setError('');
    } catch (err) {
      if (mine !== readRef.current || expired(err)) return;
      console.error('Error reading the vocabulary history:', err);
      setError(humanizeError(err, 'The history could not be read.'));
    } finally {
      if (mine === readRef.current) setLoading(false);
    }
  }, [client, vocabularyId]);

  const openHistory = () => {
    setOpen(true);
    readLog();
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
      const vocabulary = await client.vocabLayers.get(vocabularyId, true, entry.time);
      if (mine !== pickRef.current) return;
      shownRef.current = entry;
      setPast({ time: entry.time, vocabulary });
    } catch (err) {
      if (mine !== pickRef.current || expired(err)) return;
      console.error('Error reading the vocabulary at a past time:', err);
      notifyError(err, 'That state could not be loaded');
      setSelected(shownRef.current);
    } finally {
      if (mine === pickRef.current) setLoadingPast(false);
    }
  };

  const closeHistory = () => {
    setOpen(false);
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
    openHistory,
    closeHistory,
    entries,
    loading,
    error,
    readLog,
    selected,
    select,
    past,
    loadingPast,
    backToNow,
  };
}
