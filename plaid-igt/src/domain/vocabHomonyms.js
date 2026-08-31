// Homonym disambiguation for vocab items. When two or more items in the same
// vocabulary share a surface form, we number them FLEx-style (form₁, form₂, …)
// so they can be told apart in the management table, the edit modal, and the
// interlinear view.
//
// Numbering is by creation order, which is the order the server returns items
// in. **Pass items in that order** and this numbers them by position: first
// created = ₁. Adding a new homonym appends, so it takes the next number and
// never renumbers the others.
//
// It used to sort each group by id, on the belief that UUIDv7 ids sort into
// creation order. They only do so across MILLISECONDS. A bulk import writes
// thousands of items inside one millisecond where the rest of the id is random,
// so that sort handed out arbitrary subscripts (and a native round-trip, which
// regenerates ids, could swap them). Do not reintroduce an id sort here.

/**
 * @param {{id: string, form: string}[]} items IN CREATION ORDER (as the server
 *   returns them). A caller that sorts for display must still pass the
 *   unsorted array here, or the subscripts follow the display instead.
 * @returns {Map<string, number|null>} item id → 1-based homonym rank, or null
 *   when the item's form is unique within the set.
 */
export const buildHomonymIndex = (items) => {
  const byForm = new Map();
  for (const it of items || []) {
    const form = it?.form ?? '';
    if (!byForm.has(form)) byForm.set(form, []);
    byForm.get(form).push(it);
  }
  const index = new Map();
  for (const group of byForm.values()) {
    if (group.length < 2) {
      if (group.length === 1) index.set(group[0].id, null);
      continue;
    }
    // Already in creation order: `group` was filled by walking `items`.
    group.forEach((it, i) => index.set(it.id, i + 1));
  }
  return index;
};
