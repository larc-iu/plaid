// Whether an edit refused because the document changed (409) is untouched by
// what changed, so it can go again by itself on the new version (Luke's
// ruling Q2, 2026-09-29). One version covers a whole document, so two people
// glossing different words, or an igt gloss and a UMR node, refuse each other
// although they share nothing.
//
// Generic by layer and entity, with nothing of any app: a document read is a
// tree of objects with an `id` (layers, tokens, spans, relations, the text,
// the document itself), and that is all this reads. An edit's FOOTPRINT is
// what its optimistic patch changed (created, changed or removed), the layers
// those live in, and every id they name (a span's tokens, a relation's ends).
// What changed in between is the difference between the document the edit was
// made on and the one read after the refusal. The edit is independent when
// nothing that changed
// - is something the footprint names,
// - or lives in one of the edit's layers and names something the footprint
//   names, or covers text a changed token of the edit covers,
// - or, in any layer, names a row the edit removes: the server takes it with
//   that row, so the removal sent again would undo it unseen (an edge added
//   to a node the edit deletes),
// - or, when the edit places something in the text (a token's begin and
//   end), is that text itself: the positions it sends were measured in the
//   text as it was,
// - or, again for an edit that places something, is a token over the same
//   stretch in a layer the edit's layer nests in (its parent token layer, or
//   that one's), moved, resized or removed: the stretch was cut up
//   differently since (a word split or joined), and what the edit placed
//   inside the old cut may not sit inside the new one. A token only added
//   there is no such change, nor is one in a layer that is not a parent.
// So a second value on the same word is a conflict, and so is any change to
// the word itself, while a value on another word, or anything in a layer the
// edit does not write, is not.
//
// `landed` answers the other question a refusal can raise: whether the edit
// is on the server already (a resend of a write whose first answer was lost),
// by what the rows it wrote now hold.
//
// Imports nothing but a sibling with no imports (plaid-ud's node suite reaches
// DocumentModel by relative path).

import { settledId, isPendingId } from './pendingIds.js';

const isEntity = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.id === 'string';
const isEntityList = (v) => Array.isArray(v) && v.length > 0 && v.every(isEntity);

// An entity's fields as text that does not depend on how the row was shaped:
// keys in order, a null field the same as none, pending ids as the server's.
// A row this page showed before the server answered has the page's shape
// (its own key order, no `precedence: null`) until the next read, and is not
// a change someone else made.
function canonical(key, value) {
  if (typeof value === 'string') return settledId(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const k of Object.keys(value).sort()) if (value[k] != null) out[k] = value[k];
  return out;
}

// Every entity in `raw` by id: `{ layer, own, content, strings, begin, end }`.
// `layer` is the id of the entity it sits in, `own` its own fields (not the
// entities under it), `content` those as text, `strings` every string among
// them, from which the ids it names are read. Pending ids the server has since answered
// for are read as the server's, so an edit made before an earlier create
// settled compares with what the server holds.
function indexEntities(raw) {
  const index = new Map();
  const visit = (node, layer) => {
    const id = settledId(node.id);
    const own = {};
    const strings = [];
    for (const [key, value] of Object.entries(node)) {
      if (isEntity(value)) visit(value, id);
      else if (isEntityList(value)) value.forEach((child) => visit(child, id));
      // An empty list is a list of entities with none in it yet (a layer's
      // first span), not a field of the entity that holds it.
      else if (Array.isArray(value) && value.length === 0) continue;
      else {
        own[key] = value;
        if (typeof value === 'string') strings.push(settledId(value));
        else if (Array.isArray(value)) {
          for (const item of value) if (typeof item === 'string') strings.push(settledId(item));
        }
      }
    }
    const content = JSON.stringify(own, canonical);
    const at = (k) => (typeof node[k] === 'number' ? node[k] : null);
    index.set(id, { layer, own, content, strings, begin: at('begin'), end: at('end') });
  };
  if (isEntity(raw)) visit(raw, null);
  return index;
}

// The ids whose entity is new, gone, or different between two indexes.
function changedIds(a, b) {
  const out = new Set();
  for (const [id, e] of a) if (b.get(id)?.content !== e.content) out.add(id);
  for (const id of b.keys()) if (!a.has(id)) out.add(id);
  return out;
}

// What an edit touches, from the document before its patch and after it.
// Null when nothing is known of what it writes: the patch changed no entity,
// or changed the own fields of one that holds others (the document's name or
// metadata).
export function footprintOf(before, after) {
  const a = indexEntities(before);
  const b = indexEntities(after);
  const changed = changedIds(a, b);
  if (changed.size === 0) return null;
  // What holds other entities (a layer, the document): every row of a layer
  // names it, so its id says nothing of what an edit touches.
  const holders = holdersOf(a, b);
  // An edit to a holder's own fields (a document's name or metadata) has
  // nothing to compare by: another save to the same field would be written
  // over unseen.
  for (const id of changed) if (holders.has(id)) return null;
  const layers = new Set();
  const names = new Set();
  const spans = [];
  // The rows it removes: the server takes every row that names one with it.
  const removed = new Set();
  for (const id of changed) {
    if (a.has(id) && !b.has(id) && !isPendingId(id)) removed.add(id);
    for (const e of [a.get(id), b.get(id)]) {
      if (!e) continue;
      if (e.layer) layers.add(e.layer);
      for (const s of e.strings) names.add(s);
      if (e.begin !== null && e.end !== null)
        spans.push({ layer: e.layer, begin: e.begin, end: e.end });
    }
    names.add(id);
  }
  // Only ids count, and not a holder's. What names only this edit's own new
  // rows is not on the server to clash with.
  for (const id of [...names]) {
    const known = a.has(id) || b.has(id);
    if (!known || holders.has(id) || isPendingId(id)) names.delete(id);
  }
  // What holds the layers it places things in: the text layer, whose text
  // those positions are measured in.
  const texts = new Set();
  for (const s of spans) {
    const holder = (a.get(s.layer) ?? b.get(s.layer))?.layer;
    if (holder) texts.add(holder);
  }
  return { layers, names, spans, texts, removed };
}

// The pending ids an edit made (`created`: rows it added under an id the
// server has not given yet) and the ones it names (`named`: its own rows and
// every id its rows point at, still pending), from the document before its
// patch and after it. An edit that names a pending id another edit made, and
// that edit was refused, points at a row the server will never have.
export function pendingIdsOf(before, after) {
  const a = indexEntities(before);
  const b = indexEntities(after);
  const created = new Set();
  const named = new Set();
  for (const id of changedIds(a, b)) {
    if (isPendingId(id)) {
      named.add(id);
      if (!a.has(id)) created.add(id);
    }
    for (const e of [a.get(id), b.get(id)]) {
      for (const s of e?.strings ?? []) if (isPendingId(s)) named.add(s);
    }
  }
  return { created, named };
}

function holdersOf(...indexes) {
  const holders = new Set();
  for (const index of indexes) for (const e of index.values()) if (e.layer) holders.add(e.layer);
  return holders;
}

// Two stretches of the same layer share text. An empty one is read as the
// character after it, so it clashes with what covers that point.
const stop = (r) => (r.end > r.begin ? r.end : r.begin + 1);
const shares = (e, s) => e.begin < stop(s) && s.begin < stop(e);
const overlaps = (e, s) => e.layer === s.layer && shares(e, s);

// Whether token layer `layer` nests in `outer`: `outer` is its parent token
// layer, or that one's, and so on (read off each layer's `parentTokenLayer`).
function nestsIn(layer, outer, ...indexes) {
  const seen = new Set();
  let at = layer;
  while (at && !seen.has(at)) {
    seen.add(at);
    const own = indexes.map((index) => index.get(at)?.own).find(Boolean);
    const parent =
      typeof own?.parentTokenLayer === 'string' ? settledId(own.parentTokenLayer) : null;
    if (parent === outer) return true;
    at = parent;
  }
  return false;
}

// A token that was there before and has since been moved, resized or
// removed: the text under it was cut up differently.
const recut = (was, is) =>
  was && was.begin !== null && (!is || is.begin !== was.begin || is.end !== was.end);

// True when nothing that changed between `before` (what the edit was made on)
// and `now` (the document read after the refusal) touches `footprint`.
export function untouched(footprint, before, now) {
  if (!footprint) return false;
  const a = indexEntities(before);
  const b = indexEntities(now);
  const holders = holdersOf(a, b);
  for (const id of changedIds(a, b)) {
    if (footprint.names.has(id)) return false;
    const was = a.get(id);
    if (
      recut(was, b.get(id)) &&
      footprint.spans.some((s) => shares(was, s) && nestsIn(s.layer, was.layer, a, b))
    ) {
      return false;
    }
    for (const e of [a.get(id), b.get(id)]) {
      // A row, in any layer, that names a row the edit removes: sent again,
      // the removal would take it with it unseen.
      if (e && e.strings.some((s) => footprint.removed.has(s))) return false;
      // The text the edit's positions were measured in.
      if (e && !holders.has(id) && footprint.texts.has(e.layer)) return false;
      if (!e || !footprint.layers.has(e.layer)) continue;
      if (e.strings.some((s) => footprint.names.has(s))) return false;
      if (e.begin !== null && e.end !== null && footprint.spans.some((s) => overlaps(e, s))) {
        return false;
      }
    }
  }
  return true;
}

// Whether `x`, a value the edit showed, is `y`, the value read from the
// server. A pending id the server never answered for stands for whichever id
// is in its place, the same one wherever it appears (`ids`, pending id to
// server id, grows as they are met). A null field is the same as none.
function same(x, y, ids, claimed) {
  if (typeof x === 'string') {
    const id = settledId(x);
    if (!isPendingId(id)) return id === y;
    if (ids.has(id)) return ids.get(id) === y;
    if (typeof y !== 'string' || claimed.has(y)) return false;
    ids.set(id, y);
    claimed.add(y);
    return true;
  }
  if (x == null || y == null) return x == null && y == null;
  if (typeof x !== 'object' || typeof y !== 'object') return x === y;
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  if (Array.isArray(x)) {
    return x.length === y.length && x.every((v, i) => same(v, y[i], ids, claimed));
  }
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) if (!same(x[k], y[k], ids, claimed)) return false;
  return true;
}

// `same` without leaving anything in `ids` when it answers false.
function sameTrying(x, y, ids, claimed) {
  const tryIds = new Map(ids);
  const tryClaimed = new Set(claimed);
  if (!same(x, y, tryIds, tryClaimed)) return false;
  tryIds.forEach((v, k) => ids.set(k, v));
  tryClaimed.forEach((v) => claimed.add(v));
  return true;
}

// Whether the edit that turned `before` into `made` is in `now`, as read
// from the server: every row it removed is gone, every field it changed holds
// what it showed, and every row it added is there, a new row of the same
// layer holding the same fields. Answers the server's ids for the rows it
// added, as a map of pending id to server id, or null when it is not there
// or nothing is known of what it writes.
export function landed(before, made, now) {
  const a = indexEntities(before);
  const m = indexEntities(made);
  const n = indexEntities(now);
  const changed = changedIds(a, m);
  if (changed.size === 0) return null;
  const ids = new Map();
  const claimed = new Set();
  const added = [];
  for (const id of changed) {
    const was = a.get(id);
    const is = m.get(id);
    if (!is) {
      if (n.has(id)) return null;
    } else if (!was) {
      added.push(is);
    } else {
      const stored = n.get(id);
      if (!stored) return null;
      for (const k of new Set([...Object.keys(was.own), ...Object.keys(is.own)])) {
        if (same(was.own[k], is.own[k], new Map(), new Set())) continue;
        if (!same(is.own[k], stored.own[k], ids, claimed)) return null;
      }
    }
  }
  for (const is of added) {
    let found = false;
    for (const [id, e] of n) {
      if (a.has(id) || claimed.has(id) || e.layer !== settledId(is.layer)) continue;
      if (sameTrying(is.own, e.own, ids, claimed)) {
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  for (const id of [...ids.keys()]) if (!isPendingId(id)) ids.delete(id);
  return ids;
}
