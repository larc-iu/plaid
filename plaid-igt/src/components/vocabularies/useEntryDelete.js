import { useState, useEffect, useMemo, useRef } from 'react';
import { notifyError } from '@/utils/feedback';
import { statusOf } from '@ui/lib/errors.js';
import { planDeleteRefs } from '@/domain/vocabDictionary';
import { dropPrecedent } from '@/domain/precedentCache';
import { settledId } from '@ui/domain/pendingIds.js';
import { countOf } from '@ui/lib/plural.js';

// Deleting the open entry: what it would touch, the link count the delete
// names and the server checks, and a refusal for that count, which opens the
// question again on the server's number. `entries` is useVocabEntries'.
export function useEntryDelete({
  entries,
  client,
  vocabularyId,
  fields,
  tree,
  selectedItem,
  dialog,
  dispatch,
  goItem,
}) {
  const {
    items,
    setItems,
    vocabLinked,
    fetchUsageCounts,
    bulkRepoint,
    metadataNow,
    foldPatches,
    selectedIdRef,
    unseedUnlessTyped,
    sendInTurn,
  } = entries;

  // What deleting the open entry would touch besides itself: the senses under
  // it (which become entries) and the fields that name it (cleared), all in
  // the same operation as the delete.
  const deleteRefPatches = useMemo(
    () => (selectedItem ? planDeleteRefs(items, fields, [selectedItem.id]) : []),
    [items, fields, selectedItem],
  );
  // Only say the senses are freed when there are some: the count above covers
  // both them and the fields that name the entry.
  const deleteFreesSenses = !!tree.childrenOf.get(selectedItem?.id)?.length;

  // Deleting an entry deletes its links, so the delete names how many it
  // saw, and the server refuses it when that is no longer the number.
  // `deleteCountRef` is the count read when the dialog opened, compared at
  // Delete with a count read then: a link made meanwhile keeps the dialog
  // open on the new count. Null when it cannot be told (the count failed),
  // and then the delete goes unchecked, as before there was a count.
  // A refused delete leaves the number the server gave in `refusedDeleteRef`
  // for that entry, with the count read here just after the refusal: links
  // in projects this person cannot open are counted there and not here, so
  // the next Delete of it, while the count here is still that one, names the
  // server's. The refusal opens the question again on the server's count
  // (`deleteHidden`: the total, and how many of those this person cannot
  // see), unless another entry or dialog is open by then.
  const deleteCountRef = useRef(null);
  const refusedDeleteRef = useRef(new Map());
  const [deleteLinksChanged, setDeleteLinksChanged] = useState(false);
  const [deleteHidden, setDeleteHidden] = useState(null); // { id, total, hidden } | null
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  // Whether these entries are still on screen: a refusal can come back after
  // this person has gone to another page or another vocabulary, and the
  // queue outlives this screen.
  const shownRef = useRef({ mounted: true, vocabularyId });
  shownRef.current.vocabularyId = vocabularyId;
  useEffect(() => {
    const shown = shownRef.current;
    shown.mounted = true;
    return () => {
      shown.mounted = false;
    };
  }, []);
  const countLinks = async (id) => {
    try {
      if (!(await vocabLinked())) return 0;
      const res = await client.query({
        where: [['link', '?l', { item: settledId(id) }]],
        return: { group: [], aggregates: [['count']] },
      });
      return res?.results?.[0]?.[0] ?? 0;
    } catch (err) {
      console.error('Link count failed:', err);
      return null;
    }
  };
  const openDelete = () => {
    const id = selectedItem?.id;
    deleteCountRef.current = null;
    setDeleteLinksChanged(false);
    if (deleteHidden?.id !== id) setDeleteHidden(null);
    dispatch({ type: 'dialog/open', kind: 'delete' });
    if (!id) return;
    const counting = countLinks(id).then((n) => ({ id, n }));
    deleteCountRef.current = counting;
  };

  const confirmDelete = async (e) => {
    e?.preventDefault?.();
    if (!selectedItem) return;
    const deletedId = selectedItem.id;
    const opened = await deleteCountRef.current;
    const seen = await countLinks(deletedId);
    if (opened?.id === deletedId && opened.n != null && seen != null && seen !== opened.n) {
      deleteCountRef.current = Promise.resolve({ id: deletedId, n: seen });
      setDeleteLinksChanged(true);
      fetchUsageCounts();
      return;
    }
    const refused = refusedDeleteRef.current.get(deletedId);
    const expectedLinkCount =
      seen == null ? undefined : refused && refused.seen === seen ? refused.server : seen;
    // A headword with many senses, or a root with many variants, is one
    // repoint per referring entry: the same walk the load-time repair does,
    // so the same bulk write.
    const patches = deleteRefPatches;
    const before = metadataNow(items);
    const deletedItem = selectedItem;
    const deletedFrom = vocabularyId;
    // The count the server found, when it refused the delete for its count.
    let serverCount = null;
    dispatch({ type: 'dialog/close' });
    goItem(null, { replace: true });
    if (patches.length) foldPatches(patches);
    setItems((prev) => prev.filter((i) => i.id !== deletedId));
    sendInTurn(
      `Delete entry "${selectedItem.form}"`,
      async () => {
        try {
          // The repoints and the delete are one batch, so a delete refused
          // for its count leaves the senses and references where they were.
          await client.batched(async (b) => {
            if (patches.length) await bulkRepoint(patches, before, b);
            await b.vocabItems.delete(settledId(deletedId), undefined, { expectedLinkCount });
          });
          refusedDeleteRef.current.delete(deletedId);
        } catch (err) {
          if (statusOf(err) === 409 && expectedLinkCount != null) {
            // The refusal's body carries the count the server found.
            const server = err?.responseData?.links;
            if (Number.isInteger(server)) serverCount = server;
          }
          throw err;
        } finally {
          // Its links go with it, in documents no editor has open.
          dropPrecedent();
        }
      },
      'Failed to delete the entry',
      {
        answered: () => serverCount != null,
        refused: async () => {
          unseedUnlessTyped();
          if (serverCount == null) return;
          const now = await countLinks(deletedId);
          const visible = now ?? expectedLinkCount;
          refusedDeleteRef.current.set(deletedId, { seen: visible, server: serverCount });
          const hidden = Math.max(0, serverCount - visible);
          const linked = `It is linked to ${countOf(serverCount, 'word/morpheme', 'words/morphemes')}${
            hidden ? `, ${hidden} of them in projects you cannot open` : ''
          }.`;
          // Someone moved on meanwhile (another entry or dialog open, or
          // this screen left): the count is said, not asked again. A refusal can come back before
          // the delete's own close and navigation have rendered.
          const openId = selectedIdRef.current && settledId(selectedIdRef.current);
          const movedOn =
            !shownRef.current.mounted ||
            shownRef.current.vocabularyId !== deletedFrom ||
            (openId && openId !== deletedId) ||
            (dialogRef.current && dialogRef.current.kind !== 'delete');
          if (movedOn) {
            notifyError(linked, 'Entry not deleted');
            return;
          }
          setItems((prev) =>
            prev.some((i) => i.id === deletedId) ? prev : [...prev, deletedItem],
          );
          deleteCountRef.current = Promise.resolve({ id: deletedId, n: now });
          setDeleteLinksChanged(visible !== expectedLinkCount);
          setDeleteHidden({ id: deletedId, total: serverCount, hidden });
          goItem(deletedId, { replace: true });
          dispatch({ type: 'dialog/open', kind: 'delete' });
        },
      },
    );
  };

  return {
    deleteRefPatches,
    deleteFreesSenses,
    deleteLinksChanged,
    deleteHidden,
    openDelete,
    confirmDelete,
  };
}
