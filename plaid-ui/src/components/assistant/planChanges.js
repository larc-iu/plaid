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
// change to a person's work, is not something to approve unread, and a rule
// is one row standing for many changes.
const alwaysShown = (r) => r.writesText || r.replacesWork || r.rule;

// How many documents a rule's row lists before "and n more documents".
export const RULE_DOCUMENTS_SHOWN = 10;

const count = (n, one, many) => `${Number(n).toLocaleString('en-US')} ${n === 1 ? one : many}`;

// A rule's documents (`rule.documents`, `[id, name, changes]` largest first)
// and how many more the record counts without naming.
export const ruleDocuments = (rule) => {
  const named = (rule?.documents || []).map(([id, name, n]) => ({
    id,
    name,
    count: Number(n) || 0,
  }));
  const [moreDocs, moreChanges] = rule?.documentsMore || [0, 0];
  return { named, moreDocs: Number(moreDocs) || 0, moreChanges: Number(moreChanges) || 0 };
};

// The values of a rule that later rules of the plan change again
// (`rule.changedAgain`, `[later rule in words, values]`): "Gloss "ASP" →
// "ASPX"", or each later rule with its count when there are several.
const changedAgainBy = (rule) => {
  const later = (rule?.changedAgain || []).filter(([, n]) => Number(n) > 0);
  const n = later.reduce((s, [, k]) => s + Number(k), 0);
  if (!n) return null;
  const by =
    later.length === 1
      ? later[0][0]
      : later.map(([words, k]) => `${words} (${count(Number(k), 'value', 'values')})`).join(', ');
  return { n, by };
};

// "1,240 changes in 12 documents", and how many replace accepted work. A
// rule whose values a later rule changes again says so, so that "0 changes"
// never stands without its reason.
export const ruleCountLine = (rule, replacesWork = 0) => {
  const { named, moreDocs } = ruleDocuments(rule);
  const docs = named.length + moreDocs;
  const total = Number(rule?.total) || 0;
  const again = changedAgainBy(rule);
  if (total === 0 && again) {
    return `0 changes: its ${count(again.n, 'value is', 'values are')} changed again by ${again.by}`;
  }
  let line = `${count(total, 'change', 'changes')} in ${count(docs, 'document', 'documents')}`;
  if (replacesWork > 0)
    line = `${line}, ${count(replacesWork, 'replaces', 'replace')} accepted work`;
  return again
    ? `${line}, and ${count(again.n, 'value', 'values')} changed again by ${again.by}`
    : line;
};

// "and 3 more documents (31 changes)".
export const ruleMoreLine = (docs, changes) =>
  `and ${count(docs, 'more document', 'more documents')} (${count(changes, 'change', 'changes')})`;

// How many rows a settled plan's record no longer holds (planRecord.js).
export const rowsOmitted = (plan) => Number(plan?.omitted?.count) || 0;

// The line that ends such a plan's list of changes, on the card and in the
// exports.
export const omittedLine = (n) =>
  n === 1 ? 'and 1 more change' : `and ${n.toLocaleString('en-US')} more changes`;

// The changes to show, in plan order: the service's located changes when
// they line up with the ops, else the labels alone.
export const planRows = (plan) => {
  // A settled plan keeps its changes and the count of its ops, not the ops
  // themselves, and of a long one only the first rows (`compactPlan` in
  // planRecord.js), the rest counted in `omitted`.
  const opCount = plan?.opCount ?? (plan?.ops || []).length;
  const changes = plan?.changes || [];
  if (changes.length && changes.length === opCount - rowsOmitted(plan)) {
    return changes.map((c, i) => ({
      // A rule's row kept past a settled plan's row cap says where it was.
      index: c.row ?? i,
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
      // One stored change standing for many (core/rules.py in plaid-agent):
      // its tool and arguments, total, count per document and a sample.
      rule: c.rule || null,
    }));
  }
  // A plan made since rules has no `labels`: each change carries its own.
  return (plan?.labels || changes.map((c) => c?.label || '')).map((label, i) => ({
    index: i,
    where: null,
    change: null,
    label,
    writesText: false,
    replacesWork: 0,
    rule: null,
  }));
};

// Rows grouped by the place they change, groups in order of first appearance,
// rows in plan order within each.
export const groupRows = (rows, projectId, adapter) => {
  const groups = [];
  const byKey = new Map();
  for (const row of rows) {
    // A rule names its own documents: it is a group of its own.
    if (row.rule) {
      groups.push({ key: `rule:${row.index}`, title: null, href: null, rule: true, rows: [row] });
      continue;
    }
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
