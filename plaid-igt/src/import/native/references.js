// References inside metadata, carried across a native import.
//
// An app may keep the id of another entity in an entity's metadata: a span
// naming the sentence token it belongs to, a document naming another document
// of the project. The archive writes metadata as it is, and an import gives
// every entity a new id, so such a value would come back naming something that
// no longer exists. So a metadata value that is EXACTLY the archive id of
// something the archive carries is taken for a reference to it, and the new id
// is written in its place. Only a whole string counts. A key, part of a
// longer string, or a value of any other type is data, never a reference.
//
// A reference can point forward, at something the import makes later than the
// entity holding it: a token naming a span, a document naming the next one.
// What is known when an entity is written is rewritten then. What names
// something later in the same document is patched once the document's last
// entity exists (`documentReferences`), and what names a later document is
// patched once every document is in (`relinkDocumentReferences`), from what
// the server holds, so that a resumed import settles the same way.

import { bulkInChunks } from '../../domain/bulk.js';

const isPlainObject = (v) =>
  v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/**
 * `value` with every string `lookup` knows replaced by what it maps to,
 * through objects and arrays. Keys are never touched. Returns `value` itself
 * when nothing in it changed, so a caller can tell by identity. `except` names
 * top-level keys to leave as they are: an import's own stamps hold archive ids
 * on purpose.
 */
export function rewriteReferences(value, lookup, except = null) {
  if (typeof value === 'string') return lookup(value) ?? value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = rewriteReferences(v, lookup);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = except?.has(k) ? v : rewriteReferences(v, lookup);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : value;
  }
  return value;
}

/** Whether any string anywhere in `value` (never a key) passes `test`. */
function holdsString(value, test) {
  if (typeof value === 'string') return test(value);
  if (Array.isArray(value)) return value.some((v) => holdsString(v, test));
  if (isPlainObject(value)) return Object.values(value).some((v) => holdsString(v, test));
  return false;
}

/**
 * The top-level keys whose values `after` changed from `before`, as a metadata
 * patch, or null when there are none. The server merges a patch one top-level
 * key at a time, so each changed key goes whole.
 */
function metadataPatch(before, after) {
  if (before === after || !isPlainObject(after)) return null;
  const patch = {};
  for (const [k, v] of Object.entries(after)) {
    if (v !== before?.[k]) patch[k] = v;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * The archive ids of the tokens, spans and relations one document file holds:
 * what a reference in that document can name and the import will make.
 */
export function archivedIds(docData) {
  const ids = new Set();
  const add = (node) => {
    if (node?.id != null) ids.add(node.id);
  };
  const fields = (node) => Object.values(node?.fields || {}).forEach(add);
  for (const s of docData.sentences || []) {
    add(s);
    fields(s);
    for (const w of s.words || []) {
      add(w);
      fields(w);
      for (const m of w.morphemes || []) {
        add(m);
        fields(m);
      }
    }
  }
  for (const list of [docData.orphanTokens, docData.alignment, docData.extraSpans]) {
    (list || []).forEach(add);
  }
  const other = docData.otherLayers || {};
  for (const entry of other.tokens || []) (entry.tokens || []).forEach(add);
  for (const entry of other.spans || []) (entry.spans || []).forEach(add);
  for (const entry of other.relations || []) (entry.relations || []).forEach(add);
  return ids;
}

/**
 * Every metadata map a document file holds on something other than the
 * document itself: its text, tokens, annotations, relations and links,
 * wherever the file keeps them.
 */
function* entityMetadata(docData) {
  function* walk(node) {
    if (Array.isArray(node)) {
      for (const v of node) yield* walk(v);
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'metadata') yield v;
      else yield* walk(v);
    }
  }
  for (const [k, v] of Object.entries(docData || {})) {
    // The document's own metadata, and the comments, which carry none.
    if (k === 'metadata' || k === 'comments') continue;
    yield* walk(v);
  }
}

// How a patch is sent, by the kind of entity it is for. Three kinds take many
// in one request, and the two that do not are rare here.
const PATCHERS = {
  token: { bulk: (client, rows) => client.tokens.bulkUpdate(rows) },
  span: { bulk: (client, rows) => client.spans.bulkUpdate(rows) },
  relation: { bulk: (client, rows) => client.relations.bulkUpdate(rows) },
  text: { one: (client, id, patch) => client.texts.patchMetadata(id, patch) },
  link: { one: (client, id, patch) => client.vocabLinks.patchMetadata(id, patch) },
};

async function sendPatches(client, patches, check) {
  for (const [kind, rows] of Object.entries(patches)) {
    const patcher = PATCHERS[kind];
    if (!rows.length || !patcher) continue;
    if (patcher.bulk) {
      await bulkInChunks(rows, check, (chunk) => patcher.bulk(client, chunk));
    } else {
      for (const { id, metadata } of rows) {
        check?.();
        await patcher.one(client, id, metadata);
      }
    }
  }
}

/**
 * The references in one document's metadata, for the import of that
 * document. `lookup` finds an archive id among what the import has made so
 * far. `ahead` holds the archive ids the document will make, so a value naming
 * one of those that `lookup` does not know yet is a reference forward.
 *
 * `create(kind, specs, send)` writes a batch of new entities through `send`
 * (which answers their ids in order) with their references rewritten, and
 * remembers each one that names something not made yet. `settle()`, once the
 * document's last entity exists, patches those.
 */
export function documentReferences({ client, lookup, ahead, check = () => {} }) {
  const pending = [];
  const prepare = (metadata) => {
    const rewritten = rewriteReferences(metadata, lookup);
    const later = holdsString(rewritten, (s) => ahead.has(s) && lookup(s) == null);
    return { metadata: rewritten, later };
  };
  return {
    /** Metadata ready to write, and whether it names something still to be made. */
    prepare,
    /** Remember an entity written with `prepare`'s metadata, to settle later. */
    remember(kind, id, metadata) {
      pending.push({ kind, id, metadata });
    },
    async create(kind, specs, send) {
      const prepared = specs.map((spec) => (spec.metadata ? prepare(spec.metadata) : null));
      const ids = await send(
        specs.map((spec, i) => (prepared[i] ? { ...spec, metadata: prepared[i].metadata } : spec)),
      );
      prepared.forEach((p, i) => {
        if (p?.later && ids?.[i]) pending.push({ kind, id: ids[i], metadata: p.metadata });
      });
      return ids ?? [];
    },
    async settle() {
      const patches = {};
      for (const p of pending) {
        const patch = metadataPatch(p.metadata, rewriteReferences(p.metadata, lookup));
        if (!patch) continue;
        (patches[p.kind] ||= []).push({ id: p.id, metadata: patch });
      }
      pending.length = 0;
      await sendPatches(client, patches, check);
    },
  };
}

/**
 * Once every document is in: patch what still names a document by its archive
 * id, which is a document made after the one naming it. `docIdMap` holds every
 * archive document the project now has, finished ones only. Works from what
 * the server holds rather than from what this run wrote, so it also settles a
 * document an earlier run finished, and does nothing the second time. Only a
 * document whose file names another document is read.
 */
export async function relinkDocumentReferences({
  client,
  documents,
  docIdMap,
  stampKeys,
  check = () => {},
}) {
  const archived = new Set(documents.map((d) => d.id).filter((id) => id != null));
  const lookup = (id) => docIdMap.get(id);
  for (const docData of documents) {
    const docId = docIdMap.get(docData.id);
    if (!docId) continue;
    check();
    // The document's own metadata. The import's stamps are left alone, since
    // one of them is the archive id of this very document, on purpose.
    if (holdsString(docData.metadata, (s) => archived.has(s))) {
      const current = (await client.documents.get(docId))?.metadata || {};
      const patch = metadataPatch(current, rewriteReferences(current, lookup, stampKeys));
      if (patch) await client.documents.patchMetadata(docId, patch);
    }
    // What is in it. A reference to the document itself was known when it
    // was written.
    const namesAnother = (s) => archived.has(s) && s !== docData.id;
    if (![...entityMetadata(docData)].some((m) => holdsString(m, namesAnother))) continue;
    const raw = await client.documents.get(docId, true);
    const patches = { token: [], span: [], relation: [], text: [], link: [] };
    const consider = (kind, entity) => {
      const patch = metadataPatch(entity?.metadata, rewriteReferences(entity?.metadata, lookup));
      if (patch) patches[kind].push({ id: entity.id, metadata: patch });
    };
    for (const tl of raw?.textLayers || []) {
      if (tl.text) consider('text', tl.text);
      for (const tkl of tl.tokenLayers || []) {
        for (const t of tkl.tokens || []) consider('token', t);
        for (const sl of tkl.spanLayers || []) {
          for (const s of sl.spans || []) consider('span', s);
          for (const rl of sl.relationLayers || []) {
            for (const r of rl.relations || []) consider('relation', r);
          }
        }
        for (const v of tkl.vocabs || []) {
          for (const l of v.vocabLinks || []) consider('link', l);
        }
      }
    }
    await sendPatches(client, patches, check);
  }
}
