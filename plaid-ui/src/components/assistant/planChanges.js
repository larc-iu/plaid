// A plan's changes as the card shows them: grouped by where they land, each
// row linking to the place in the editor.
//
// The service locates every change; what `where` looks like, and how it turns
// into a heading and a named place is the app's answer (`adapter.groupOf` and
// `adapter.changePlace`, listed in adapterContract.js). A change the service
// could not locate falls back to its label whole.

export const ROWS_COLLAPSED = 12;

/** How many of these changes rewrite the text itself. */
export const textRewrites = (rows) => (rows || []).filter((r) => r.writesText).length;

/**
 * How many of these changes replace work a person made or accepted. A row
 * counts as many as it stands for: one corpus-wide replace is one row and
 * may replace dozens of a person's values.
 */
export const workReplaced = (rows) =>
  (rows || []).reduce((n, r) => n + (Number(r.replacesWork) || 0), 0);

// A row the collapsed card never folds away: a rewrite of the text, or a
// change to a person's work, is not something to approve unread.
const alwaysShown = (r) => r.writesText || r.replacesWork;

// The changes to show, in plan order: the service's located changes when
// they line up with the ops, else the labels alone.
export const planRows = (plan) => {
  // A settled plan keeps its changes and the count of its ops, not the ops
  // themselves (`compactPlan` in jobs.js).
  const opCount = plan?.opCount ?? (plan?.ops || []).length;
  const changes = plan?.changes || [];
  if (changes.length && changes.length === opCount) {
    return changes.map((c, i) => ({
      index: i,
      where: c.where || null,
      change: c.change || null,
      label: c.label || '',
      // A change to the text itself rather than to an annotation of it. The
      // service decides which ops those are; a plan recorded before it did
      // says nothing, and those are all long since settled.
      writesText: !!c.writesText,
      // How many things a person made or accepted the change replaces, which
      // the service decides from their provenance: 1 for a change of one
      // thing, the count for a corpus-wide replace, 0 for none. Such a change
      // is never folded into a group, service side or here.
      replacesWork: Number(c.replacesWork) || 0,
    }));
  }
  return (plan?.labels || []).map((label, i) => ({
    index: i,
    where: null,
    change: null,
    label,
    writesText: false,
    replacesWork: 0,
  }));
};

// Rows grouped by the place they change, groups in order of first appearance,
// rows in plan order within each.
export const groupRows = (rows, projectId, adapter) => {
  const groups = [];
  const byKey = new Map();
  for (const row of rows) {
    const { key, title, href } = adapter.groupOf(projectId, row.where);
    let g = byKey.get(key);
    if (!g) {
      g = { key, title, href, rows: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(row);
  }
  return groups;
};

// The groups with only the first `limit` rows kept (headers do not count),
// for a collapsed card; the whole list when it fits.
export const collapseGroups = (groups, limit = ROWS_COLLAPSED) => {
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  if (total <= limit) return { groups, hidden: 0 };
  // A change to the text itself is never one of the ones folded away. Sitting
  // as row 40 of a plan headed "1 text edit, 1 field value" is how a rewrite
  // of someone's own transcription gets approved unread. The same goes for a
  // change to a person's work.
  const keep = new Set();
  for (const g of groups) for (const r of g.rows) if (alwaysShown(r)) keep.add(r);
  let left = Math.max(0, limit - keep.size);
  const out = [];
  for (const g of groups) {
    const rows = g.rows.filter((r) => {
      if (keep.has(r)) return true;
      if (left <= 0) return false;
      left -= 1;
      return true;
    });
    if (rows.length) out.push({ ...g, rows });
  }
  const shown = out.reduce((n, g) => n + g.rows.length, 0);
  return { groups: out, hidden: total - shown };
};
