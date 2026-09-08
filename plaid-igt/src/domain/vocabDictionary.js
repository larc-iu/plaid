// The dictionary side of a vocabulary: the sense tree, references from one
// entry to another, and promoted examples. All of it is metadata on ordinary
// items, read here and nowhere else in core. Every vocabulary is a dictionary,
// so nothing here is conditional.
//
// Reserved keys (never fields, see RESERVED_ITEM_KEYS in vocabFields.js):
//   parent      the id of the entry this one is a sense of. An item with no
//               parent is an ENTRY: its form is the headword. Its senses are
//               numbered 1, 2, ..., theirs 1.1, 1.2. The entry has no sense
//               number of its own; whether its own gloss is a meaning people
//               link to, or the entry is only a container for its senses, is
//               the user's, not the app's.
//   senseOrder  an integer ordering an item among its siblings. Missing
//               orders sort after the numbered ones, in creation order.
//   homograph   an integer ordering an ENTRY among the entries spelled the
//               same. Same fallback.
//   examples    a list of example references, each {document, token}, chosen
//               from the concordance. A FLEx import stores {text, translation}
//               entries in the same list; those are read-only text.
//
// A field of type `item` holds a reference (or, with `many`, a list of them)
// to another entry of the SAME vocabulary. References never cross vocabularies.

import { FIELD_SCOPES, FIELD_TYPES } from './vocabFields.js';

export const PARENT_KEY = 'parent';
export const SENSE_ORDER_KEY = 'senseOrder';
// The order of an entry among the entries that share its form. A FLEx
// import writes FLEx's homograph number here; reordering in the app
// rewrites it 1..n. Missing or zero sorts after the numbered ones.
export const HOMOGRAPH_KEY = 'homograph';
export const EXAMPLES_KEY = 'examples';

/** The editorial status field a new vocabulary is seeded with, and its list. */
export const STATUS_FIELD = 'status';
export const STATUS_TAGSET = 'Status';
export const STATUS_VALUES = ['draft', 'reviewed', 'published'];
export const statusTagset = () => ({
  delimiters: '',
  mode: 'closed',
  values: STATUS_VALUES.map((value) => ({ value })),
});

/**
 * A NEW vocabulary's config: what it was given, plus the Status tagset and the
 * Status field held to it wherever either is missing. Both parts always come
 * back whole and ready to write, so a caller never asks which half changed.
 * Returning null for the unchanged half is what the retroactive callers
 * needed, and writing that null would have wiped a field inventory.
 *
 * The two paths that create a vocabulary both call this: the New vocabulary
 * screen (VocabularyDetail) and the project setup wizard (executeSetup). Only
 * creation calls it. An existing vocabulary is left as its owner arranged it,
 * so nothing sprouts a Status field it was never given.
 */
export const statusFieldSeed = ({ fieldsConfig, tagsets }) => {
  // Case-insensitively, the way the field editor rejects a duplicate. A user
  // who names their own field "Status" (the label the app shows) already has
  // this field, and adding `status` beside it would make the very pair the
  // editor forbids, writing two metadata keys that read as one.
  const declared = Object.keys(fieldsConfig || {}).some((k) => k.toLowerCase() === STATUS_FIELD);
  if (declared) return { fieldsConfig: fieldsConfig ?? {}, tagsets: tagsets ?? {} };
  return {
    fieldsConfig: {
      ...(fieldsConfig || {}),
      [STATUS_FIELD]: { inline: false, tagset: STATUS_TAGSET },
    },
    tagsets: tagsets?.[STATUS_TAGSET]
      ? tagsets
      : { ...(tagsets || {}), [STATUS_TAGSET]: statusTagset() },
  };
};

const isId = (v) => typeof v === 'string' && v.trim() !== '';

/** The fields that hold references to other entries. */
export const itemRefFields = (fields) => (fields || []).filter((f) => f.type === FIELD_TYPES.ITEM);

/** The fields shown on an item: entry-scope fields only on an entry (a root). */
export const fieldsForItem = (fields, item) =>
  (fields || []).filter((f) => f.scope !== FIELD_SCOPES.ENTRY || !parentOf(item));

/** The id this item is a sense of, or null. */
export const parentOf = (item) => {
  const v = item?.metadata?.[PARENT_KEY];
  return isId(v) ? v : null;
};

/** The item's order among its siblings, or null when unnumbered. */
export const senseOrderOf = (item) => {
  const v = item?.metadata?.[SENSE_ORDER_KEY];
  return Number.isFinite(v) ? v : null;
};

/**
 * The ids a reference field holds on an item, always as a list: a single
 * field holds zero or one, a `many` field any number. Anything that is not an
 * id string is ignored.
 *
 * Reading is deliberately blind to the field's own `many`. A field changed
 * from one reference to many (or back) leaves every value in the shape the
 * old field wrote, and those are still the entries the user picked, so they
 * are read and then rewritten in the field's current shape by `withRefIds`.
 * Reading strictly is what once made that change erase every value it held.
 */
export const refIds = (item, field) => {
  const v = item?.metadata?.[field.name];
  if (Array.isArray(v)) return v.filter(isId);
  return isId(v) ? [v] : [];
};

/**
 * Write the ids back onto a metadata map, dropping the key when empty. A
 * single-reference field keeps the first id and drops the rest.
 */
export const withRefIds = (metadata, field, ids) => {
  const next = { ...(metadata || {}) };
  const clean = [...new Set((ids || []).filter(isId))];
  if (!clean.length) delete next[field.name];
  else next[field.name] = field.many ? clean : clean[0];
  return next;
};

const withParent = (metadata, parentId, order) => {
  const next = { ...(metadata || {}) };
  if (parentId) next[PARENT_KEY] = parentId;
  else delete next[PARENT_KEY];
  if (parentId && Number.isFinite(order)) next[SENSE_ORDER_KEY] = order;
  else if (!parentId) delete next[SENSE_ORDER_KEY];
  return next;
};

/** Promoted example references on an item, `{document, token}` only. */
export const exampleRefs = (item) => {
  const v = item?.metadata?.[EXAMPLES_KEY];
  return Array.isArray(v) ? v.filter((e) => e && isId(e.document) && isId(e.token)) : [];
};

/** The whole examples list, references and imported text alike, in order. */
export const allExamples = (item) => {
  const v = item?.metadata?.[EXAMPLES_KEY];
  return Array.isArray(v)
    ? v.filter((e) => e && ((isId(e.document) && isId(e.token)) || typeof e.text === 'string'))
    : [];
};

/**
 * The key a promoted example is looked up by once its sentence has been read
 * out of the document it points into. Shared by the LIFT export and whatever
 * resolves the references for it.
 */
export const exampleKey = (document, token) => `${document}/${token}`;

/** The examples list with one reference added (a duplicate is ignored). */
export const withExampleAdded = (metadata, ref) => {
  const list = allExamples({ metadata });
  if (list.some((e) => e.document === ref.document && e.token === ref.token)) return metadata;
  return {
    ...(metadata || {}),
    [EXAMPLES_KEY]: [...list, { document: ref.document, token: ref.token }],
  };
};

/** The examples list with the example at `index` removed, key dropped when empty. */
export const withExampleRemoved = (metadata, index) => {
  const list = allExamples({ metadata }).filter((_, i) => i !== index);
  const next = { ...(metadata || {}) };
  if (list.length) next[EXAMPLES_KEY] = list;
  else delete next[EXAMPLES_KEY];
  return next;
};

// ---- the sense tree --------------------------------------------------------

/**
 * The tree over a vocabulary's items. `items` in creation order (as the
 * server returns them), which is what unnumbered siblings fall back to.
 *
 * A parent that is not in `items` counts as none: the item is a root. (The
 * validator clears such references; until it runs, the tree still stands.)
 *
 * @returns {{
 *   byId: Map<string, object>,
 *   childrenOf: Map<string, object[]>,   // ordered siblings, every item has an entry
 *   parentOf: Map<string, string|null>,
 *   roots: object[],
 *   numberOf: Map<string, string>,       // "" for a root, "1", "1.2" below it
 *   depthOf: Map<string, number>,
 *   rootOf: Map<string, string>,         // the entry an item belongs to
 * }}
 */
export const buildSenseTree = (items) => {
  const list = items || [];
  const byId = new Map(list.map((it) => [it.id, it]));
  const position = new Map(list.map((it, i) => [it.id, i]));
  const parents = new Map();
  const childrenOf = new Map(list.map((it) => [it.id, []]));
  for (const it of list) {
    const p = parentOf(it);
    const ok = p && p !== it.id && byId.has(p);
    parents.set(it.id, ok ? p : null);
    if (ok) childrenOf.get(p).push(it);
  }
  // Cycles: a parent chain that never reaches a root. Every item on such a
  // chain is treated as a root (the validator clears their parents).
  const rootOf = new Map();
  const depthOf = new Map();
  const resolve = (id) => {
    if (rootOf.has(id)) return rootOf.get(id);
    const chain = [];
    let cur = id;
    const seen = new Set();
    while (cur && !rootOf.has(cur)) {
      if (seen.has(cur)) {
        // cycle: cut every link on it
        for (const c of chain) {
          parents.set(c, null);
          rootOf.set(c, c);
          depthOf.set(c, 0);
        }
        return rootOf.get(id);
      }
      seen.add(cur);
      chain.push(cur);
      cur = parents.get(cur);
    }
    // The chain's root: what the resolved ancestor rolls up to, or, with no
    // resolved ancestor, the chain's own top. Every link on the chain shares
    // it (a sense listed before its headword resolves the two together).
    const base = cur ? rootOf.get(cur) : null;
    const baseDepth = cur ? depthOf.get(cur) : -1;
    const rootId = base ?? chain[chain.length - 1];
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = chain[i];
      rootOf.set(c, rootId);
      depthOf.set(c, baseDepth + (chain.length - i));
    }
    return rootOf.get(id);
  };
  for (const it of list) resolve(it.id);
  // Rebuild the children lists after any cycle cuts, then order siblings.
  for (const l of childrenOf.values()) l.length = 0;
  for (const it of list) {
    const p = parents.get(it.id);
    if (p) childrenOf.get(p).push(it);
  }
  const byOrder = (a, b) => {
    const ao = senseOrderOf(a);
    const bo = senseOrderOf(b);
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    if (ao != null && bo == null) return -1;
    if (ao == null && bo != null) return 1;
    return position.get(a.id) - position.get(b.id);
  };
  for (const l of childrenOf.values()) l.sort(byOrder);
  const roots = list.filter((it) => !parents.get(it.id));
  const numberOf = new Map();
  const number = (it, prefix) => {
    numberOf.set(it.id, prefix);
    childrenOf.get(it.id).forEach((c, i) => {
      number(c, prefix ? `${prefix}.${i + 1}` : String(i + 1));
    });
  };
  for (const r of roots) number(r, '');
  return { byId, childrenOf, parentOf: parents, roots, numberOf, depthOf, rootOf };
};

/**
 * One dotted number per item, the name it goes by everywhere. The first
 * segment is the HEADWORD's: its place among the
 * entries spelled the same ("a 1", "a 2"), or "1" when it is alone but has
 * senses. A sense carries its headword's segment and then its own path
 * ("a 1.2", "adidi 1.1", "adidi 1.2.1"). A lone headword with no senses has
 * no number at all. Values are strings, so the label draws them as text,
 * never as subscripts, and never as superscripts, which mark tone. `items`
 * in creation order, as the server returns them.
 *
 * @returns {Map<string, string>} item id -> its number, '' for a lone entry
 */
export const buildItemNumbers = (items) => {
  const tree = buildSenseTree(items);
  const segOf = new Map();
  for (const group of homographGroups(items, tree).values()) {
    if (group.length > 1) group.forEach((r, i) => segOf.set(r.id, String(i + 1)));
    // A lone headword with senses is "1" too, so one segment always means a
    // headword and two always mean a sense: "adidi 1" over "adidi 1.1",
    // never a bare "adidi" beside an "adidi 1" that could be either.
    else if (tree.childrenOf.get(group[0].id)?.length) segOf.set(group[0].id, '1');
  }
  const out = new Map();
  for (const it of items || []) {
    const seg = segOf.get(tree.rootOf.get(it.id)) ?? '';
    const path = tree.numberOf.get(it.id) ?? '';
    out.set(it.id, seg && path ? `${seg}.${path}` : seg || path);
  }
  return out;
};

/** An entry's stored homograph number, or null when unnumbered or zero. */
export const homographOf = (item) => {
  const v = Number(item?.metadata?.[HOMOGRAPH_KEY]);
  return Number.isFinite(v) && v > 0 ? v : null;
};

// form -> the entries spelled that way, in homograph order then creation
// order. `tree` may be passed to save building it twice.
const homographGroups = (items, tree = buildSenseTree(items)) => {
  const position = new Map((items || []).map((it, i) => [it.id, i]));
  const byForm = new Map();
  for (const r of tree.roots) byForm.set(r.form ?? '', [...(byForm.get(r.form ?? '') || []), r]);
  const byNumber = (a, b) => {
    const ha = homographOf(a);
    const hb = homographOf(b);
    if (ha != null && hb != null && ha !== hb) return ha - hb;
    if (ha != null && hb == null) return -1;
    if (ha == null && hb != null) return 1;
    return position.get(a.id) - position.get(b.id);
  };
  for (const g of byForm.values()) g.sort(byNumber);
  return byForm;
};

/**
 * The entries spelled like `id`'s entry, in their order: what the homograph
 * dialog lists. Empty when there is only one, since one needs no number.
 */
export const homographGroup = (items, id) => {
  const tree = buildSenseTree(items);
  const root = tree.byId.get(tree.rootOf.get(id));
  if (!root) return [];
  const group = homographGroups(items, tree).get(root.form ?? '') || [];
  return group.length > 1 ? group : [];
};

/**
 * Patches writing the homograph numbers 1..n onto `group` in the order of
 * `orderedIds`, for the entries whose number changes.
 */
export const planHomographOrder = (group, orderedIds) => {
  const byId = new Map(group.map((r) => [r.id, r]));
  const out = [];
  orderedIds.forEach((id, i) => {
    const r = byId.get(id);
    if (!r || homographOf(r) === i + 1) return;
    out.push({ id, metadata: { ...(r.metadata || {}), [HOMOGRAPH_KEY]: i + 1 } });
  });
  return out;
};

/** Every item under `id`, depth-first in sense order (not including it). */
export const descendantsOf = (tree, id) => {
  const out = [];
  const walk = (x) => {
    for (const c of tree.childrenOf.get(x) || []) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(id);
  return out;
};

/**
 * The next free sense order under a parent: one past the largest numbered
 * sibling, or past the count when none is numbered.
 */
export const nextSenseOrder = (tree, parentId) => {
  const sibs = tree.childrenOf.get(parentId) || [];
  const max = Math.max(0, ...sibs.map((s) => senseOrderOf(s) ?? 0));
  return Math.max(max, sibs.length) + 1;
};

/**
 * The metadata keys that belong to an ENTRY rather than to one of its senses:
 * its place among the entries spelled alike, the form facts a headword carries,
 * the FLEx entry it came from, and every headword-only field. `gloss`, `pos`,
 * `definition`, the examples and the status stay with the sense.
 */
const ENTRY_LEVEL_KEYS = [HOMOGRAPH_KEY, 'morphType', 'lexemeForm', 'flexEntry'];

/**
 * One entry's metadata split for raising a headword over it: what the new
 * headword takes, and what the entry keeps as it becomes a sense. Without the
 * split the number, the morph type and any headword-only field would sit on a
 * sense, where the entry form does not even show them.
 */
export const splitEntryLevel = (metadata, fields) => {
  const entryFields = new Set(
    (fields || []).filter((f) => f.scope === FIELD_SCOPES.ENTRY).map((f) => f.name),
  );
  const entry = {};
  const sense = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (key === PARENT_KEY || key === SENSE_ORDER_KEY) continue; // placement, set by the caller
    (ENTRY_LEVEL_KEYS.includes(key) || entryFields.has(key) ? entry : sense)[key] = value;
  }
  return { entry, sense };
};

/**
 * Metadata for `item` made a sense of `parentId` (appended last), or its own
 * entry again when `parentId` is null.
 */
export const withParentSet = (tree, item, parentId) =>
  withParent(item.metadata, parentId, parentId ? nextSenseOrder(tree, parentId) : null);

/**
 * Where a dragged item lands, as `[{id, metadata}]` patches:
 *   {kind: 'root'}            its own entry (parent and order cleared)
 *   {kind: 'into', id}        last sense of `id`
 *   {kind: 'before'|'after', id}  a sibling of `id`, just before or after it
 * A drop onto itself, or into its own subtree, moves nothing. Before or
 * after an ENTRY (a root) means into it, first or last: entries have no
 * order among themselves. Siblings are renumbered densely.
 */
export const planSenseDrop = (tree, id, target) => {
  if (!target || !tree.byId.has(id)) return [];
  const item = tree.byId.get(id);
  const inSubtree = new Set([id, ...descendantsOf(tree, id).map((d) => d.id)]);
  if (target.kind === 'root') {
    if (!tree.parentOf.get(id)) return [];
    return [{ id, metadata: withParent(item.metadata, null, null) }];
  }
  if (!tree.byId.has(target.id) || inSubtree.has(target.id)) return [];
  let parent;
  let sibs;
  let at;
  if (target.kind === 'into' || !tree.parentOf.get(target.id)) {
    parent = target.id;
    sibs = (tree.childrenOf.get(parent) || []).filter((s) => s.id !== id);
    at = target.kind === 'before' ? 0 : sibs.length;
  } else {
    parent = tree.parentOf.get(target.id);
    sibs = (tree.childrenOf.get(parent) || []).filter((s) => s.id !== id);
    at = sibs.findIndex((s) => s.id === target.id) + (target.kind === 'after' ? 1 : 0);
  }
  sibs.splice(at, 0, item);
  const moved = tree.parentOf.get(id) !== parent;
  const patches = renumbered(sibs, parent);
  // A sibling list that already stood in this order yields no patch for the
  // moved item, so make sure its new parent is written.
  if (moved && !patches.some((p) => p.id === id)) {
    patches.push({ id, metadata: withParent(item.metadata, parent, senseOrderOf(item)) });
  }
  return patches;
};

// Patches renumbering `sibs` 1..n under `p`, for those whose order changes.
const renumbered = (sibs, p) =>
  sibs
    .map((s, k) => ({ id: s.id, metadata: withParent(s.metadata, p, k + 1), was: senseOrderOf(s) }))
    .filter((x) => x.was !== x.metadata[SENSE_ORDER_KEY])
    .map(({ id: sid, metadata }) => ({ id: sid, metadata }));

/**
 * Lay out a (possibly filtered, sorted) list as a tree for display: an item
 * nests under its parent, and a hit whose ancestors are not in the list gets
 * them above it as CONTEXT rows (`context: true`), so a sense found by a
 * search still shows which entry it belongs to without the search having
 * to match the entry. Nothing that matched is hidden; nothing else is
 * listed except as context. Top-level items keep the list's order; nested
 * ones follow sense order.
 *
 * @returns {{item: object, depth: number, context?: boolean}[]}
 */
export const arrangeAsTree = (listed, tree) => {
  const shown = new Set(listed.map((it) => it.id));
  const placed = new Set();
  const out = [];
  const place = (it, depth, context = false) => {
    if (placed.has(it.id)) return;
    placed.add(it.id);
    out.push({ item: it, depth, ...(context ? { context: true } : {}) });
    for (const c of tree.childrenOf.get(it.id) || []) {
      // A child comes along when it matched, or when something under it did.
      if (shown.has(c.id) || descendantsOf(tree, c.id).some((d) => shown.has(d.id))) {
        place(c, depth + 1, !shown.has(c.id));
      }
    }
  };
  for (const it of listed) {
    if (placed.has(it.id)) continue;
    // Start from the top of its chain, so the hit sits under its context.
    const chain = [];
    let cur = it;
    while (cur) {
      chain.unshift(cur);
      const p = tree.parentOf.get(cur.id);
      cur = p ? tree.byId.get(p) : null;
    }
    place(chain[0], 0, !shown.has(chain[0].id));
  }
  return out;
};

/**
 * The items that refer to `id`, as `[{item, field}]`: `field` is a reference
 * field, or null when the item is a sense of it.
 */
export const referencesTo = (items, fields, id) => {
  const out = [];
  const refFields = itemRefFields(fields);
  for (const it of items || []) {
    if (it.id === id) continue;
    if (parentOf(it) === id) out.push({ item: it, field: null });
    for (const f of refFields) if (refIds(it, f).includes(id)) out.push({ item: it, field: f });
  }
  return out;
};

// ---- integrity ---------------------------------------------------------------

/**
 * Every reference that points nowhere, or in a circle: `[{id, metadata}]`
 * patches that clear them, and one finding per cleared item. An item whose
 * parent is gone becomes an entry; a reference to a missing entry is dropped
 * from its field. Only items actually changed are returned, so an empty
 * result means the vocabulary is sound.
 */
export const validateVocabRefs = (items, fields) => {
  const list = items || [];
  const byId = new Map(list.map((it) => [it.id, it]));
  const refFields = itemRefFields(fields);
  const patches = [];
  const findings = [];
  // Parent chains that never reach a root.
  const onCycle = new Set();
  for (const it of list) {
    const seen = new Set();
    let cur = it.id;
    while (cur) {
      if (seen.has(cur)) {
        for (const c of seen) onCycle.add(c);
        break;
      }
      seen.add(cur);
      const p = parentOf(byId.get(cur));
      cur = p && byId.has(p) ? p : null;
    }
  }
  for (const it of list) {
    let meta = it.metadata || {};
    let changed = false;
    const why = [];
    const p = parentOf(it);
    if (p && (p === it.id || !byId.has(p))) {
      meta = withParent(meta, null, null);
      changed = true;
      why.push('its parent entry no longer exists');
    } else if (onCycle.has(it.id)) {
      meta = withParent(meta, null, null);
      changed = true;
      why.push('its parent chain looped back on itself');
    } else if (!p && meta[SENSE_ORDER_KEY] != null) {
      // A stray order on an entry: harmless, cleared quietly.
      meta = withParent(meta, null, null);
      changed = true;
    }
    for (const f of refFields) {
      const ids = refIds(it, f);
      const live = ids.filter((x) => x !== it.id && byId.has(x));
      const raw = meta[f.name];
      const rawOk = raw == null || (f.many ? Array.isArray(raw) && raw.every(isId) : isId(raw));
      if (live.length === ids.length && rawOk) continue;
      meta = withRefIds(meta, f, live);
      changed = true;
      // A value merely in the other shape is rewritten in this field's own,
      // which is nothing to report. A target that is gone is.
      if (live.length !== ids.length) {
        why.push(`${f.name} pointed at an entry that no longer exists`);
      }
    }
    if (!changed) continue;
    patches.push({ id: it.id, metadata: meta });
    if (why.length) findings.push({ id: it.id, form: it.form, reasons: why });
  }
  return { patches, findings };
};

/**
 * Patches for the items that refer to entries about to be deleted: their
 * senses become entries of their own, and references to them are dropped.
 */
export const planDeleteRefs = (items, fields, deletedIds) => {
  const gone = new Set(deletedIds);
  const refFields = itemRefFields(fields);
  const patches = [];
  for (const it of items || []) {
    if (gone.has(it.id)) continue;
    let meta = it.metadata || {};
    let changed = false;
    const p = parentOf(it);
    if (p && gone.has(p)) {
      meta = withParent(meta, null, null);
      changed = true;
    }
    for (const f of refFields) {
      const ids = refIds(it, f);
      const kept = ids.filter((x) => !gone.has(x));
      if (kept.length !== ids.length) {
        meta = withRefIds(meta, f, kept);
        changed = true;
      }
    }
    if (changed) patches.push({ id: it.id, metadata: meta });
  }
  return patches;
};

/**
 * Patches for a merge: every reference to a losing entry now names the
 * survivor, the losers' senses become the survivor's, and a survivor whose
 * own parent was a loser takes that loser's parent. Losers themselves get no
 * patch (they are deleted).
 */
export const planMergeRefs = (items, fields, survivorId, loserIds) => {
  const losers = new Set(loserIds);
  losers.delete(survivorId);
  const refFields = itemRefFields(fields);
  const tree = buildSenseTree(items);
  const patches = [];
  let order = nextSenseOrder(tree, survivorId);
  for (const it of items || []) {
    if (losers.has(it.id)) continue;
    let meta = it.metadata || {};
    let changed = false;
    const p = parentOf(it);
    if (p && losers.has(p)) {
      if (it.id === survivorId) {
        // Walk up past every losing ancestor, through the tree rather than the
        // raw metadata: a self-parent or a cycle there never terminates.
        let up = p;
        while (up && (losers.has(up) || up === survivorId)) up = tree.parentOf.get(up) ?? null;
        meta = withParent(meta, up || null, up ? nextSenseOrder(tree, up) : null);
      } else {
        meta = withParent(meta, survivorId, order++);
      }
      changed = true;
    }
    for (const f of refFields) {
      const ids = refIds(it, f);
      if (!ids.some((x) => losers.has(x))) continue;
      const mapped = ids.map((x) => (losers.has(x) ? survivorId : x)).filter((x) => x !== it.id);
      meta = withRefIds(meta, f, mapped);
      changed = true;
    }
    if (changed) patches.push({ id: it.id, metadata: meta });
  }
  return patches;
};

/**
 * Ranked popover candidates regrouped under their headwords: each headword
 * appears once, at the place of its
 * best-ranked member, followed by the ranked members under it in tree
 * order. A headword none of whose own rank made the list is still shown
 * above its senses, marked `context`, so a sense is never listed adrift.
 * Anything not in `ranked` is left out. Rows carry the ranked item's own
 * annotations (rank fields, number) and a `depth`.
 *
 * @param {object[]} ranked items in rank order, annotated
 * @param {object[]} items the whole vocabulary, in creation order
 * @returns {{item: object, depth: number, context?: boolean}[]}
 */
export const groupRankedByHeadword = (ranked, items) => {
  const tree = buildSenseTree(items);
  const byRankedId = new Map(ranked.map((it) => [it.id, it]));
  const done = new Set();
  const out = [];
  const walk = (id, depth) => {
    for (const c of tree.childrenOf.get(id) || []) {
      const hit = byRankedId.get(c.id);
      const below = descendantsOf(tree, c.id).some((d) => byRankedId.has(d.id));
      if (!hit && !below) continue;
      out.push({ item: hit ?? c, depth, ...(hit ? {} : { context: true }) });
      walk(c.id, depth + 1);
    }
  };
  for (const it of ranked) {
    const rootId = tree.rootOf.get(it.id) ?? it.id;
    if (done.has(rootId)) continue;
    done.add(rootId);
    const head = byRankedId.get(rootId);
    const root = tree.byId.get(rootId) ?? it;
    out.push({ item: head ?? root, depth: 0, ...(head ? {} : { context: true }) });
    walk(rootId, 1);
  }
  return out;
};
