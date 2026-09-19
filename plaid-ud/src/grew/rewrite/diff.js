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
import { GrewRuntimeError } from '../errors.js';
import { isEnhancedLabel, bareLabel } from '../edgeLabel.js';
import { SUPPRESS_KEY } from '../../domain/enhancedGraph.js';

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
        // A cleared lemma keeps its span, with no value. The span is the
        // tree's node, so deleting it takes the word's relations with it on
        // the server, and the writes that follow name relations that are
        // already gone, or hang a new edge on a span that is. The editor's
        // own cell does the same (ConlluDocument.setColumn).
        writes.main.push({
          op: 'updateSpan',
          id: b.spanIds.lemma,
          value: null,
          metadata: b.spanMeta.lemma,
        });
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

  // A word token goes when the last of its syntactic words does: left
  // standing it holds a stretch of text with nothing said about it, and the
  // next open seeds a bare word back into the grid. One syntactic word of a
  // multi-word token going leaves the token, and its other words, alone.
  {
    const wordCounts = new Map();
    for (const id of before.order) {
      const b = before.nodes.get(id);
      if (b.deleted || b.anchor || !b.wordId) continue;
      wordCounts.set(b.wordId, (wordCounts.get(b.wordId) || 0) + 1);
    }
    const goneCounts = new Map();
    for (const id of deleted) {
      const wordId = before.nodes.get(id)?.wordId;
      if (wordId) goneCounts.set(wordId, (goneCounts.get(wordId) || 0) + 1);
    }
    for (const id of deleted) {
      const b = before.nodes.get(id);
      const wholeWord = b.wordId && goneCounts.get(b.wordId) === wordCounts.get(b.wordId);
      if (wholeWord && writes.tokens.some((w) => w.id === b.wordId)) continue;
      writes.tokens.push({ op: 'deleteToken', id: wholeWord ? b.wordId : id });
    }
  }

  // --- edges ---
  // An edge labelled `E:` lives in the enhanced layer and any other in the
  // tree's, under the bare deprel either way (edgeLabel.js).
  const touchesDeleted = (e) => deleted.has(e.src) || deleted.has(e.tgt);
  const needsLemma = new Set();
  // An enhanced edge says something only against the tree as the rule LEFT it,
  // and against the other extras landing beside it, so every extra a rule
  // creates, relabels or moves is settled once every edge has been read
  // (below). An entry carries what to write if the edge stands, and `row`, the
  // stored relation behind it, which is what a drop deletes and what a line
  // about a drop names: an edge that moved is not gone from where it lands,
  // it is gone from where it was.
  const pendingExtras = [];
  const layerIdOf = (key, what) => {
    const id = layer(key);
    if (!id) throw new GrewRuntimeError(`This project has no ${what} layer.`);
    return id;
  };
  const enhancedLayerId = () => {
    if (!layer('enhancedRelationLayer')) {
      throw new GrewRuntimeError(
        'This project has no enhanced dependency layer yet. One is added the first time a maintainer opens a document in it.',
      );
    }
    return layer('enhancedRelationLayer');
  };
  const basicLayerId = () => layerIdOf('relationLayer', 'dependency relation');
  const writeCreate = (a, layerId, extra = {}) => {
    writes.main.push({
      op: 'createRelation',
      layer: layerId,
      src: serverSrc(a),
      tgt: a.tgt,
      value: bareLabel(a.label),
      ...extra,
    });
    needsLemma.add(serverSrc(a));
    needsLemma.add(a.tgt);
  };
  const emit = (lines, ops, needs = []) => {
    for (const text of lines) changes.push({ kind: 'edge', text });
    writes.main.push(...ops);
    for (const n of needs) needsLemma.add(n);
  };
  const pairOf = (e) => `${e.src}>${e.tgt}`;
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
    const lines = [];
    if (a.label !== b.label) {
      lines.push(`${formOf(after, a.src)} → ${formOf(after, a.tgt)}: ${b.label} → ${a.label}`);
    }
    if (a.src !== b.src) {
      lines.push(
        `${a.label} of ${formOf(after, a.tgt)}: head ${formOf(before, b.src)} → ${formOf(after, a.src)}`,
      );
    }
    if (a.tgt !== b.tgt) {
      lines.push(
        `${a.label} from ${formOf(after, a.src)}: ${formOf(before, b.tgt)} → ${formOf(after, a.tgt)}`,
      );
    }
    // The relation as it stands on the server now, which is where it is drawn
    // and what a drop takes away.
    const row = {
      id,
      label: b.label,
      src: formOf(before, b.src),
      tgt: formOf(before, b.tgt),
    };
    // A relation never changes layers, so an edge that changed graphs
    // (`e.enhanced = yes`) is deleted from one and created in the other.
    if (isEnhancedLabel(a.label) !== isEnhancedLabel(b.label)) {
      const del = [{ op: 'deleteRelation', id }];
      if (isEnhancedLabel(a.label)) {
        pendingExtras.push({ a, lines, layerId: enhancedLayerId(), create: true, ops: del, row });
      } else {
        emit(lines, del);
        writeCreate(a, basicLayerId());
      }
      continue;
    }
    const ops = [];
    const needs = [];
    if (a.label !== b.label) {
      ops.push({ op: 'updateRelation', id, value: bareLabel(a.label), metadata: b.metadata });
    }
    if (a.tgt !== b.tgt) {
      ops.push({ op: 'setTarget', id, node: a.tgt });
      needs.push(a.tgt);
    }
    if (serverSrc(a) !== serverSrc(b)) {
      ops.push({ op: 'setSource', id, node: serverSrc(a) });
      needs.push(serverSrc(a));
    }
    // An extra the rule left alone is left alone: only what it touched is
    // settled against the tree.
    if (isEnhancedLabel(a.label) && ops.length) {
      pendingExtras.push({ a, lines, layerId: enhancedLayerId(), ops, needs, row });
      continue;
    }
    emit(lines, ops, needs);
  }
  for (const [id, a] of after.edges) {
    if (before.edges.has(id)) continue;
    const line = `${formOf(after, a.src)} → ${formOf(after, a.tgt)}: ${a.label} added`;
    if (isEnhancedLabel(a.label)) {
      pendingExtras.push({ a, lines: [line], layerId: enhancedLayerId(), create: true, row: null });
      continue;
    }
    emit([line], []);
    writeCreate(a, basicLayerId());
  }

  // --- the extra edges a rule touched, pair by pair ---
  // Over a pair the tree joins (as the rule left it), an extra edge is what
  // it is when drawn in the editor (ConlluDocument.createEnhancedRelation):
  //   the tree's own label   nothing to store. The enhanced graph has that
  //                          edge from the tree, unless the pair is suppressed,
  //                          and a stored copy would be a second copy of one
  //                          edge (DEPS names each head once).
  //   another label          a RELABEL. The new edge stands in place of the
  //                          tree's, so a suppressor goes in with it, but only
  //                          where the enhanced layer had nothing over the
  //                          pair, which is the editor's condition too.
  // Grew would keep both edges, and an annotator who wants both can put the
  // tree's back with Ctrl/Cmd+click. Settled here and not as each command
  // runs, because a later command may delete or move the tree edge: a rule
  // that adds `E:cc` and then deletes `cc` must keep its `E:cc`.
  const basicLabels = new Map();
  for (const e of after.edges.values()) {
    if (isEnhancedLabel(e.label)) continue;
    if (!basicLabels.has(pairOf(e))) basicLabels.set(pairOf(e), new Set());
    basicLabels.get(pairOf(e)).add(e.label);
  }
  const suppressedBefore = new Set((before.suppressors || []).map(pairOf));
  const enhancedPairsBefore = new Set(suppressedBefore);
  for (const e of before.edges.values())
    if (isEnhancedLabel(e.label)) enhancedPairsBefore.add(pairOf(e));
  const byPair = new Map();
  for (const p of pendingExtras) {
    if (!byPair.has(pairOf(p.a))) byPair.set(pairOf(p.a), []);
    byPair.get(pairOf(p.a)).push(p);
  }
  // What a drop comes to: the stored row goes, and the line names that row,
  // not where the edge was headed.
  const drop = (p, why) => {
    if (!p.row) return; // nothing was stored, so nothing is written
    emit(
      [`${p.row.src} → ${p.row.tgt}: ${p.row.label} removed${why}`],
      [{ op: 'deleteRelation', id: p.row.id }],
    );
  };
  for (const [pair, extras] of byPair) {
    // Two extras the rule leaves over one pair under one label are one edge.
    // Keep a stored row over a new one, so an edge is moved rather than
    // deleted and made again.
    const kept = [];
    for (const p of extras) {
      const twin = kept.find((k) => bareLabel(k.a.label) === bareLabel(p.a.label));
      if (!twin) kept.push(p);
      else if (!twin.row && p.row) {
        drop(twin, ', the graph already has it');
        kept[kept.indexOf(twin)] = p;
      } else drop(p, ', the graph already has it');
    }
    const basics = basicLabels.get(pair);
    const relabels = kept.some((p) => !basics?.has(bareLabel(p.a.label)));
    const suppress = Boolean(basics) && relabels && !enhancedPairsBefore.has(pair);
    const treeGivesIt = (p) =>
      basics?.has(bareLabel(p.a.label)) && !suppress && !suppressedBefore.has(pair);
    for (const p of kept) {
      if (treeGivesIt(p)) {
        // A row that is already an extra is dropped because the tree says the
        // same thing. One on its way out of the tree is just deleted.
        drop(p, isEnhancedLabel(p.row?.label) ? ', the tree gives it' : '');
        continue;
      }
      emit(p.lines, p.ops || [], p.needs);
      if (p.create) writeCreate(p.a, p.layerId);
    }
    if (suppress) {
      const { a, layerId } = kept[0];
      changes.push({
        kind: 'edge',
        text: `${formOf(after, a.src)} → ${formOf(after, a.tgt)}: ${[...basics].join(', ')} left out of the enhanced graph`,
      });
      writeCreate(a, layerId, { value: null, metadata: { [SUPPRESS_KEY]: true } });
    }
  }

  // A suppressor says the enhanced graph leaves out the basic edge it lies
  // over. Once a rule has removed or moved that edge it says nothing, so it
  // goes in the same write (the editor's own deletes do the same).
  const basicPairs = new Set();
  for (const e of after.edges.values())
    if (!isEnhancedLabel(e.label)) basicPairs.add(`${e.src}>${e.tgt}`);
  for (const s of before.suppressors || []) {
    if (touchesDeleted(s) || basicPairs.has(`${s.src}>${s.tgt}`)) continue;
    writes.main.push({ op: 'deleteRelation', id: s.id });
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

  // --- what Grew allows and UD does not: one head a word, as the editor has it ---
  // Being the root counts. A word the rule leaves rooted AND headed carries two
  // relations into a HEAD column that holds one, and the export drops whichever
  // it reads second, so it is worth saying before the rule is applied.
  const heads = new Map();
  for (const e of after.edges.values())
    if (!isEnhancedLabel(e.label)) heads.set(e.tgt, (heads.get(e.tgt) || 0) + 1);
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
