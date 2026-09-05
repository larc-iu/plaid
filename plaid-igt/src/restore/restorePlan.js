// Restoring a document to an earlier point, planned as a diff between two
// states of the SAME document: the live one and the one the server reports
// as of a time T. Both carry real ids, and an entity alive at T that is still
// alive now has the same id, so the diff is keyed by id.
//
// The plan is applied in layer order, text first, and every phase is planned
// against a FRESH read of the document (restoreRunner.js), because core
// cascades one layer's change into the next (a text edit reindexes tokens, a
// word resize trims its morphemes, a sentence boundary move splits the word
// under it). Each planner here is pure: (current, target) -> operations.
//
// Only the IGT layers are planned: the baseline text, the sentence / word /
// morpheme / time-alignment token layers, their span layers, and vocabulary
// links. Another app's layers in a shared project are left alone, and feel
// the restore only through the substrate they share.

import { cpLength } from '@larc-iu/plaid-client';
import {
  findBaselineTextLayer,
  findSentenceTokenLayer,
  findWordTokenLayer,
  findMorphemeTokenLayer,
  findAlignmentTokenLayer,
} from '../domain/igtConfig.js';

export const LAYER_ROLES = ['sentence', 'word', 'morpheme', 'alignment'];

const FINDERS = {
  sentence: findSentenceTokenLayer,
  word: findWordTokenLayer,
  morpheme: findMorphemeTokenLayer,
  alignment: findAlignmentTokenLayer,
};

const cleanMeta = (m) => {
  if (!m || typeof m !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(m)) if (v !== undefined) out[k] = v;
  return out;
};

// Canonical JSON: key order is not a difference.
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(',')}}`;
}

export const metaEqual = (a, b) => stableStringify(cleanMeta(a)) === stableStringify(cleanMeta(b));
const hasMeta = (m) => Object.keys(cleanMeta(m)).length > 0;

const sameIdSet = (a, b) => {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
};

// ---- indexing ---------------------------------------------------------------

/**
 * The parts of a raw document the restore reasons about, keyed for lookup.
 * `layers[role]` is null when the project has no such layer.
 */
export function indexDocument(raw) {
  const textLayer = findBaselineTextLayer(raw?.textLayers || []) || null;
  const tokenLayers = textLayer?.tokenLayers || [];
  const tokens = new Map();
  const spans = new Map();
  const links = new Map();
  const layers = {};
  for (const role of LAYER_ROLES) {
    const tl = FINDERS[role](tokenLayers) || null;
    if (!tl) {
      layers[role] = null;
      continue;
    }
    const layer = {
      id: tl.id,
      role,
      overlapMode: tl.overlapMode ?? 'any',
      parentTokenLayer: tl.parentTokenLayer ?? null,
      tokens: new Map(),
      spanLayers: [],
    };
    for (const t of tl.tokens || []) {
      const rec = {
        id: t.id,
        role,
        layerId: tl.id,
        begin: t.begin,
        end: t.end,
        precedence: t.precedence ?? null,
        metadata: cleanMeta(t.metadata),
      };
      layer.tokens.set(t.id, rec);
      tokens.set(t.id, rec);
    }
    for (const sl of tl.spanLayers || []) {
      const spanLayer = { id: sl.id, name: sl.name, tokenRole: role, spans: new Map() };
      for (const s of sl.spans || []) {
        const rec = {
          id: s.id,
          layerId: sl.id,
          layerName: sl.name,
          tokens: [...(s.tokens || [])],
          value: s.value ?? null,
          metadata: cleanMeta(s.metadata),
        };
        spanLayer.spans.set(s.id, rec);
        spans.set(s.id, rec);
      }
      layer.spanLayers.push(spanLayer);
    }
    for (const v of tl.vocabs || []) {
      for (const l of v.vocabLinks || []) {
        const itemId = l.vocabItem?.id ?? l.vocabItem ?? null;
        links.set(l.id, {
          id: l.id,
          vocabId: v.id,
          itemId,
          itemForm: l.vocabItem?.form ?? null,
          tokens: [...(l.tokens || [])],
          metadata: cleanMeta(l.metadata),
        });
      }
    }
    layers[role] = layer;
  }
  const text = textLayer?.text
    ? {
        id: textLayer.text.id,
        body: textLayer.text.body ?? '',
        metadata: cleanMeta(textLayer.text.metadata),
      }
    : null;
  return {
    id: raw?.id ?? null,
    name: raw?.name ?? null,
    version: raw?.version ?? null,
    metadata: cleanMeta(raw?.metadata),
    textLayerId: textLayer?.id ?? null,
    text,
    layers,
    tokens,
    spans,
    links,
  };
}

// ---- text -------------------------------------------------------------------

/**
 * The one text operation, or null. A string body is diffed by the server at
 * code-point level, which reindexes the tokens and gap-fills the sentence
 * partition; the later phases correct whatever that leaves.
 */
export function planText(cur, tgt) {
  if (tgt.text && cur.text) {
    return tgt.text.body === cur.text.body
      ? null
      : { kind: 'update', textId: cur.text.id, body: tgt.text.body };
  }
  if (tgt.text && !cur.text) {
    return {
      kind: 'create',
      textLayerId: tgt.textLayerId ?? cur.textLayerId,
      body: tgt.text.body,
      metadata: hasMeta(tgt.text.metadata) ? tgt.text.metadata : null,
    };
  }
  if (!tgt.text && cur.text) return { kind: 'delete', textId: cur.text.id };
  return null;
}

// ---- the sentence partition -------------------------------------------------

const sorted = (layer) => [...(layer?.tokens.values() || [])].sort((a, b) => a.begin - b.begin);

/**
 * Bring a partitioning layer to the target tiling. Core forbids creating,
 * deleting or resizing one partition token on its own, so the tiling is
 * edited by its boundaries: a boundary that moved is shifted (the neighbor
 * follows), one that is gone is merged away (the left token survives), one
 * that is new is split in. Survivors keep their ids wherever a boundary
 * merely moved. Emitted in that order; the runner applies them one at a
 * time, since each split mints an id the next op may need (`{ref}`).
 *
 * Requires both bodies to have the same length, which is what the text
 * phase leaves behind. An empty layer is built or emptied in one bulk call.
 */
export function planPartition(cur, tgt, role = 'sentence') {
  const curL = cur.layers[role];
  const tgtL = tgt.layers[role];
  if (!curL || !tgtL) return { ops: [], bulkDelete: [], bulkCreate: [] };
  const curToks = sorted(curL);
  const tgtToks = sorted(tgtL);
  if (tgtToks.length === 0) {
    return { ops: [], bulkDelete: curToks.map((t) => t.id), bulkCreate: [] };
  }
  if (curToks.length === 0) {
    return {
      ops: [],
      bulkDelete: [],
      bulkCreate: tgtToks.map((t) => ({
        tid: t.id,
        begin: t.begin,
        end: t.end,
        precedence: t.precedence,
        metadata: t.metadata,
      })),
    };
  }
  const interior = (toks) => toks.slice(1).map((t) => t.begin);
  const bCur = new Set(interior(curToks));
  const bTgt = new Set(interior(tgtToks));
  // Every boundary, tagged by which side has it.
  const all = [...new Set([...bCur, ...bTgt])].sort((a, b) => a - b);
  const only = all.filter((p) => !(bCur.has(p) && bTgt.has(p)));
  const side = (p) => (bCur.has(p) ? 'cur' : 'tgt');
  // A moved boundary: a cur-only and a tgt-only boundary with nothing between.
  const pairs = [];
  const used = new Set();
  for (let i = 0; i + 1 < only.length; i++) {
    const a = only[i];
    const b = only[i + 1];
    if (used.has(a) || side(a) === side(b)) continue;
    // Nothing of either set lies between a and b: they are adjacent among ALL
    // boundaries too.
    const ia = all.indexOf(a);
    if (all[ia + 1] !== b) continue;
    pairs.push(side(a) === 'cur' ? [a, b] : [b, a]);
    used.add(a);
    used.add(b);
  }

  // Simulate on a working copy so later ops name tokens that still exist.
  const work = curToks.map((t) => ({ id: t.id, begin: t.begin, end: t.end }));
  const at = (pos) => work.find((t) => t.begin === pos);
  const endingAt = (pos) => work.find((t) => t.end === pos);
  const ops = [];
  for (const [x, y] of pairs) {
    if (x < y) {
      const left = endingAt(x);
      const right = at(x);
      ops.push({ op: 'shift', id: left.id, end: y });
      left.end = y;
      right.begin = y;
    } else {
      const right = at(x);
      const left = endingAt(x);
      ops.push({ op: 'shift', id: right.id, begin: y });
      right.begin = y;
      left.end = y;
    }
  }
  const remainingCur = [...bCur].filter((p) => !bTgt.has(p) && !used.has(p)).sort((a, b) => a - b);
  for (const x of remainingCur) {
    const left = endingAt(x);
    const right = at(x);
    ops.push({ op: 'merge', left: left.id, right: right.id });
    left.end = right.end;
    work.splice(work.indexOf(right), 1);
  }
  const remainingTgt = [...bTgt].filter((p) => !bCur.has(p) && !used.has(p)).sort((a, b) => a - b);
  let refN = 0;
  for (const y of remainingTgt) {
    const host = work.find((t) => t.begin < y && y < t.end);
    const ref = `split${refN++}`;
    ops.push({ op: 'split', id: host.id, position: y, ref });
    work.push({ id: { ref }, begin: y, end: host.end });
    host.end = y;
  }
  return { ops, bulkDelete: [], bulkCreate: [] };
}

// ---- non-partitioning layers ------------------------------------------------

const overlaps = (a, b) => a.begin < b.end && b.begin < a.end;
const sameExtent = (a, b) =>
  a.begin === b.begin && a.end === b.end && (a.precedence ?? null) === (b.precedence ?? null);

/**
 * Bring one token layer to the target set. A token alive on both sides is
 * patched to its target extent and precedence. One gone since T is adopted
 * when a token born since T stands at exactly its place (same extent and
 * precedence), and created again otherwise (new id); every adoption is
 * recorded in `idMap`, T id to the id now. One born since T that nothing
 * adopts is deleted, which cascades what sat on it.
 *
 * On a non-overlapping layer the patches are ordered so no intermediate
 * state overlaps: a token is patched only once nothing else still occupies
 * its target extent. A cycle (two tokens swapping places) is broken by
 * recreating one of them.
 */
export function planLayer(cur, tgt, role, idMap = new Map()) {
  const curL = cur.layers[role];
  const tgtL = tgt.layers[role];
  const empty = { deletes: [], patches: [], creates: [], metadata: [] };
  if (!curL || !tgtL) return empty;
  const deletes = [];
  const patches = [];
  const creates = [];
  const metadata = [];
  const pending = new Map(); // survivors needing an extent change
  const placeKey = (t) => `${t.begin}-${t.end}:${t.precedence ?? ''}`;
  const bornByPlace = new Map();
  for (const c of curL.tokens.values()) {
    if (tgtL.tokens.has(c.id)) continue;
    const k = placeKey(c);
    if (!bornByPlace.has(k)) bornByPlace.set(k, []);
    bornByPlace.get(k).push(c);
  }
  const noteMeta = (id, c, t) => {
    if (!metaEqual(c.metadata, t.metadata)) {
      metadata.push({ id, metadata: hasMeta(t.metadata) ? t.metadata : null });
    }
  };
  for (const t of tgtL.tokens.values()) {
    const c = curL.tokens.get(t.id);
    if (c) {
      if (!sameExtent(c, t)) pending.set(t.id, { cur: c, tgt: t });
      noteMeta(t.id, c, t);
      continue;
    }
    const standing = bornByPlace.get(placeKey(t))?.shift();
    if (standing) {
      idMap.set(t.id, standing.id);
      noteMeta(standing.id, standing, t);
      continue;
    }
    creates.push({
      tid: t.id,
      begin: t.begin,
      end: t.end,
      precedence: t.precedence,
      metadata: t.metadata,
    });
  }
  for (const left of bornByPlace.values()) for (const c of left) deletes.push(c.id);
  if (curL.overlapMode === 'non-overlapping') {
    // Extents still occupied: every survivor at its current place, minus the
    // deletes (they go first).
    const deleted = new Set(deletes);
    const occupied = new Map();
    for (const c of curL.tokens.values()) {
      if (!deleted.has(c.id)) occupied.set(c.id, { begin: c.begin, end: c.end });
    }
    while (pending.size) {
      let picked = null;
      for (const [id, p] of pending) {
        let free = true;
        for (const [oid, ext] of occupied) {
          if (oid !== id && overlaps(ext, p.tgt)) {
            free = false;
            break;
          }
        }
        if (free) {
          picked = id;
          break;
        }
      }
      if (picked == null) {
        // A cycle: recreate the earliest one instead of moving it.
        const [id, p] = [...pending.entries()].sort((a, b) => a[1].tgt.begin - b[1].tgt.begin)[0];
        pending.delete(id);
        occupied.delete(id);
        deletes.push(id);
        creates.push({
          tid: id,
          begin: p.tgt.begin,
          end: p.tgt.end,
          precedence: p.tgt.precedence,
          metadata: p.tgt.metadata,
        });
        // Its metadata rides the create.
        const mi = metadata.findIndex((m) => m.id === id);
        if (mi >= 0) metadata.splice(mi, 1);
        continue;
      }
      const p = pending.get(picked);
      pending.delete(picked);
      occupied.set(picked, { begin: p.tgt.begin, end: p.tgt.end });
      patches.push(patchOf(picked, p.cur, p.tgt));
    }
  } else {
    for (const [id, p] of pending) patches.push(patchOf(id, p.cur, p.tgt));
  }
  return { deletes, patches, creates, metadata };
}

const patchOf = (id, c, t) => ({
  id,
  begin: t.begin !== c.begin ? t.begin : undefined,
  end: t.end !== c.end ? t.end : undefined,
  precedence:
    (t.precedence ?? null) !== (c.precedence ?? null) ? (t.precedence ?? null) : undefined,
});

// ---- spans and links --------------------------------------------------------

/**
 * A token id as of T, resolved to the id it has now: the same id when the
 * token survived, the new id when it was recreated, null when nothing stands
 * for it (the caller skips and reports).
 */
export const makeTokenResolver = (cur, idMap) => (tid) =>
  idMap.get(tid) ?? (cur.tokens.has(tid) ? tid : null);

const resolveAll = (ids, resolve) => {
  const out = [];
  for (const id of ids) {
    const r = resolve(id);
    if (!r) return null;
    out.push(r);
  }
  return out;
};

/**
 * Bring the IGT span layers to the target set. A span alive on both sides is
 * patched (value, token set, metadata). One gone since T is adopted when a
 * span born since T sits on the same tokens in the same layer, and created
 * again otherwise; one born that nothing adopts is deleted.
 */
export function planSpans(cur, tgt, idMap) {
  const resolve = makeTokenResolver(cur, idMap);
  const deletes = [];
  const creates = [];
  const updates = [];
  const retokens = [];
  const metadata = [];
  const unresolved = [];
  const placeKey = (layerId, tokens) => `${layerId}|${[...tokens].sort().join(',')}`;
  const bornByPlace = new Map();
  for (const c of cur.spans.values()) {
    if (tgt.spans.has(c.id)) continue;
    const k = placeKey(c.layerId, c.tokens);
    if (!bornByPlace.has(k)) bornByPlace.set(k, []);
    bornByPlace.get(k).push(c);
  }
  const patch = (c, t, tokens) => {
    if ((c.value ?? null) !== (t.value ?? null)) updates.push({ id: c.id, value: t.value });
    if (tokens && !sameIdSet(c.tokens, tokens)) retokens.push({ id: c.id, tokens });
    if (!metaEqual(c.metadata, t.metadata)) {
      metadata.push({ id: c.id, metadata: hasMeta(t.metadata) ? t.metadata : null });
    }
  };
  for (const t of tgt.spans.values()) {
    const tokens = resolveAll(t.tokens, resolve);
    const c = cur.spans.get(t.id);
    if (c) {
      patch(c, t, tokens);
      if (!tokens)
        unresolved.push({ kind: 'span', id: t.id, layerName: t.layerName, value: t.value });
      continue;
    }
    if (!tokens) {
      unresolved.push({ kind: 'span', id: t.id, layerName: t.layerName, value: t.value });
      continue;
    }
    const standing = bornByPlace.get(placeKey(t.layerId, tokens))?.shift();
    if (standing) {
      patch(standing, t, tokens);
      continue;
    }
    creates.push({
      sid: t.id,
      spanLayerId: t.layerId,
      tokens,
      value: t.value,
      metadata: t.metadata,
    });
  }
  for (const left of bornByPlace.values()) for (const c of left) deletes.push(c.id);
  return { deletes, creates, updates, retokens, metadata, unresolved };
}

/**
 * Bring the vocabulary links to the target set. A link has no update call,
 * so one whose entry or tokens differ is deleted and created again; a link
 * born since T on the same entry and tokens as one gone since T is adopted.
 */
export function planLinks(cur, tgt, idMap) {
  const resolve = makeTokenResolver(cur, idMap);
  const deletes = [];
  const creates = [];
  const metadata = [];
  const unresolved = [];
  const placeKey = (itemId, tokens) => `${itemId}|${[...tokens].sort().join(',')}`;
  const bornByPlace = new Map();
  for (const c of cur.links.values()) {
    if (tgt.links.has(c.id)) continue;
    const k = placeKey(c.itemId, c.tokens);
    if (!bornByPlace.has(k)) bornByPlace.set(k, []);
    bornByPlace.get(k).push(c);
  }
  const noteMeta = (c, t) => {
    if (!metaEqual(c.metadata, t.metadata)) {
      metadata.push({ id: c.id, metadata: hasMeta(t.metadata) ? t.metadata : null });
    }
  };
  const create = (t, tokens) => {
    if (!tokens) {
      unresolved.push({ kind: 'link', id: t.id, itemForm: t.itemForm });
      return;
    }
    const standing = bornByPlace.get(placeKey(t.itemId, tokens))?.shift();
    if (standing) {
      noteMeta(standing, t);
      return;
    }
    creates.push({
      lid: t.id,
      itemId: t.itemId,
      itemForm: t.itemForm,
      tokens,
      metadata: t.metadata,
    });
  };
  for (const t of tgt.links.values()) {
    const tokens = resolveAll(t.tokens, resolve);
    const c = cur.links.get(t.id);
    if (!c) {
      create(t, tokens);
      continue;
    }
    if (c.itemId !== t.itemId || !tokens || !sameIdSet(c.tokens, tokens)) {
      deletes.push(c.id);
      create(t, tokens);
      continue;
    }
    noteMeta(c, t);
  }
  for (const left of bornByPlace.values()) for (const c of left) deletes.push(c.id);
  return { deletes, creates, metadata, unresolved };
}

// ---- document and text metadata ---------------------------------------------

export function planMetadata(cur, tgt) {
  const out = { document: undefined, text: undefined };
  if (!metaEqual(cur.metadata, tgt.metadata)) {
    out.document = hasMeta(tgt.metadata) ? tgt.metadata : null;
  }
  if (cur.text && tgt.text && !metaEqual(cur.text.metadata, tgt.text.metadata)) {
    out.text = hasMeta(tgt.text.metadata) ? tgt.text.metadata : null;
  }
  return out;
}

// ---- the id map after a phase -----------------------------------------------

/**
 * After a partition phase, match the target tokens to the fresh state by
 * extent (unique in a partition) and record the ones that came back under a
 * new id.
 */
export function mapPartitionIds(fresh, tgt, idMap, role = 'sentence') {
  const freshL = fresh.layers[role];
  const tgtL = tgt.layers[role];
  if (!freshL || !tgtL) return;
  const byExtent = new Map();
  for (const t of freshL.tokens.values()) byExtent.set(`${t.begin}-${t.end}`, t.id);
  for (const t of tgtL.tokens.values()) {
    const now = byExtent.get(`${t.begin}-${t.end}`);
    if (now && now !== t.id) idMap.set(t.id, now);
  }
}

// ---- the self-check ---------------------------------------------------------

const extentDesc = (idx, tid) => {
  const t = idx.tokens.get(tid);
  if (!t) return `missing:${tid}`;
  return `${t.role}:${t.begin}-${t.end}${t.precedence != null ? `:${t.precedence}` : ''}`;
};

const byJson = (a, b) => stableStringify(a).localeCompare(stableStringify(b));

/**
 * An id-free picture of the document's IGT content, so two states compare
 * by what a person would see. Comments are not in it: they are unaudited,
 * and a restore neither moves nor removes them.
 */
export function normalizeState(idx) {
  const layers = {};
  for (const role of LAYER_ROLES) {
    const L = idx.layers[role];
    layers[role] = L
      ? [...L.tokens.values()]
          .map((t) => ({
            begin: t.begin,
            end: t.end,
            precedence: t.precedence ?? null,
            metadata: t.metadata,
          }))
          .sort(byJson)
      : null;
  }
  const spans = [...idx.spans.values()]
    .map((s) => ({
      layer: s.layerName,
      tokens: s.tokens.map((tid) => extentDesc(idx, tid)).sort(),
      value: s.value,
      metadata: s.metadata,
    }))
    .sort(byJson);
  const links = [...idx.links.values()]
    .map((l) => ({
      item: l.itemId,
      tokens: l.tokens.map((tid) => extentDesc(idx, tid)).sort(),
      metadata: l.metadata,
    }))
    .sort(byJson);
  return {
    metadata: idx.metadata,
    body: idx.text?.body ?? null,
    textMetadata: idx.text?.metadata ?? null,
    layers,
    spans,
    links,
  };
}

/**
 * How two normalized states differ, in a handful of bounded lines. Empty
 * when they are the same.
 */
export function compareStates(a, b, limit = 8) {
  const out = [];
  const t = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const s = (v) => String(JSON.stringify(v)).slice(0, 80);
  (function walk(x, y, path) {
    if (out.length >= limit || x === y) return;
    if (t(x) !== t(y)) return void out.push(`${path}: ${s(x)} vs ${s(y)}`);
    if (t(x) === 'array') {
      if (x.length !== y.length) out.push(`${path}: ${x.length} vs ${y.length} entries`);
      for (let i = 0; i < Math.min(x.length, y.length) && out.length < limit; i++) {
        walk(x[i], y[i], `${path}[${i}]`);
      }
      return;
    }
    if (t(x) === 'object') {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (out.length >= limit) return;
        if (!(k in x)) out.push(`${path}.${k}: missing now`);
        else if (!(k in y)) out.push(`${path}.${k}: missing at the target`);
        else walk(x[k], y[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    out.push(`${path}: ${s(x)} vs ${s(y)}`);
  })(a, b, '');
  return out;
}

// ---- the preview ------------------------------------------------------------

/**
 * What a restore would change, counted from the two states as they stand.
 * Later phases are re-planned against fresh reads, so these are the counts
 * of the first plan, which is what a person confirms.
 */
export function summarizeRestore(cur, tgt) {
  const text = planText(cur, tgt);
  const partition = planPartition(cur, tgt);
  const idMap = new Map();
  mapPartitionIds(cur, tgt, idMap);
  const layers = {};
  for (const role of ['word', 'morpheme', 'alignment']) {
    const p = planLayer(cur, tgt, role, idMap);
    // A token to be created stands for itself once it exists.
    for (const c of p.creates) idMap.set(c.tid, c.tid);
    layers[role] = p.deletes.length + p.patches.length + p.creates.length + p.metadata.length;
  }
  const withCreated = { ...cur, tokens: { has: (id) => cur.tokens.has(id) || idMap.has(id) } };
  layers.sentence =
    partition.ops.length + partition.bulkDelete.length + partition.bulkCreate.length;
  const sp = planSpans(withCreated, tgt, idMap);
  const annotations =
    sp.deletes.length +
    sp.creates.length +
    sp.updates.length +
    sp.retokens.length +
    sp.metadata.length;
  const lk = planLinks(withCreated, tgt, idMap);
  const links = lk.deletes.length + lk.creates.length + lk.metadata.length;
  const metadata = planMetadata(cur, tgt);
  return {
    text: !!text,
    sentences: layers.sentence,
    words: layers.word,
    morphemes: layers.morpheme,
    alignments: layers.alignment,
    annotations,
    links,
    metadata: metadata.document !== undefined || metadata.text !== undefined,
    total:
      (text ? 1 : 0) +
      layers.sentence +
      layers.word +
      layers.morpheme +
      layers.alignment +
      annotations +
      links,
  };
}

export const textLength = (idx) => cpLength(idx.text?.body ?? '');
