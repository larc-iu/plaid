import { useState, useEffect, useRef } from 'react';
import { notifyError, notifyWarning, isPermissionError } from '@/utils/feedback';
import { metadataUpdates } from '@/domain/metadataPatch';
import { useSavingGuard } from '@ui/hooks/useSavingGuard.js';
import { followIds, recordSettled, settledId } from '@ui/domain/pendingIds.js';
import { CHUNK } from '@/domain/bulk';
import { readVocabulary } from '@/domain/vocabCache';
import { keyedSend } from '@ui/domain/keyedSend.js';

// A past state read with no entry list: one empty list, so the memos over it
// keep their identity.
const NO_ENTRIES = Object.freeze([]);

// The Entries screen's data and its write layer: the entries and their usage
// counts, how they are read, how a write is folded into them and settled, and
// the sends, through `writes`, the vocabulary's entry WriteQueue, which
// outlives this screen. `goItem` and `dispatch` are the screen's, for a
// settled id the URL still names and a draft a refusal re-seeds. `typedRef`
// says whether the open draft holds typing of the user's.
export function useVocabEntries({
  client,
  vocabularyId,
  writes,
  past,
  selectedId,
  goItem,
  dispatch,
  typedRef,
}) {
  const [liveItems, setItems] = useState([]);
  // `past` is the vocabulary as the history rail shows it (`{ time,
  // vocabulary }`): its entries stand in for the live ones, and nothing can be
  // edited, only put back one entry at a time (EntryRestoreDialog). The
  // writes below all work on the live list, which stays loaded underneath.
  const pastTime = past?.time ?? null;
  const pastItems = past ? past.vocabulary?.items || NO_ENTRIES : null;
  const items = pastItems ?? liveItems;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [usageCountsNow, setUsageCounts] = useState(null); // {itemId: n} | null
  // Uses are counted now, which says nothing about a past state.
  const usageCounts = past ? null : usageCountsNow;
  const [usageKinds, setUsageKinds] = useState(null); // {itemId: {word: n, morpheme: n}} | null

  // The projects this user can read, one call per vocabulary, shared by the
  // lookups below, the usage counts and the concordance, which have no project
  // to look in when nothing links the vocabulary.
  const projectsRef = useRef(null);
  const readableProjects = () => {
    if (projectsRef.current?.key !== vocabularyId) {
      const promise = client.projects.list();
      // A failed read is asked again next time rather than remembered.
      promise.catch(() => {
        if (projectsRef.current?.promise === promise) projectsRef.current = null;
      });
      projectsRef.current = { key: vocabularyId, promise };
    }
    return projectsRef.current.promise;
  };
  // Whether a readable project links this vocabulary. The usage queries are
  // refused when none does. A failed read says yes, so the queries still run.
  const vocabLinked = () =>
    readableProjects().then(
      (projects) => projects.some((p) => (p?.vocabs || []).some((v) => v?.id === vocabularyId)),
      () => true,
    );

  // ---- loading ----
  // `quiet`: refresh the list without the full-pane spinner. The spinner
  // replaces the whole two-pane layout, so using it for a refresh AFTER an edit
  // tears down the list and the open editor, losing scroll position and focus
  // for a change the user already sees. Only the first load earns it.
  //
  // A read waits for the entry writes still queued, and reads again when one
  // is made while it is on the wire, so the list never drops an edit the
  // server is still to get. `inTurn` is the refused write's own refetch, which
  // the queue is waiting on. It throws when it fails, so the queue tries it
  // again.
  const fetchItems = async ({ quiet = false, inTurn = false } = {}) => {
    try {
      if (!quiet) setLoading(true);
      if (!client) throw new Error('Not authenticated');
      if (!vocabularyId || vocabularyId === 'undefined' || vocabularyId === 'new') {
        throw new Error('Invalid vocabulary ID');
      }
      // The copy kept since the last read when the vocabulary has not changed
      // (vocabCache.js): a document opened just before read the same entries.
      const read = () => readVocabulary(client, vocabularyId);
      const vocabularyData = await (inTurn ? read() : writes.readWhenIdle(read));
      const fetched = vocabularyData.items || [];
      setItems(fetched);
      setError('');
      fetchUsageCounts(); // not awaited
      return fetched;
    } catch (err) {
      if (inTurn) throw err;
      setError('Failed to load entries');
      console.error('Error fetching vocabulary items:', err);
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  // One grouped aggregate query: links per item AND per token-layer role
  // across every readable project. The role splits each entry's uses into
  // words and morphemes (an entry may be linked from both). The `vocab-link`
  // shorthand counts each word once per entry, even where two links of one
  // entry name the same word (a multi-word link beside a single-word one).
  // Naming the link would count each link instead.
  const fetchUsageCounts = async () => {
    try {
      // A vocabulary no project links has no uses, and the query refuses it.
      if (!(await vocabLinked())) {
        setUsageCounts(null);
        setUsageKinds(null);
        return;
      }
      const res = await client.query({
        where: [
          ['vocab', '?v', { layer: vocabularyId }],
          ['vocab-link', '?t', '?v'],
          ['token', '?t', { layer: '?tl' }],
          ['token-layer', '?tl', {}],
        ],
        return: { group: ['?v', '?tl.config.plaid.role'], aggregates: [['count']] },
      });
      const counts = {};
      const kinds = {};
      for (const [itemId, role, n] of res?.results || []) {
        counts[itemId] = (counts[itemId] || 0) + n;
        if (role === 'word' || role === 'morpheme') {
          (kinds[itemId] ||= {})[role] = ((kinds[itemId] || {})[role] || 0) + n;
        }
      }
      setUsageCounts(counts);
      setUsageKinds(kinds);
    } catch (err) {
      console.error('Usage-count query failed:', err);
      setUsageCounts(null);
      setUsageKinds(null);
      if (!isPermissionError(err)) {
        notifyWarning('Usage counts could not be loaded.', 'Usage counts unavailable');
      }
    }
  };

  // ---- writes ----
  // Write entries' metadata. The plans are whole maps and the write is each
  // one's patch against what that entry carried when the plan was made, so a
  // key nobody here changed (one another tab or a service wrote meanwhile) is
  // left alone. One request is one transaction holding the vocabulary's write
  // lock, hence the chunks. `metaById` is what the entries hold at the time of
  // the call, which is not always the list in state: the load-time repair runs
  // against what it has just fetched. Ids the server has answered for since
  // go out as the server's.
  // `to` is the client, or a batch the repoints ride in.
  const bulkRepoint = async (patches, metaById, to = client) => {
    const updates = metadataUpdates(patches, metaById).map(({ id, metadata }) => ({
      id: settledId(id),
      metadata: followIds(metadata),
    }));
    for (let i = 0; i < updates.length; i += CHUNK) {
      await to.vocabItems.bulkUpdate(updates.slice(i, i + CHUNK));
    }
  };
  const metadataNow = (list) => new Map((list || []).map((it) => [it.id, it.metadata]));
  const foldPatches = (patches) => {
    const byId = new Map(patches.map((p) => [p.id, p.metadata]));
    setItems((prev) =>
      prev.map((it) => {
        if (!byId.has(it.id)) return it;
        const metadata = byId.get(it.id);
        const rest = { ...it };
        delete rest.metadata;
        return Object.keys(metadata).length ? { ...rest, metadata } : rest;
      }),
    );
  };

  // Every write here shows first and is sent in its turn in `writes`, so two
  // quick drags reach the server in the order they were made. An entry made
  // here is in the list under a pending id until the server answers, and
  // `settleEntries` swaps the server's in, in the list, in any reference to
  // it, and in `?item=`. A refused write says so and fetches the list again,
  // which puts back what the screen showed. The writes queued behind it are
  // still sent, and the list is fetched again once they have landed. Resolves
  // to whether the write landed.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const settleEntries = (ids) => {
    const known = new Map([...ids].filter(([, server]) => server));
    if (!known.size) return;
    recordSettled(known);
    setItems((prev) => followIds(prev));
    const open = selectedIdRef.current;
    if (open && known.has(open)) goItem(known.get(open), { replace: true });
  };
  // Closing the tab asks first while a write is still on its way, and keeps
  // asking after this screen is left, since the writes go on without it.
  useSavingGuard(writes);
  // A refusal's refetch re-seeds the open draft from what the server holds, unless
  // something is typed into it: the entry open now need not be the one the
  // refused write was about, and what is typed there is not the server's to
  // take back. `refused` replaces that step for a write with its own way back.
  const unseedUnlessTyped = () => {
    if (!typedRef.current) dispatch({ type: 'draft/unseed' });
  };
  const resync = () => fetchItems({ quiet: true, inTurn: true });
  // A save says nothing when it lands, the way every screen that shows an
  // edit at once does. A refusal is toasted, unless `answered(err)` says the
  // write's own `refused` shows it. `resync` stands in for the entries'
  // refetch, for a save that needs to see what it brought back.
  // A write whose answer was lost goes again until it is answered, under the
  // same operation and Idempotency-Key seed (the client's `keySeed`), so what
  // landed the first time is answered from what it stored and written once.
  const sendInTurn = (
    label,
    write,
    failure,
    { refused, answered, resync: reread = resync, minted } = {},
  ) =>
    keyedSend(writes, client, label, write, {
      minted,
      refused: async (err) => {
        console.error(`${label}:`, err);
        if (!answered?.(err)) notifyError(err, failure);
        await (refused || unseedUnlessTyped)(err);
      },
      resync: reread,
    });

  // Bulk Add and Replace: a run of writes planned against the entries as
  // the server holds them in the run's turn, which comes behind any save
  // still on its way. `plan()` reads and plans once, and every send of the
  // run hands `write(setMessage, planned)` what it planned (keyedSend), so a
  // resend after a lost answer sends what the first send did, after
  // `recheck(planned)` has read again for what someone else changed meanwhile
  // (keyedSend). Resolves `{ landed, error }`. A refusal re-reads the entries
  // here, the dialog reports it. `kind` and `ref` tag the operation (see the
  // client's beginOperation).
  const sendPlanned = async (label, write, { plan, recheck, kind, ref } = {}) => {
    let error = null;
    const landed = await keyedSend(writes, client, label, write, {
      plan,
      recheck,
      kind,
      ref,
      refused: (err) => {
        error = err;
        unseedUnlessTyped();
      },
      resync,
    });
    return { landed, error };
  };

  // Each of these writes the entry's stored metadata, not the draft: the
  // draft is re-seeded from the result unless the user has unsaved edits,
  // which stay theirs.
  const commitPatches = (patches, label, failure) => {
    const before = metadataNow(items);
    foldPatches(patches);
    return sendInTurn(label, () => bulkRepoint(patches, before), failure);
  };
  const commitMetadata = (id, metadata, label, failure) =>
    commitPatches([{ id, metadata }], label, failure);

  useEffect(() => {
    if (vocabularyId && vocabularyId !== 'new') {
      fetchItems();
    } else {
      setLoading(false);
      setItems([]);
    }
    // Runs once per vocabulary; the loader reads the client fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vocabularyId]);

  return {
    items,
    liveItems,
    setItems,
    pastTime,
    loading,
    error,
    usageCounts,
    usageKinds,
    readableProjects,
    vocabLinked,
    fetchItems,
    fetchUsageCounts,
    bulkRepoint,
    metadataNow,
    foldPatches,
    selectedIdRef,
    settleEntries,
    unseedUnlessTyped,
    sendInTurn,
    sendPlanned,
    commitPatches,
    commitMetadata,
  };
}
