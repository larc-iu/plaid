// The thread list a Comments tab shows: every entity with comments, described
// by its anchor, split into current and outdated, searched, and sorted.
//
// Pure over a CommentStore and an anchor index (see commentAnchors.js), so the
// React shell can page it with the app's list chrome and the lit-html island
// renders exactly what it is handed. Framework-agnostic, like everything else
// under domain/.

import { describeAnchor, anchorCaption } from './commentAnchors.js';

export const SORTS = Object.freeze(['recent', 'oldest', 'position']);

// The words of a Markdown body, for a one-line summary and for search.
export function plainText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_~>#]+/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const latest = (comments) => comments.reduce((m, c) => (c.createdAt > m ? c.createdAt : m), '');
const earliest = (comments) =>
  comments.reduce((m, c) => (m === '' || c.createdAt < m ? c.createdAt : m), '');

function describe(store, anchors, { entityType, entityId, comments }) {
  const anchor = describeAnchor(anchors, entityType, entityId, comments[0]?.anchorLabel ?? null);
  return {
    entityType,
    entityId,
    comments,
    anchor,
    outdated: !!anchor.outdated,
    caption: anchorCaption(anchor),
    latestAt: latest(comments),
    firstAt: earliest(comments),
    // What search matches against: the heading, the caption, every body, and
    // every author's name.
    text: [
      anchor.label,
      anchor.detail,
      comments[0]?.anchorLabel,
      ...comments.map((c) => plainText(c.body)),
      ...comments.map((c) => store.authorName(c.authorId)),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase(),
  };
}

const byLabel = (a, b) =>
  a.anchor.label.localeCompare(b.anchor.label, undefined, { sensitivity: 'base' });

// The anchor's place in the text (see buildAnchorIndex's `order`), compared
// entry by entry; an anchor with no place (an entry, an outdated thread) sorts
// after every anchor that has one.
const byOrder = (a, b) => {
  const oa = a.anchor.order;
  const ob = b.anchor.order;
  if (!oa || !ob) return oa ? -1 : ob ? 1 : 0;
  const n = Math.max(oa.length, ob.length);
  for (let i = 0; i < n; i++) {
    const d = (oa[i] ?? -Infinity) - (ob[i] ?? -Infinity);
    if (d) return d;
  }
  return 0;
};

const comparators = {
  recent: (a, b) => (a.latestAt > b.latestAt ? -1 : a.latestAt < b.latestAt ? 1 : byLabel(a, b)),
  oldest: (a, b) => (a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : byLabel(a, b)),
  // Text order: a sentence, then its values, then its words in order, each
  // before its morphemes and their values. Entries have no place in a text,
  // so they sort by form.
  position: (a, b) => byOrder(a, b) || byLabel(a, b) || (a.firstAt < b.firstAt ? -1 : 1),
};

export function sortThreads(threads, sort = 'recent') {
  return [...threads].sort(comparators[sort] ?? comparators.recent);
}

export function filterThreads(threads, query = '') {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!q) return threads;
  return threads.filter((t) => t.text.includes(q));
}

/**
 * Everything a Comments tab renders, from one store and one anchor index.
 *
 * `pinnedId` is the entity whose thread is always shown first and always
 * present (a document's own thread), even with no comments yet; it takes no
 * part in the search, the sort, or the counts.
 *
 * Returns `{ pinned, current, outdated, currentTotal, outdatedTotal }`: the two
 * lists are searched and sorted, the totals are what they were before the
 * search, so a count can say "3 of 12".
 */
export function threadList(
  store,
  anchors,
  { query = '', sort = 'recent', pinnedId = null, pinnedType = 'document' } = {},
) {
  const index = anchors ?? new Map();
  const all = store.threads().map((t) => describe(store, index, t));
  const pinned = pinnedId
    ? (all.find((t) => t.entityId === pinnedId) ??
      describe(store, index, { entityType: pinnedType, entityId: pinnedId, comments: [] }))
    : null;
  const rest = all.filter((t) => t.entityId !== pinnedId);
  const current = rest.filter((t) => !t.outdated);
  const outdated = rest.filter((t) => t.outdated);
  return {
    pinned,
    current: sortThreads(filterThreads(current, query), sort),
    outdated: sortThreads(filterThreads(outdated, query), sort),
    currentTotal: current.length,
    outdatedTotal: outdated.length,
  };
}
