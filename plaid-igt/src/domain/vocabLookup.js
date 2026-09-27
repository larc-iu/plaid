// A vocab link names its entry by id, layer, and form; the entry's metadata
// lives with the vocabulary's items, which the editor loads alongside the
// document. Resolve the entry a link points at through those items, and
// fall back to what the link carries when the items are not loaded (the
// search and concordance runners work without them).
//
// A run over many documents (a Bulk Edit preview, an export) hands every
// document the same entry lists. Each document used to build its own index
// over them, which on a lexicon of 20,000 entries is most of the time spent
// per document. Such a run freezes the lists (`shareVocabularies`), and an
// index over a frozen list is built once and shared. A list that is not
// frozen, the editor's, is indexed afresh on every call, as before: the
// editor replaces its lists on every change instead of editing them, but
// nothing enforces that, and a frozen list cannot be edited in place.

import { lexiconView } from './vocabDictionary.js';

const shared = new WeakMap();

// `build(items)` once per frozen list and `name`, else on every call.
function sharedFor(items, name, build) {
  if (!Object.isFrozen(items) || items.length === 0) return build(items);
  let views = shared.get(items);
  if (!views) shared.set(items, (views = new Map()));
  if (!views.has(name)) views.set(name, build(items));
  return views.get(name);
}

/**
 * Freeze each vocabulary's entry list in `vocabularies` (a map or an array of
 * vocabularies), so that every document of the run shares one index over it.
 * Returns `vocabularies`.
 */
export function shareVocabularies(vocabularies) {
  for (const vocab of Object.values(vocabularies || {})) {
    if (Array.isArray(vocab?.items)) Object.freeze(vocab.items);
  }
  return vocabularies;
}

export const itemsById = (vocab) =>
  sharedFor(vocab?.items || [], 'byId', (items) => new Map(items.map((it) => [it.id, it])));

/** `lexiconView(items)`, built once for a shared list. */
export const lexiconViewOf = (items) => sharedFor(items || [], 'view', lexiconView);

/** item id -> the morph type it goes by (`lexiconView`'s `morphTypeOf`). */
export const entryMorphTypesOf = (items) =>
  sharedFor(items || [], 'morphTypes', (list) => {
    const view = lexiconViewOf(list);
    return new Map(list.map((it) => [it.id, view.morphTypeOf(it.id)]));
  });

export function linkedItem(byId, link) {
  const ref = link?.vocabItem;
  if (!ref) return null;
  const item = byId.get(ref.id);
  return { id: ref.id, form: item?.form ?? ref.form ?? '', metadata: item?.metadata || {} };
}
