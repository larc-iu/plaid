// A plan's changes as the card shows them: grouped by where they land, each
// row linking to the place in the editor.
//
// The service locates every change; what `where` looks like, and how it turns
// into a heading and a named place is the app's answer (`adapter.groupOf` and
// `adapter.changePlace`, listed in adapterContract.js). A change the service
// could not locate falls back to its label whole.

import { t } from '../../lib/i18n.js';

export const ROWS_COLLAPSED = 12;

/**
 * How many of these changes rewrite the text itself. A row counts as many as
 * it stands for: one corpus-wide respell is one row and may rewrite dozens of
 * words.
 */
export const textRewrites = (rows) =>
  (rows || []).reduce((n, r) => n + (Number(r.writesText) || 0), 0);

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

// A count in the service's own unit words (`rule.unit`), which come as they
// are.
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
      : later
          .map(([words, k]) =>
            t('{words} ({n, plural, one {# value} other {# values}})', { words, n: Number(k) }),
          )
          .join(', ');
  return { n, by };
};

// "1,240 changes in 12 documents", and how many replace accepted work. A
// rule whose values a later rule changes again says so, so that "0 changes"
// never stands without its reason. The row's own `count`, when it has one, is
// the number, the one the staged line adds up (REV-RL1-R2-3).
export const ruleCountLine = (rule, replacesWork = 0, rowCount = null) => {
  const { named, moreDocs } = ruleDocuments(rule);
  const docs = named.length + moreDocs;
  const total = Number.isInteger(rowCount) ? rowCount : Number(rule?.total) || 0;
  const again = changedAgainBy(rule);
  if (total === 0 && again) {
    return t(
      '0 changes: its {n, plural, one {# value is} other {# values are}} changed again by {by}',
      { n: again.n, by: again.by },
    );
  }
  const values = { total, docs, work: replacesWork, again: again?.n, by: again?.by };
  if (replacesWork > 0 && again)
    return t(
      '{total, plural, one {# change} other {# changes}} in {docs, plural, one {# document} other {# documents}}, {work, plural, one {# replaces} other {# replace}} accepted work, and {again, plural, one {# value} other {# values}} changed again by {by}',
      values,
    );
  if (replacesWork > 0)
    return t(
      '{total, plural, one {# change} other {# changes}} in {docs, plural, one {# document} other {# documents}}, {work, plural, one {# replaces} other {# replace}} accepted work',
      values,
    );
  if (again)
    return t(
      '{total, plural, one {# change} other {# changes}} in {docs, plural, one {# document} other {# documents}}, and {again, plural, one {# value} other {# values}} changed again by {by}',
      values,
    );
  return t(
    '{total, plural, one {# change} other {# changes}} in {docs, plural, one {# document} other {# documents}}',
    values,
  );
};

// Every distinct change a rule makes (`rule.transitions`, `{from, to, count,
// notes}`, the surprising ones first, see core/rules.py in plaid-agent), and
// the line counting the rest in the rule's own unit (`rule.unit`, `[one,
// many]`: morpheme forms, values, dependencies). Listed when there is more
// than one or one is noted: a rule over one value says it in its own line.
export const ruleTransitions = (rule) => {
  const [one, many] = rule?.unit || ['value', 'values'];
  const rows = (rule?.transitions || []).map((tr) => ({
    from: tr.from ?? '',
    to: tr.to ?? '',
    count: Number(tr.count) || 0,
    notes: Array.isArray(tr.notes) ? tr.notes : [],
  }));
  const [moreKinds, moreValues] = rule?.transitionsMore || [0, 0];
  const shown = rows.length > 1 || rows.some((r) => r.notes.length) || Number(moreKinds) > 0;
  return {
    rows: shown ? rows : [],
    more:
      shown && Number(moreKinds) > 0
        ? t(
            'and {n, plural, one {# more distinct change} other {# more distinct changes}} ({values})',
            { n: Number(moreKinds), values: count(Number(moreValues), one, many) },
          )
        : null,
  };
};

// One of them as text: "PROSP:EXP" → "PROSPP:EXP" 145 (inside a word).
export const transitionLine = (tr) =>
  `"${tr.from}" → "${tr.to}" ${tr.count.toLocaleString('en-US')}${tr.notes.length ? ` (${tr.notes.join(', ')})` : ''}`;

// "and 3 more documents (31 changes)".
export const ruleMoreLine = (docs, changes) =>
  t(
    'and {docs, plural, one {# more document} other {# more documents}} ({changes, plural, one {# change} other {# changes}})',
    { docs, changes },
  );

// How a plan that wrote was approved, as the record keeps it (the service's
// `recorded_as`): the button pressed, or the human-made box, which wins. The
// card's settled line and the exports.
// A key, not words: each place that says it has a message of its own.
export const approvedAs = ({ asHuman, asUnverified, contributed } = {}) =>
  asHuman ? 'human' : asUnverified ? 'unverified' : contributed ? 'contribution' : 'verified';

export const approvedLine = (recorded) => {
  const how = approvedAs(recorded);
  return how === 'human'
    ? t('Recorded as human-made.')
    : t(
        'Approved as {how, select, unverified {unverified} contribution {a contribution} other {verified}}.',
        { how },
      );
};

// Why an out-of-date plan was refused, as the service said it, on the card and
// in the exports.
export const staleLine = (reason) =>
  t('{reason} Nothing was written.', { reason: /[.!?]$/.test(reason) ? reason : `${reason}.` });

// The line above a reply's card: how many changes the turn staged. Built only
// from the plan the record holds, never from the reply's words, which have
// said 1,807 changes for a card of 801 (survey 2026-11-17). `proposedCount` is
// the service's count (`proposed_changes` in plaid-agent's
// core/conversation.py): each change a folded row or a rule stands for, none
// for a kept value, the count of the model's own plan line. The card's
// numbers of changes add up each row's `count`, which the service writes from
// the same rule (`row_changes`), so they sum to this line. It is what the turn
// staged and stays so whatever became of the plan: the card says that. A plan
// whose record holds no count, or that stages none, gets no line.
export const stagedLine = (plan) => {
  const n = plan?.proposedCount;
  return Number.isInteger(n) && n > 0
    ? t('Staged: {n, plural, one {# change} other {# changes}}', { n })
    : null;
};

// How many rows a settled plan's record no longer holds (planRecord.js).
export const rowsOmitted = (plan) => Number(plan?.omitted?.count) || 0;

// How many changes those rows stood for (`omitted.changes`), or null for a
// plan stored before its rows carried a count: the card then names no number.
export const changesOmitted = (plan) => {
  if (rowsOmitted(plan) === 0) return 0;
  const n = plan?.omitted?.changes;
  return Number.isInteger(n) ? n : null;
};

// The line that ends such a plan's list of changes, on the card and in the
// exports.
export const omittedLine = (n) =>
  n == null
    ? t('and more changes')
    : t('and {n, plural, one {# more change} other {# more changes}}', { n });

// The changes to show, in plan order: the service's located changes when
// they line up with the ops, else their labels alone.
export const planRows = (plan) => {
  // A settled plan keeps its changes and the count of its ops, not the ops
  // themselves, and of a long one only the first rows (`compact_plan` in
  // plaid-agent's core/conversation.py), the rest counted in `omitted`.
  const opCount = plan?.opCount ?? (plan?.ops || []).length;
  const changes = plan?.changes || [];
  if (changes.length && changes.length === opCount - rowsOmitted(plan)) {
    return changes.map((c, i) => ({
      // A rule's row kept past a settled plan's row cap says where it was.
      index: c.row ?? i,
      where: c.where || null,
      change: c.change || null,
      label: c.label || '',
      // How many changes to the text itself rather than to an annotation of
      // it the row stands for: 1 for one change, the count for a corpus-wide
      // respell, 0 for none. The service decides which ops those are.
      writesText: Number(c.writesText) || 0,
      // How many things a person made or accepted the change replaces, which
      // the service decides from their provenance: 1 for a change of one
      // thing, the count for a corpus-wide replace, 0 for none. Such a change
      // is never folded into a group, service side or here.
      replacesWork: Number(c.replacesWork) || 0,
      // One stored change standing for many (core/rules.py in plaid-agent):
      // its tool and arguments, total, count per document and a sample.
      rule: c.rule || null,
      // A value the plan keeps out of a corpus-wide change: listed, and
      // written nothing, so no count of changes counts it.
      kept: !!c.kept,
      // A corpus-wide change the plan's keeps and named changes left with
      // nothing to write: listed, and counted as no change.
      writesNothing: !!c.writesNothing,
      // How many changes the row stands for, as the service counts them
      // (`row_changes`): a folded row its members, a rule its values, a kept
      // value none. Null on a plan stored before rows carried it.
      count: Number.isInteger(c.count) ? c.count : null,
    }));
  }
  return changes.map((c, i) => ({
    index: i,
    where: null,
    change: null,
    label: c?.label || '',
    writesText: 0,
    replacesWork: 0,
    rule: null,
    kept: false,
    writesNothing: false,
    count: null,
  }));
};

/**
 * How many changes these rows stand for, each as many as its `count`: the
 * unit of the staged line. Null when a row does not say, and then the card
 * names no number.
 */
export const changeCount = (rows) =>
  (rows || []).some((r) => r.count == null) ? null : (rows || []).reduce((n, r) => n + r.count, 0);

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
