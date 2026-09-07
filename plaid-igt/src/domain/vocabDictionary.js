// The dictionary side of a vocabulary: the sense tree, references from one
// entry to another, and promoted examples. All of it is metadata on ordinary
// items, read here and nowhere else in core.
//
// Nothing in this module exists for a vocabulary unless its Dictionary switch
// (`config.igt.dictionary`) is on. With it off, a vocabulary is the flat list
// it always was, and no screen shows a control from here.
//
// Reserved keys (never fields, see RESERVED_ITEM_KEYS in vocabFields.js):
//   parent      the id of the entry this one is a sense of. An item with no
//               parent is an ENTRY: its form is the headword, and it is also
//               sense 1. Its children are senses 2, 3, ..., theirs 2.1, 2.2.
//   senseOrder  an integer ordering an item among its siblings. Missing
//               orders sort after the numbered ones, in creation order.
//   examples    a list of example references, each {document, token}, chosen
//               from the concordance. A FLEx import stores {text, translation}
//               entries in the same list; those are read-only text.
//
// A field of type `item` holds a reference (or, with `many`, a list of them)
// to another entry of the SAME vocabulary. References never cross vocabularies.

import { FIELD_SCOPES, FIELD_TYPES } from './vocabFields.js';
import { IGT_NAMESPACE } from './igtConfig.js';

export const PARENT_KEY = 'parent';
export const SENSE_ORDER_KEY = 'senseOrder';
export const EXAMPLES_KEY = 'examples';
export const DICTIONARY_KEY = 'dictionary';

/** The editorial status field a dictionary vocabulary gets, and its list. */
export const STATUS_FIELD = 'status';
export const STATUS_TAGSET = 'Status';
export const STATUS_VALUES = ['draft', 'reviewed', 'published'];
export const statusTagset = () => ({
  delimiters: '',
  mode: 'closed',
  values: STATUS_VALUES.map((value) => ({ value })),
});

/** Whether a vocabulary's Dictionary switch is on. */
export const readDictionaryEnabled = (config) => config?.[IGT_NAMESPACE]?.[DICTIONARY_KEY] === true;

/**
 * What turning the switch on adds to a vocabulary's config, given what it
 * has: the Status tagset if missing, and the Status field held to it if
 * missing. Both the settings switch and an import that ticks Dictionary go
 * through here, so a vocabulary is set up the same way either way. Returns
 * `null` for a part that needs no write.
 */
export const dictionaryEnablement = ({ fieldsConfig, tagsets }) => {
  const nextTagsets = tagsets?.[STATUS_TAGSET]
    ? null
    : { ...(tagsets || {}), [STATUS_TAGSET]: statusTagset() };
  const nextFields =
    fieldsConfig && STATUS_FIELD in fieldsConfig
      ? null
      : { ...(fieldsConfig || {}), [STATUS_FIELD]: { inline: false, tagset: STATUS_TAGSET } };
  return { tagsets: nextTagsets, fieldsConfig: nextFields };
};

const isId = (v) => typeof v === 'string' && v.trim() !== '';

/** The fields that hold references to other entries. */
export const itemRefFields = (fields) => (fields || []).filter((f) => f.type === FIELD_TYPES.ITEM);

/** The fields shown on an item: entry-scope fields only on an entry (a root). */
export const fieldsForItem = (fields, item, dictionary) =>
  dictionary
    ? (fields || []).filter((f) => f.scope !== FIELD_SCOPES.ENTRY || !parentOf(item))
    : fields || [];

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
 */
export const refIds = (item, field) => {
  const v = item?.metadata?.[field.name];
  if (field.many) return Array.isArray(v) ? v.filter(isId) : [];
  return isId(v) ? [v] : [];
};

/** Write the ids back onto a metadata map, dropping the key when empty. */
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
 *   numberOf: Map<string, string>,       // "1" for a root, "2", "2.1" below it
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
    const base = cur ? rootOf.get(cur) : null;
    const baseDepth = cur ? depthOf.get(cur) : -1;
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = chain[i];
      rootOf.set(c, base ?? c);
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
  const number = (it, prefix, depth) => {
    numberOf.set(it.id, prefix);
    childrenOf.get(it.id).forEach((c, i) => {
      // The entry is sense 1, so its own senses count from 2; deeper levels
      // count from 1 under their parent's number.
      const n = depth === 0 ? i + 2 : i + 1;
      number(c, depth === 0 ? String(n) : `${prefix}.${n}`, depth + 1);
    });
  };
  for (const r of roots) number(r, '1', 0);
  return { byId, childrenOf, parentOf: parents, roots, numberOf, depthOf, rootOf };
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
 * Metadata for `item` made a sense of `parentId` (appended last), or its own
 * entry again when `parentId` is null.
 */
export const withParentSet = (tree, item, parentId) =>
  withParent(item.metadata, parentId, parentId ? nextSenseOrder(tree, parentId) : null);

/**
 * The sibling list renumbered 1..n with `id` moved by `dir` (-1 up, +1 down):
 * `[{id, metadata}]` patches for every sibling whose order changes. Renumbering
 * the whole list keeps orders dense, so a later move is always a swap.
 */
export const planSenseMove = (tree, id, dir) => {
  const p = tree.parentOf.get(id);
  if (!p) return [];
  const sibs = [...(tree.childrenOf.get(p) || [])];
  const i = sibs.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= sibs.length) return [];
  [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
  return renumbered(sibs, p);
};

/**
 * The sibling list with `id` placed at the number it is SHOWN with: under an
 * entry the senses are numbered from 2 (the entry is sense 1), deeper down
 * from 1. Out-of-range numbers land at the nearest end. Same dense
 * renumbering as a move.
 */
export const planSenseSetNumber = (tree, id, shown) => {
  const p = tree.parentOf.get(id);
  if (!p) return [];
  const sibs = [...(tree.childrenOf.get(p) || [])];
  const i = sibs.findIndex((s) => s.id === id);
  const n = Number(shown);
  if (i < 0 || !Number.isFinite(n)) return [];
  const first = tree.depthOf.get(id) === 1 ? 2 : 1;
  const j = Math.max(0, Math.min(sibs.length - 1, Math.round(n) - first));
  if (j === i) return [];
  const [moved] = sibs.splice(i, 1);
  sibs.splice(j, 0, moved);
  return renumbered(sibs, p);
};

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
 * nests under its parent only when the parent is ALSO in the list, so a
 * search never hides a hit and never drags in an entry that did not match.
 * Top-level items keep the list's order; nested ones follow sense order.
 *
 * @returns {{item: object, depth: number}[]}
 */
export const arrangeAsTree = (listed, tree) => {
  const shown = new Set(listed.map((it) => it.id));
  const out = [];
  const place = (it, depth) => {
    out.push({ item: it, depth });
    for (const c of tree.childrenOf.get(it.id) || []) if (shown.has(c.id)) place(c, depth + 1);
  };
  for (const it of listed) {
    const p = tree.parentOf.get(it.id);
    if (!p || !shown.has(p)) place(it, 0);
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
      if (live.length !== ids.length || !rawOk) {
        meta = withRefIds(meta, f, live);
        changed = true;
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
