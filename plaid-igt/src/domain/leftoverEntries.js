// Entries that "+ Create" made and then failed to link.
//
// Creating and linking is two writes: the entry is made first, so the link
// can name it. When the link is refused (a 409 after a colleague's edit, the
// network), a maintainer's new entry is deleted again, but a project writer
// who does not maintain the vocabulary may not delete it, and a delete can
// fail as the link did. Pressing "+ Create" again for the same form would
// then make a second entry spelled the same, kai₁ beside kai₂. So the entry
// is remembered here, under its vocabulary, form and metadata, and the retry
// links the words to it instead of making another.
//
// An entry is forgotten once a link to it lands, whether through the retry or
// through picking it from the popover's list: from then on it is an entry in
// use, and a later "+ Create" of the same form is a new entry on purpose.
// One that is not in the vocabulary as loaded, or no longer reads the same (a
// maintainer deleted or renamed it), is passed over, and the retry makes a
// new one.
//
// Kept in memory for the page, shared by every document, like the vocabulary
// copies in vocabCache.js.

const leftovers = new Map(); // key -> entry id

const keyOf = (vocabId, form, metadata) =>
  JSON.stringify([
    vocabId,
    form,
    Object.entries(metadata || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);

export function rememberLeftover(vocabId, form, metadata, itemId) {
  if (itemId) leftovers.set(keyOf(vocabId, form, metadata), itemId);
}

// The entry a failed "+ Create" of this form left in `vocabId`, as the
// document's vocabularies hold it, or null.
export function leftoverFor(vocabularies, vocabId, form, metadata) {
  const id = leftovers.get(keyOf(vocabId, form, metadata));
  if (!id) return null;
  const item = (vocabularies?.[vocabId]?.items || []).find((i) => i.id === id);
  return item && item.form === form ? item : null;
}

// A link to `itemId` has landed: it is no longer an entry nothing uses.
export function forgetLeftover(itemId) {
  for (const [key, id] of leftovers) if (id === itemId) leftovers.delete(key);
}

export function forgetAllLeftovers() {
  leftovers.clear();
}
