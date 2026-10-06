// Whether an edit refused because the document changed (409) is untouched by
// what changed, so it can go again by itself on the new version (Luke's
// ruling Q2, 2026-09-29). One version covers a whole document, so two people
// glossing different words, or an igt gloss and a UMR node, refuse each other
// although they share nothing.
//
// Two rules (Q2 narrowed, 2026-09-30). Every edit gets the rule by layer
// (`apart`): it goes again only when every change in between is in a layer it
// neither reads nor writes. A caller may opt a value write in to the rule by
// entity (`untouched`, below), which also lets it pass a change in its own
// layer that touches nothing it writes. `resendable` picks between them.
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
// - or is the text under a token the edit's rows sit on, changed there (a
//   word respelled in place, its token kept where it was),
// - or, again for an edit that places something, is a token over the same
//   stretch in a layer the edit's layer nests in (its parent token layer, or
//   that one's), moved, resized or removed: the stretch was cut up
//   differently since (a word split or joined), and what the edit placed
//   inside the old cut may not sit inside the new one. A token only added
//   there is no such change, nor is one in a layer that is not a parent.
//   The same holds for the tokens a span or relation the edit writes sits
//   on (a relation's two ends, split into two sentences since).
// So a second value on the same word is a conflict, and so is any change to
// the word itself, while a value on another word, or anything in a layer the
// edit does not write, is not.

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
  // Where the rows it writes that are not placed themselves sit in the text:
  // the tokens they name, directly (a span's) or through what they name (a
  // relation's ends). A re-cut of a parent layer over them (a sentence
  // split between a relation's two ends) is judged as for a placed row.
  const anchors = [];
  const tokenOf = (id) => {
    const e = b.get(id) ?? a.get(id);
    return e && e.begin !== null && e.end !== null ? e : null;
  };
  for (const id of changed) {
    const e = b.get(id);
    if (!e || (e.begin !== null && e.end !== null)) continue;
    for (const s of e.strings) {
      const named = b.get(s) ?? a.get(s);
      for (const t of [tokenOf(s), ...(named?.strings ?? []).map(tokenOf)]) {
        if (t) anchors.push({ layer: t.layer, begin: t.begin, end: t.end });
      }
    }
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
  return {
    layers,
    names,
    spans,
    anchors,
    texts,
    removed,
    reads: layersRead(changed, a, b, holders, reshapes(changed, a, b)),
    reshapes: reshapes(changed, a, b),
  };
}

// Every layer an edit reads or writes: the layers of the rows it changes, of
// every row those name and so on down (a relation's spans, their tokens), the
// token layers those tokens' layers nest in, and the layers holding token
// layers (the text layer, whose text a token's begin and end are measured in).
// An edit that moves a token or the text (`shaped`) also writes every layer
// under the ones it changes.
function layersRead(changed, a, b, holders, shaped) {
  const reads = new Set();
  const placed = new Set();
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id) || holders.has(id)) return;
    seen.add(id);
    for (const e of [a.get(id), b.get(id)]) {
      if (!e) continue;
      if (e.layer) reads.add(e.layer);
      if (e.begin !== null && e.end !== null && e.layer) placed.add(e.layer);
      e.strings.forEach(visit);
    }
  };
  changed.forEach(visit);
  // What sits under a layer it re-cuts: a text edit moves or removes the
  // tokens of every layer in that text, and a word moved or removed takes
  // what is placed in it along.
  const written = new Set();
  for (const id of shaped ? changed : []) {
    for (const e of [a.get(id), b.get(id)]) if (e?.layer) written.add(e.layer);
  }
  // Every entity, not only the layers holding rows now: a layer still empty
  // is one too.
  const under = new Map();
  const isUnder = (id, path = new Set()) => {
    if (under.has(id)) return under.get(id);
    if (path.has(id)) return false;
    path.add(id);
    const e = a.get(id) ?? b.get(id);
    const parent =
      typeof e?.own?.parentTokenLayer === 'string' ? settledId(e.own.parentTokenLayer) : null;
    const answer = [e?.layer, parent].some(
      (outer) => outer && (written.has(outer) || isUnder(outer, path)),
    );
    under.set(id, answer);
    return answer;
  };
  for (const index of [a, b]) {
    for (const [id, e] of index)
      if (isUnder(id) && !(e.begin !== null && e.end !== null)) reads.add(id);
  }
  for (const layer of placed) {
    const holder = (a.get(layer) ?? b.get(layer))?.layer;
    if (holder) reads.add(holder);
    const seenLayers = new Set();
    let at = layer;
    while (at && !seenLayers.has(at)) {
      seenLayers.add(at);
      const own = (a.get(at) ?? b.get(at))?.own;
      at = typeof own?.parentTokenLayer === 'string' ? settledId(own.parentTokenLayer) : null;
      if (at) {
        reads.add(at);
        const outer = (a.get(at) ?? b.get(at))?.layer;
        if (outer) reads.add(outer);
      }
    }
  }
  return reads;
}

// Whether an edit changes where something already in the text sits: a row it
// moves, resizes or removes that has a begin and an end, or the text those
// are measured in.
function reshapes(changed, a, b) {
  const textLayers = new Set();
  for (const index of [a, b]) {
    for (const e of index.values()) {
      if (e.begin === null || e.end === null) continue;
      const holder = (a.get(e.layer) ?? b.get(e.layer))?.layer;
      if (holder) textLayers.add(holder);
    }
  }
  for (const id of changed) {
    const was = a.get(id);
    if (recut(was, b.get(id))) return true;
    if ([was, b.get(id)].some((e) => e && textLayers.has(e.layer))) return true;
  }
  return false;
}

// Whether an edit changed any entity at all, from the document before its
// patch and after it. `footprintOf` answers null both for an edit that
// changed none and for one that changed a holder's own fields.
export function changesEntities(before, after) {
  return changedIds(indexEntities(before), indexEntities(after)).size > 0;
}

// Every entity id in `raw`, read as `indexEntities` reads them, without the
// cost of reading each one's fields.
function entityIdsOf(raw) {
  const ids = new Set();
  const visit = (node) => {
    ids.add(settledId(node.id));
    for (const value of Object.values(node)) {
      if (isEntity(value)) visit(value);
      else if (isEntityList(value)) value.forEach(visit);
    }
  };
  if (isEntity(raw)) visit(raw);
  return ids;
}

// Whether any string anywhere in `raw` is one of `ids`. Stops at the first.
// A cheap test before `pendingIdsOf`, which reads every entity twice.
export function namesAnyOf(raw, ids) {
  if (!ids?.size) return false;
  const stack = [raw];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (ids.has(v)) return true;
    } else if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (v !== null && typeof v === 'object') {
      for (const x of Object.values(v)) stack.push(x);
    }
  }
  return false;
}

// The pending ids an edit made (rows it added under an id the server has not
// given yet), from the document before its patch and after it: what
// `pendingIdsOf` answers as `created`, for every send, at a fraction of the
// cost (H2-IGT-ANALYZE-3).
export function createdIdsOf(before, after) {
  const was = entityIdsOf(before);
  const created = new Set();
  for (const id of entityIdsOf(after)) if (isPendingId(id) && !was.has(id)) created.add(id);
  return created;
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

// Whether `was` is a text (a row holding text in a string field) that `is`
// changed inside one of `stretches`, the tokens placed in it, at the same
// offsets. Offsets count code points.
function respelled(was, is, stretches, a, b) {
  if (!was || !is || stretches.length === 0) return false;
  for (const k of Object.keys(was.own)) {
    const x = was.own[k];
    const y = is.own[k];
    if (typeof x !== 'string' || typeof y !== 'string' || x === y) continue;
    const xs = [...x];
    const ys = [...y];
    for (const s of stretches) {
      if ((a.get(s.layer) ?? b.get(s.layer))?.layer !== was.layer) continue;
      if (xs.slice(s.begin, s.end).join('') !== ys.slice(s.begin, s.end).join('')) return true;
    }
  }
  return false;
}

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
      [...footprint.spans, ...footprint.anchors].some(
        (s) => shares(was, s) && nestsIn(s.layer, was.layer, a, b),
      )
    ) {
      return false;
    }
    // The letters under a token its rows sit on, changed where the token
    // stands (a word respelled with its length kept): the value was given
    // to the word as it read.
    if (!holders.has(id) && respelled(was, b.get(id), footprint.anchors, a, b)) return false;
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

// True when every change between `before` and `now` is in a layer the edit
// neither reads nor writes (`footprint.reads`), names nothing it names, and
// names no row it removes. A layer's own change (its settings, or the layer
// made or removed) counts for that layer. Rows this page made that the server
// does not have yet are its own, not a change made elsewhere. The rule every
// edit gets (Luke's ruling Q2 narrowed): an igt gloss passes a UMR node or a
// parser's relations, while two edits in one layer never pass each other.
//
// `skip` is the ids of changes the caller has judged already, by a rule of
// its own that knows more of what its rows mean (plaid-umr's per sentence):
// they are not looked at here. Without it, every change is.
export function apart(footprint, before, now, { skip = null } = {}) {
  if (!footprint) return false;
  const a = indexEntities(before);
  const b = indexEntities(now);
  const holders = holdersOf(a, b);
  for (const id of changedIds(a, b)) {
    if (isPendingId(id) || skip?.has(id)) continue;
    if (footprint.names.has(id) || footprint.removed.has(id)) return false;
    if (holders.has(id)) {
      if (footprint.reads.has(id)) return false;
      continue;
    }
    for (const e of [a.get(id), b.get(id)]) {
      if (!e) continue;
      if (footprint.reads.has(e.layer)) return false;
      if (e.strings.some((s) => footprint.names.has(s) || footprint.removed.has(s))) return false;
    }
  }
  return true;
}

// Whether an edit refused because the document moved on can go again by
// itself on `now`. By layer (`apart`), unless the caller opted it in to the
// rule by entity (`untouched`) and it moves no token and no text: a value on
// a token whose extent it leaves as it is (Luke's ruling Q2 (c), igt's
// glosses).
export function resendable(footprint, before, now, { byEntity = false } = {}) {
  if (!footprint) return false;
  if (byEntity && !footprint.reshapes) return untouched(footprint, before, now);
  return apart(footprint, before, now);
}
