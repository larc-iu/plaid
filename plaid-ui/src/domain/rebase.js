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
// - or, when the edit places something in the text (a token's begin and
//   end), is that text itself: the positions it sends were measured in the
//   text as it was.
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

// Every entity in `raw` by id: `{ layer, content, strings, begin, end }`.
// `layer` is the id of the entity it sits in, `content` its own fields (not
// the entities under it) as text, `strings` every string among them, from
// which the ids it names are read. Pending ids the server has since answered
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
    const content = JSON.stringify(own, (key, value) =>
      typeof value === 'string' ? settledId(value) : value,
    );
    const at = (k) => (typeof node[k] === 'number' ? node[k] : null);
    index.set(id, { layer, content, strings, begin: at('begin'), end: at('end') });
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
  for (const id of changed) {
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
  return { layers, names, spans, texts };
}

function holdersOf(...indexes) {
  const holders = new Set();
  for (const index of indexes) for (const e of index.values()) if (e.layer) holders.add(e.layer);
  return holders;
}

// Two stretches of the same layer share text. An empty one is read as the
// character after it, so it clashes with what covers that point.
const stop = (r) => (r.end > r.begin ? r.end : r.begin + 1);
const overlaps = (e, s) => e.layer === s.layer && e.begin < stop(s) && s.begin < stop(e);

// True when nothing that changed between `before` (what the edit was made on)
// and `now` (the document read after the refusal) touches `footprint`.
export function untouched(footprint, before, now) {
  if (!footprint) return false;
  const a = indexEntities(before);
  const b = indexEntities(now);
  const holders = holdersOf(a, b);
  for (const id of changedIds(a, b)) {
    if (footprint.names.has(id)) return false;
    for (const e of [a.get(id), b.get(id)]) {
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
