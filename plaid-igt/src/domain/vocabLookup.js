// A vocab link names its entry by id, layer, and form; the entry's metadata
// lives with the vocabulary's items, which the editor loads alongside the
// document. Resolve the entry a link points at through those items, and
// fall back to what the link carries when the items are not loaded (the
// search and concordance runners work without them).

export const itemsById = (vocab) => new Map((vocab?.items || []).map((it) => [it.id, it]));

export function linkedItem(byId, link) {
  const ref = link?.vocabItem;
  if (!ref) return null;
  const item = byId.get(ref.id);
  return { id: ref.id, form: item?.form ?? ref.form ?? '', metadata: item?.metadata || {} };
}
