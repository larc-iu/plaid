// Homonym disambiguation for vocab items. When two or more items in the same
// vocabulary share a surface form, we number them FLEx-style (form₁, form₂, …)
// so they can be told apart in the management table, the edit modal, and the
// interlinear view.
//
// Numbering is by creation order: items carry UUIDv7 ids whose lexical order is
// their creation order, so sorting by id ascending gives oldest = ₁. This keeps
// existing numbers stable as new homonyms are added (a new dup just takes the
// next number; it never renumbers the others).

/**
 * @param {{id: string, form: string}[]} items
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
    group.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    group.forEach((it, i) => index.set(it.id, i + 1));
  }
  return index;
};
