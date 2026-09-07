// Compare a sentence graph with its rewritten copy and say what changed, two
// ways: change lines for the preview (a person reads these), and the writes
// that bring the server up to date (the runner executes these). Node ids are
// syntactic-word token ids and edge ids are relation ids, so the address book
// each node carries (spanIds) turns a feature change into a span write.
//
// The graph's root edge runs from the anchor node; the server stores it as a
// self-loop on the root word, so an edge's server source is its target when
// its source is the anchor. Features a rule set on the anchor stay local.
//
// Writes come in three phases the runner keeps in order:
//   tokens        delete the words `del_node` removed (their spans and
//                 relations go with them, so nothing else is written for them)
//   lemmaCreates  lemma spans for words that now need one, because a
//                 dependency hangs on the lemma span and a word may have
//                 gained one without ever having a lemma
//   main          every other span and relation write; relation creates and
//                 endpoint moves name their words, and the runner resolves a
//                 word to its lemma span (existing or just created)

import { liveNodes, ANCHOR } from './graph.js';

const COLUMN_LAYER = {
  form: 'formLayer',
  lemma: 'lemmaLayer',
  upos: 'uposLayer',
  xpos: 'xposLayer',
};

export function diffGraphs(before, after, layerInfo) {
  const changes = [];
  const writes = { tokens: [], lemmaCreates: [], main: [] };
  const warnings = [];
  const layer = (key) => layerInfo[key]?.id;
  const formOf = (g, id) => (id === ANCHOR ? '(root)' : (g.nodes.get(id)?.form ?? '?'));
  const serverSrc = (e) => (e.src === ANCHOR ? e.tgt : e.src);
  const deleted = new Set();

  // --- words ---
  for (const id of before.order) {
    const b = before.nodes.get(id);
    const a = after.nodes.get(id);
    if (b.deleted || b.anchor) continue;
    if (a.deleted) {
      deleted.add(id);
      changes.push({ kind: 'node', node: id, text: `${b.form}: word deleted` });
      // A one-word token goes with its word; a multi-word token keeps its
      // other words and loses just this one.
      writes.tokens.push({ op: 'deleteToken', id: b.wordId && !b.wordHasMultiple ? b.wordId : id });
      continue;
    }
    for (const col of ['form', 'lemma', 'upos', 'xpos']) {
      if (a[col] === b[col]) continue;
      changes.push({
        kind: 'feat',
        node: id,
        text: `${b.form}: ${col} ${describe(b[col])} → ${describe(a[col])}`,
      });
      if (col === 'lemma' && a.lemma === undefined) {
        writes.main.push({ op: 'deleteSpan', id: b.spanIds.lemma });
        continue;
      }
      if (col === 'lemma' && !b.spanIds.lemma) continue; // created below, with its value
      columnWrite(writes.main, b, col, a[col], layer(COLUMN_LAYER[col]));
    }
    const keys = new Set([...b.feats.keys(), ...a.feats.keys()]);
    for (const key of [...keys].sort()) {
      const bv = b.feats.get(key);
      const av = a.feats.get(key);
      if (bv === av) continue;
      const spanId = b.spanIds.features.get(key);
      if (av === undefined) {
        changes.push({ kind: 'feat', node: id, text: `${b.form}: ${key}=${bv} removed` });
        writes.main.push({ op: 'deleteSpan', id: spanId });
      } else if (bv === undefined) {
        changes.push({ kind: 'feat', node: id, text: `${b.form}: ${key}=${av} added` });
        writes.main.push({
          op: 'createSpan',
          layer: layer('featuresLayer'),
          tokens: [id],
          value: `${key}=${av}`,
        });
      } else {
        changes.push({ kind: 'feat', node: id, text: `${b.form}: ${key} ${bv} → ${av}` });
        writes.main.push({
          op: 'updateSpan',
          id: spanId,
          value: `${key}=${av}`,
          metadata: b.spanMeta.features.get(key),
        });
      }
    }
  }

  // --- edges ---
  const touchesDeleted = (e) => deleted.has(e.src) || deleted.has(e.tgt);
  const needsLemma = new Set();
  for (const [id, b] of before.edges) {
    const a = after.edges.get(id);
    if (!a) {
      if (touchesDeleted(b)) continue; // cascades with the word
      changes.push({
        kind: 'edge',
        text: `${formOf(before, b.src)} → ${formOf(before, b.tgt)}: ${b.label} removed`,
      });
      writes.main.push({ op: 'deleteRelation', id });
      continue;
    }
    if (a.label !== b.label) {
      changes.push({
        kind: 'edge',
        text: `${formOf(after, a.src)} → ${formOf(after, a.tgt)}: ${b.label} → ${a.label}`,
      });
      writes.main.push({ op: 'updateRelation', id, value: a.label, metadata: b.metadata });
    }
    if (a.src !== b.src) {
      changes.push({
        kind: 'edge',
        text: `${a.label} of ${formOf(after, a.tgt)}: head ${formOf(before, b.src)} → ${formOf(after, a.src)}`,
      });
    }
    if (a.tgt !== b.tgt) {
      changes.push({
        kind: 'edge',
        text: `${a.label} from ${formOf(after, a.src)}: ${formOf(before, b.tgt)} → ${formOf(after, a.tgt)}`,
      });
      writes.main.push({ op: 'setTarget', id, node: a.tgt });
      needsLemma.add(a.tgt);
    }
    if (serverSrc(a) !== serverSrc(b)) {
      writes.main.push({ op: 'setSource', id, node: serverSrc(a) });
      needsLemma.add(serverSrc(a));
    }
  }
  for (const [id, a] of after.edges) {
    if (before.edges.has(id)) continue;
    changes.push({
      kind: 'edge',
      text: `${formOf(after, a.src)} → ${formOf(after, a.tgt)}: ${a.label} added`,
    });
    writes.main.push({
      op: 'createRelation',
      layer: layer('relationLayer'),
      src: serverSrc(a),
      tgt: a.tgt,
      value: a.label,
    });
    needsLemma.add(serverSrc(a));
    needsLemma.add(a.tgt);
  }

  // --- lemma spans that must exist first ---
  for (const n of liveNodes(after)) {
    if (n.anchor) continue;
    const b = before.nodes.get(n.id);
    const gained = b.lemma === undefined && n.lemma !== undefined;
    if (b.spanIds.lemma || !(gained || needsLemma.has(n.id))) continue;
    const value = n.lemma ?? n.substring;
    if (!gained)
      changes.push({ kind: 'feat', node: n.id, text: `${b.form}: lemma ${value} added` });
    writes.lemmaCreates.push({
      op: 'createSpan',
      layer: layer('lemmaLayer'),
      tokens: [n.id],
      value,
      node: n.id,
    });
  }

  // --- what Grew allows and UD does not: heads among words, as the editor counts ---
  const heads = new Map();
  for (const e of after.edges.values())
    if (e.src !== ANCHOR) heads.set(e.tgt, (heads.get(e.tgt) || 0) + 1);
  for (const [id, n] of heads) if (n > 1) warnings.push(`${formOf(after, id)} has ${n} heads.`);

  return { changes, writes, warnings };
}

// A span write for one column value on a word.
function columnWrite(list, node, col, value, layerId) {
  const spanId = node.spanIds[col];
  if (value === undefined) {
    if (spanId) list.push({ op: 'deleteSpan', id: spanId });
    return;
  }
  // The Form span exists only while the form differs from the text.
  if (col === 'form' && value === node.substring) {
    if (spanId) list.push({ op: 'deleteSpan', id: spanId });
    return;
  }
  if (spanId) list.push({ op: 'updateSpan', id: spanId, value, metadata: node.spanMeta[col] });
  else list.push({ op: 'createSpan', layer: layerId, tokens: [node.id], value });
}

const describe = (v) => (v === undefined ? '(none)' : String(v));
