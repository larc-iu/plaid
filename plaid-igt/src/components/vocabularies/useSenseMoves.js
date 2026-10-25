import { pendingId, followIds } from '@ui/domain/pendingIds.js';
import {
  planSenseDrop,
  splitEntryLevel,
  nextSenseOrder,
  planHomographOrder,
  withParentSet,
} from '@/domain/vocabDictionary';

// Placing entries in the sense tree: a sense moved under another entry or
// out, a new headword raised over an entry, a drop in the tree, and the order
// of the entries spelled alike. Each writes the entries' stored metadata
// through useVocabEntries (`entries`), never the draft. `dirty` and `confirm`
// are the screen's, for unsaved typing a new headword would reload over.
export function useSenseMoves({
  entries,
  client,
  vocabularyId,
  fields,
  tree,
  homographs,
  selectedId,
  dirty,
  confirm,
  dispatch,
}) {
  const {
    setItems,
    foldPatches,
    bulkRepoint,
    settleEntries,
    sendInTurn,
    commitPatches,
    commitMetadata,
  } = entries;

  // Make `id` a sense of `parentId` (last), or, with null, its own entry.
  const handleMoveUnder = async (id, parentId) => {
    const moving = tree.byId.get(id);
    if (!moving) return;
    commitMetadata(
      id,
      withParentSet(tree, moving, parentId),
      parentId
        ? `Make "${moving.form}" a sense of "${tree.byId.get(parentId)?.form ?? ''}"`
        : `Make "${moving.form}" its own entry`,
      'Failed to move the entry',
    );
  };
  // A new headword over `id`, with the same form, taking its place: the
  // entry becomes that headword's first sense. How one meaning becomes two.
  const handleRaiseHeadword = async (id) => {
    const it = tree.byId.get(id);
    if (!it) return;
    // The split moves fields the form edits up to the new headword, so the
    // draft is re-seeded from what comes back. Unsaved typing goes with it.
    if (dirty && id === selectedId) {
      const ok = await confirm({
        title: 'Discard unsaved changes?',
        description: 'Adding a headword reloads this entry.',
        confirmLabel: 'Discard changes',
        destructive: true,
      });
      if (!ok) return;
    }
    const above = tree.parentOf.get(id);
    const place = above
      ? { parent: above, senseOrder: it.metadata?.senseOrder ?? nextSenseOrder(tree, above) }
      : {};
    // What belongs to the ENTRY goes up with the new headword: its place
    // among the entries spelled alike, the FLEx entry it came from, and every
    // headword-only field. Left below, they would sit on a sense, where the
    // form does not even show them. The morph type and lexeme form go to
    // both: the interlinear line reads the morph type off the item a token is
    // linked to, which stays the sense.
    const { entry, sense } = splitEntryLevel(it.metadata, fields);
    const headMeta = { ...entry, ...place };
    const headId = pendingId();
    const senseMeta = { ...sense, parent: headId, senseOrder: 1 };
    setItems((prev) => [
      ...prev,
      {
        id: headId,
        layer: vocabularyId,
        form: it.form,
        ...(Object.keys(headMeta).length ? { metadata: headMeta } : {}),
      },
    ]);
    foldPatches([{ id, metadata: senseMeta }]);
    // The split moved the headword-only fields off this item, so the open
    // draft is re-seeded from it. Left alone it reads dirty without an edit,
    // and a Save would put those fields back on the sense.
    dispatch({ type: 'draft/unseed' });
    sendInTurn(
      `Add a headword over "${it.form}"`,
      async () => {
        const meta = followIds(headMeta);
        // One batch, so a refused repoint leaves no headword without its
        // sense. The headword is made under the id minted here.
        await client.batched(async (b) => {
          b.vocabItems.create(
            vocabularyId,
            it.form,
            Object.keys(meta).length ? meta : undefined,
            undefined,
            { id: headId },
          );
          await bulkRepoint([{ id, metadata: senseMeta }], new Map([[id, it.metadata]]), b);
        });
        settleEntries(new Map([[headId, headId]]));
      },
      'Failed to add the headword',
      { minted: [headId] },
    );
  };
  // A drop in the sense tree: before or after a sense, into one, or out.
  const handleSenseDrop = async (id, target) => {
    const patches = planSenseDrop(tree, id, target);
    if (!patches.length) return;
    const moving = tree.byId.get(id);
    commitPatches(patches, `Move "${moving?.form ?? ''}"`, 'Failed to move the sense');
  };
  // The entries spelled like the open one, reordered by dragging in the
  // homograph dialog: their numbers are written 1..n under one operation.
  const handleHomographOrder = async (orderedIds) => {
    const patches = planHomographOrder(homographs, orderedIds);
    if (!patches.length) return;
    commitPatches(
      patches,
      `Reorder the entries spelled "${homographs[0]?.form ?? ''}"`,
      'Failed to reorder the entries',
    );
  };

  return { handleMoveUnder, handleRaiseHeadword, handleSenseDrop, handleHomographOrder };
}
