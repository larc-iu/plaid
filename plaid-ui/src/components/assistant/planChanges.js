// A plan's changes as the card shows them: grouped by where they land, each
// row linking to the place in the editor.
//
// The service locates every change; what `where` looks like, and how it turns
// into a link, a short reference and a heading, is the app's answer
// (`adapter.changeHref` / `changeRef` / `changeTitle` / `groupOf`). A plan
// from before this existed, or a change the service could not locate, falls
// back to its label whole.

export const ROWS_COLLAPSED = 12;

// The changes to show, in plan order: the service's located changes when
// they line up with the ops, else the labels alone.
export const planRows = (plan) => {
  const ops = plan?.ops || [];
  const changes = plan?.changes || [];
  if (changes.length && changes.length === ops.length) {
    return changes.map((c, i) => ({
      index: i,
      where: c.where || null,
      change: c.change || null,
      label: c.label || '',
    }));
  }
  return (plan?.labels || []).map((label, i) => ({ index: i, where: null, change: null, label }));
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
  let left = limit;
  const out = [];
  for (const g of groups) {
    if (left <= 0) break;
    const rows = g.rows.slice(0, left);
    left -= rows.length;
    out.push({ ...g, rows });
  }
  return { groups: out, hidden: total - limit };
};
