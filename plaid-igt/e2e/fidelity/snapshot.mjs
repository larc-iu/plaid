// A project's whole server state as one id-free, canonically ordered value.
//
// This is the reference every fidelity check compares against, so it reads
// the server directly and never goes through an exporter or the editor's
// derived view. The native round-trip script used to compare archive A with
// archive B, which only proves that the exporter agrees with itself: a thing
// both sides drop is invisible. Here both sides of a comparison are what core
// actually holds.
//
// Ids are correlation keys that an import replaces, so every reference is
// rewritten into something that survives one:
//
//   layer     `token:word`, `span:morpheme/Gloss`, by role (or name, for a
//             layer with no role) and parent
//   token     `word:4-9`, plus `@2` for a precedence and `#2` for an exact
//             duplicate
//   item      `perro#2`, the form and its 1-based place among the entries of
//             that form in server order. Server order is creation order and
//             is contractual (homonym numbering), so an import that reorders
//             entries shows up as a difference.
//   span      `span:word/Gloss|word:0-5,word:6-9`, plus `#2` for a second span
//             in the same field on the same tokens
//
// Ids INSIDE metadata are rewritten too, where the app defines them: an
// entry's `parent`, every `type: "item"` field, and each `{document, token}`
// example. Any other id-shaped value is left alone and will differ after an
// import, which is the point.
//
// Left out, because no format is meant to carry them: document version and
// timestamps, permissions (readers, writers, maintainers), comment ids. Comment
// authors and dates ARE kept (a comparison decides what to ignore), and so is
// the whole config of every layer and vocabulary.

import { createHash } from 'node:crypto';
import { stableStringify } from '../../src/test/fidelity/stable.js';

export { stableStringify };

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const sortByKey = (rows, keyOf) =>
  rows
    .map((r) => [keyOf(r), r])
    .sort((a, b) => byString(a[0], b[0]))
    .map(([, r]) => r);

const roleOf = (layer) => layer?.config?.plaid?.role ?? null;
const layerLabel = (layer) => roleOf(layer) ?? `name=${layer.name}`;

async function readMedia(client, documentId) {
  const data = await client.documents.getMedia(documentId);
  let bytes;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data))
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else if (data && typeof data.arrayBuffer === 'function')
    bytes = new Uint8Array(await data.arrayBuffer());
  else throw new Error(`unrecognized media response for document ${documentId}`);
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Item-reference fields of a vocabulary: name -> many. */
function itemFields(vocabConfig) {
  const out = new Map();
  for (const [name, f] of Object.entries(vocabConfig?.igt?.fields || {})) {
    if (f && typeof f === 'object' && f.type === 'item') out.set(name, !!f.many);
  }
  return out;
}

/**
 * Snapshot one project. `media: false` skips downloading recordings (their
 * presence is still recorded).
 */
export async function snapshotProject(client, projectId, { media = true } = {}) {
  const project = await client.projects.get(projectId);

  // ---- layers ---------------------------------------------------------------
  const layerKeyById = new Map();
  const layers = [];
  // `position` is a layer's place among its siblings. Core keeps it (order_idx)
  // and the editor shows annotation fields in that order, so it is data.
  (project.textLayers || []).forEach((tl, tlPos) => {
    const key = `text:${layerLabel(tl)}`;
    layerKeyById.set(tl.id, key);
    layers.push({ key, name: tl.name, position: tlPos, config: tl.config || {} });
    (tl.tokenLayers || []).forEach((tkl, tkPos) => {
      const tkKey = `token:${layerLabel(tkl)}`;
      layerKeyById.set(tkl.id, tkKey);
      layers.push({ key: tkKey, name: tkl.name, position: tkPos, config: tkl.config || {} });
      (tkl.spanLayers || []).forEach((sl, slPos) => {
        const slKey = `span:${layerLabel(tkl)}/${sl.name}`;
        layerKeyById.set(sl.id, slKey);
        layers.push({ key: slKey, name: sl.name, position: slPos, config: sl.config || {} });
        (sl.relationLayers || []).forEach((rl, rlPos) => {
          const rlKey = `relation:${layerLabel(tkl)}/${sl.name}/${rl.name}`;
          layerKeyById.set(rl.id, rlKey);
          layers.push({ key: rlKey, name: rl.name, position: rlPos, config: rl.config || {} });
        });
      });
    });
  });

  // ---- vocabularies: items first, since documents refer to them ----------------
  const vocabsRaw = await Promise.all(
    (project.vocabs || []).map((v) => client.vocabLayers.get(v.id, true)),
  );
  const itemKeyById = new Map();
  // A vocabulary key carries its ordinal among the linked vocabularies of that
  // name, as a document key does: core does not make names unique.
  const vocabKeyById = new Map();
  const vocabNameCounts = new Map();
  for (const v of vocabsRaw) {
    const vn = (vocabNameCounts.get(v.name) ?? 0) + 1;
    vocabNameCounts.set(v.name, vn);
    vocabKeyById.set(v.id, `${v.name}#${vn}`);
    const seen = new Map();
    for (const it of v.items || []) {
      const n = (seen.get(it.form) ?? 0) + 1;
      seen.set(it.form, n);
      itemKeyById.set(it.id, `${it.form}#${n}`);
    }
  }
  const itemRef = (id) => (id == null ? null : (itemKeyById.get(id) ?? `missing-item:${id}`));

  // ---- documents ----------------------------------------------------------------
  const docRefs = await client.projects.listDocuments(projectId);
  const docNameById = new Map();
  const tokenKeyById = new Map();
  const spanRefById = new Map();
  const relationRefById = new Map();
  const textRefById = new Map();
  const documents = [];

  const nameCounts = new Map();
  for (const ref of docRefs) {
    const n = (nameCounts.get(ref.name) ?? 0) + 1;
    nameCounts.set(ref.name, n);
    // Every document key carries its ordinal, so a name that itself ends in
    // '#2' cannot collide with the second of two documents sharing a name.
    docNameById.set(ref.id, `${ref.name}#${n}`);
  }

  for (const ref of docRefs) {
    const raw = await client.documents.get(ref.id, true);
    const docName = docNameById.get(ref.id);
    const texts = [];
    const tokens = [];
    const spans = [];
    const relations = [];
    const links = new Map();

    for (const tl of raw.textLayers || []) {
      if (tl.text) {
        textRefById.set(tl.text.id, `${docName}|text:${layerLabel(tl)}`);
        texts.push({
          layer: `text:${layerLabel(tl)}`,
          body: tl.text.body ?? '',
          metadata: tl.text.metadata || {},
        });
      }
      // Tokens get their keys layer by layer before any span or link reads them.
      for (const tkl of tl.tokenLayers || []) {
        const label = layerLabel(tkl);
        const sorted = [...(tkl.tokens || [])].sort(
          (a, b) =>
            a.begin - b.begin ||
            a.end - b.end ||
            (a.precedence ?? 0) - (b.precedence ?? 0) ||
            byString(stableStringify(a.metadata || {}), stableStringify(b.metadata || {})),
        );
        const dup = new Map();
        for (const t of sorted) {
          const base = `${label}:${t.begin}-${t.end}${t.precedence != null ? `@${t.precedence}` : ''}`;
          const n = (dup.get(base) ?? 0) + 1;
          dup.set(base, n);
          const key = n === 1 ? base : `${base}#${n}`;
          tokenKeyById.set(t.id, key);
          tokens.push({
            key,
            layer: `token:${label}`,
            begin: t.begin,
            end: t.end,
            precedence: t.precedence ?? null,
            metadata: t.metadata || {},
          });
        }
      }
      const tokenRef = (id) => tokenKeyById.get(id) ?? `missing-token:${id}`;
      for (const tkl of tl.tokenLayers || []) {
        for (const sl of tkl.spanLayers || []) {
          const layerKey = layerKeyById.get(sl.id) ?? `span:${layerLabel(tkl)}/${sl.name}`;
          for (const s of sl.spans || []) {
            spans.push({
              id: s.id,
              layer: layerKey,
              tokens: (s.tokens || []).map(tokenRef).sort(byString),
              value: s.value ?? null,
              metadata: s.metadata || {},
            });
          }
          for (const rl of sl.relationLayers || []) {
            for (const r of rl.relations || []) {
              relations.push({ layer: layerKeyById.get(rl.id), raw: r });
            }
          }
        }
        for (const v of tkl.vocabs || []) {
          for (const l of v.vocabLinks || []) {
            if (links.has(l.id)) continue;
            links.set(l.id, {
              vocab: vocabKeyById.get(v.id) ?? `missing-vocabulary:${v.id}`,
              item: itemRef(l.vocabItem?.id ?? l.vocabItem),
              tokens: (l.tokens || []).map(tokenRef).sort(byString),
              metadata: l.metadata || {},
            });
          }
        }
      }
    }

    // A span's key is its layer and tokens, plus `#2` and on for a second span
    // in the same field on the same tokens, ordered by value and metadata so
    // the numbering does not depend on ids.
    const spanGroups = new Map();
    for (const sp of spans) {
      const base = `${sp.layer}|${sp.tokens.join(',')}`;
      if (!spanGroups.has(base)) spanGroups.set(base, []);
      spanGroups.get(base).push(sp);
    }
    const snapSpans = [];
    for (const [base, group] of spanGroups) {
      const ordered = sortByKey(group, (sp) => stableStringify([sp.value, sp.metadata]));
      ordered.forEach((sp, i) => {
        const key = i === 0 ? base : `${base}#${i + 1}`;
        spanRefById.set(sp.id, key);
        snapSpans.push({
          key,
          layer: sp.layer,
          tokens: sp.tokens,
          value: sp.value,
          metadata: sp.metadata,
        });
      });
    }

    const snapRelations = relations.map(({ layer, raw: r }) => {
      const ref = `${layer}|${spanRefById.get(r.source) ?? r.source}>${spanRefById.get(r.target) ?? r.target}`;
      relationRefById.set(r.id, ref);
      return {
        layer,
        source: spanRefById.get(r.source) ?? `missing-span:${r.source}`,
        target: spanRefById.get(r.target) ?? `missing-span:${r.target}`,
        value: r.value ?? null,
        metadata: r.metadata || {},
      };
    });

    documents.push({
      key: docName,
      name: ref.name,
      metadata: raw.metadata || {},
      media: raw.mediaUrl ? (media ? await readMedia(client, ref.id) : { present: true }) : null,
      texts: sortByKey(texts, (t) => t.layer),
      tokens: sortByKey(tokens, (t) => t.key),
      spans: sortByKey(snapSpans, (sp) => sp.key),
      relations: sortByKey(snapRelations, stableStringify),
      links: sortByKey([...links.values()], stableStringify),
      comments: [],
    });
  }

  // ---- comments -------------------------------------------------------------------
  const anchorRef = (c) => {
    switch (c.entityType) {
      case 'document':
        return docNameById.get(c.entityId) ?? null;
      case 'text':
        return textRefById.get(c.entityId) ?? null;
      case 'token':
        return tokenKeyById.get(c.entityId) ?? null;
      case 'span':
        return spanRefById.get(c.entityId) ?? null;
      case 'relation':
        return relationRefById.get(c.entityId) ?? null;
      case 'vocab-item':
        return itemKeyById.get(c.entityId) ?? null;
      default:
        return null;
    }
  };
  const snapComment = (c) => ({
    anchor: { type: c.entityType, ref: anchorRef(c) },
    anchorLabel: c.anchorLabel ?? null,
    body: c.body,
    author: c.authorId,
    edited: !!c.edited,
  });
  const docByKey = new Map(documents.map((d) => [d.key, d]));
  const projectComments = await client.comments.list(projectId);
  const unplaced = [];
  for (const c of projectComments) {
    const doc = c.documentId ? docByKey.get(docNameById.get(c.documentId)) : null;
    if (doc) doc.comments.push(snapComment(c));
    else unplaced.push(snapComment(c));
  }
  for (const d of documents) d.comments = sortByKey(d.comments, stableStringify);

  // ---- vocabularies, with ids inside item metadata rewritten --------------------
  const tokenOrMissing = (id) => tokenKeyById.get(id) ?? `missing-token:${id}`;
  const vocabularies = [];
  for (const v of vocabsRaw) {
    const refs = itemFields(v.config);
    const items = (v.items || []).map((it) => {
      const md = { ...(it.metadata || {}) };
      if (md.parent != null) md.parent = itemRef(md.parent);
      for (const [name, many] of refs) {
        if (md[name] == null) continue;
        md[name] = many && Array.isArray(md[name]) ? md[name].map(itemRef) : itemRef(md[name]);
      }
      if (Array.isArray(md.examples)) {
        md.examples = md.examples.map((ex) =>
          ex && typeof ex === 'object' && 'document' in ex
            ? {
                ...ex,
                document: docNameById.get(ex.document) ?? `missing-document:${ex.document}`,
                token: tokenOrMissing(ex.token),
              }
            : ex,
        );
      }
      return { key: itemKeyById.get(it.id), form: it.form, metadata: md };
    });
    const comments = (await client.comments.listInVocab(v.id)).map(snapComment);
    vocabularies.push({
      key: vocabKeyById.get(v.id),
      name: v.name,
      config: v.config || {},
      items,
      comments: sortByKey(comments, stableStringify),
    });
  }

  const guidelines = (await client.guidelines.list(projectId, { includeBodies: true })).map(
    (g) => ({
      title: g.title,
      body: g.body ?? '',
      pinned: !!g.pinned,
    }),
  );

  return {
    name: project.name,
    config: project.config || {},
    layers: sortByKey(layers, (l) => l.key),
    vocabularies: sortByKey(vocabularies, (v) => v.key),
    documents: sortByKey(documents, (d) => d.key),
    // Comments on a project with no document to hold them. Core anchors every
    // project comment to something inside a document today, so this stays
    // empty unless that changes.
    unplacedComments: sortByKey(unplaced, stableStringify),
    guidelines,
  };
}
