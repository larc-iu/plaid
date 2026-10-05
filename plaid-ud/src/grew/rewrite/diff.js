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
import { notSetUp } from '../../../../plaid-ui/src/domain/setupGuard.js';
import { lossPhrase } from '../../../../plaid-ui/src/domain/annotationLoss.js';
import { otherDeleteLoss } from '../../domain/otherLoss.js';

const COLUMN_LAYER = {
  form: 'formLayer',
  lemma: 'lemmaLayer',
  upos: 'uposLayer',
  xpos: 'xposLayer',
};

export function diffGraphs(before, after, layerInfo) {
  const changes = [];
  const writes = { tokens: [], lemmaCreates: [], main: [] };
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
      changes.push({ kind: 'node', node: id, ...line`${b.form}: word deleted` });
      continue;
    }
    for (const col of ['form', 'lemma', 'upos', 'xpos']) {
      if (a[col] === b[col]) continue;
      changes.push({
        kind: 'feat',
        node: id,
        ...line`${b.form}: ${col} ${describe(b[col])} → ${describe(a[col])}`,
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
        changes.push({ kind: 'feat', node: id, ...line`${b.form}: ${key}=${bv} removed` });
        writes.main.push({ op: 'deleteSpan', id: spanId });
      } else if (bv === undefined) {
        changes.push({ kind: 'feat', node: id, ...line`${b.form}: ${key}=${av} added` });
        writes.main.push({
          op: 'createSpan',
          layer: layer('featuresLayer'),
          tokens: [id],
          value: `${key}=${av}`,
        });
      } else {
        changes.push({ kind: 'feat', node: id, ...line`${b.form}: ${key} ${bv} → ${av}` });
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
  // The token takes with it what the text's other layers hold on it, whoever
  // made them, and the word's line says how much (N1-CASCADE-3).
  // The row's loss is counted once over every token it deletes, so a link
  // over two deleted words is one link (REV-N5-APPS R7). Each word's line
  // names what its own token adds to the count, and the last such line what
  // the row only shortens.
  let loss = { annotations: 0, links: 0, shortened: { annotations: 0, links: 0 } };
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
    let last = null; // { at, form, phrase } of the last line that names a loss
    for (const id of deleted) {
      const b = before.nodes.get(id);
      const wholeWord = b.wordId && goneCounts.get(b.wordId) === wordCounts.get(b.wordId);
      if (wholeWord && writes.tokens.some((w) => w.id === b.wordId)) continue;
      const tokenId = wholeWord ? b.wordId : id;
      writes.tokens.push({ op: 'deleteToken', id: tokenId });
      const now = otherDeleteLoss(
        layerInfo,
        writes.tokens.map((w) => w.id),
      );
      const phrase = lossPhrase({
        annotations: now.annotations - loss.annotations,
        links: now.links - loss.links,
      });
      loss = now;
      if (!phrase) continue;
      const at = changes.findIndex((c) => c.kind === 'node' && c.node === id);
      changes[at] = {
        kind: 'node',
        node: id,
        loss: true,
        ...line`${b.form}: word deleted, with ${phrase}`,
      };
      last = { at, form: b.form, phrase };
    }
    const cut = lossPhrase(loss.shortened);
    if (cut) {
      if (!last) {
        const node = [...deleted].at(-1);
        last = {
          at: changes.findIndex((c) => c.kind === 'node' && c.node === node),
          form: before.nodes.get(node)?.form,
          phrase: '',
        };
      }
      const { at, form, phrase } = last;
      changes[at] = {
        kind: 'node',
        node: changes[at].node,
        loss: true,
        ...(phrase
          ? line`${form}: word deleted, with ${phrase}, and shortens ${cut}`
          : line`${form}: word deleted, and shortens ${cut}`),
      };
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
    if (!id) throw new GrewRuntimeError(notSetUp(`no ${what} layer`));
    return id;
  };
  const enhancedLayerId = () => layerIdOf('enhancedRelationLayer', 'enhanced dependency relation');
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
    for (const l of lines) changes.push({ kind: 'edge', ...l });
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
        ...line`${formOf(before, b.src)} → ${formOf(before, b.tgt)}: ${b.label} removed`,
      });
      writes.main.push({ op: 'deleteRelation', id });
      continue;
    }
    const lines = [];
    if (a.label !== b.label) {
      lines.push(line`${formOf(after, a.src)} → ${formOf(after, a.tgt)}: ${b.label} → ${a.label}`);
    }
    if (a.src !== b.src) {
      lines.push(
        line`${a.label} of ${formOf(after, a.tgt)}: head ${formOf(before, b.src)} → ${formOf(after, a.src)}`,
      );
    }
    if (a.tgt !== b.tgt) {
      lines.push(
        line`${a.label} from ${formOf(after, a.src)}: ${formOf(before, b.tgt)} → ${formOf(after, a.tgt)}`,
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
    const added = line`${formOf(after, a.src)} → ${formOf(after, a.tgt)}: ${a.label} added`;
    if (isEnhancedLabel(a.label)) {
      pendingExtras.push({
        a,
        lines: [added],
        layerId: enhancedLayerId(),
        create: true,
        row: null,
      });
      continue;
    }
    emit([added], []);
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
      [line`${p.row.src} → ${p.row.tgt}: ${p.row.label} removed${why}`],
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
        ...line`${formOf(after, a.src)} → ${formOf(after, a.tgt)}: ${[...basics].join(', ')} left out of the enhanced graph`,
      });
      writeCreate(a, layerId, { value: null, metadata: { [SUPPRESS_KEY]: true } });
    }
  }

  // A suppressor says the enhanced graph leaves out the basic edge it lies
  // over. Once a rule has removed or moved that edge it says nothing, so it
  // goes in the same write (the editor's own deletes do the same).
  //
  // It goes with the relabel it was made for, too. Relabelling an edge for
  // the enhanced graph is stored as a suppressor over the tree's edge plus an
  // extra under the new label, so a rule that deletes the extra asked for the
  // label to go, not for the word to be cut out of the enhanced graph. Left
  // standing, the suppressor gave the word no enhanced head at all, which
  // rules cannot see and nothing on screen said.
  const basicPairs = new Set();
  for (const e of after.edges.values())
    if (!isEnhancedLabel(e.label)) basicPairs.add(`${e.src}>${e.tgt}`);
  // Only a pair that HELD an extra was a relabel. A pair with a suppressor
  // and nothing else is a plain leaving-out, which a rule that touches
  // neither must not undo.
  const extrasBefore = new Set();
  for (const e of before.edges.values())
    if (isEnhancedLabel(e.label)) extrasBefore.add(`${e.src}>${e.tgt}`);
  const extrasAfter = new Set();
  for (const e of after.edges.values())
    if (isEnhancedLabel(e.label)) extrasAfter.add(`${e.src}>${e.tgt}`);
  for (const s of before.suppressors || []) {
    const pair = `${s.src}>${s.tgt}`;
    if (touchesDeleted(s)) continue;
    const relabelUndone = extrasBefore.has(pair) && !extrasAfter.has(pair);
    if (basicPairs.has(pair) && !relabelUndone) continue;
    if (basicPairs.has(pair)) {
      const label = [...(basicLabels.get(pair) || [])].join(', ');
      changes.push({
        kind: 'edge',
        ...line`${formOf(after, s.src)} → ${formOf(after, s.tgt)}: ${label} back in the enhanced graph`,
      });
    }
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
      changes.push({ kind: 'feat', node: n.id, ...line`${b.form}: lemma ${value} added` });
    writes.lemmaCreates.push({
      op: 'createSpan',
      layer: layer('lemmaLayer'),
      tokens: [n.id],
      value,
      node: n.id,
    });
  }

  // --- what Grew allows and the project's rules refuse ---
  // One head a word (being the root counts) and no cycle in the tree. The
  // server refuses a write that breaks either, so the sentence is an error the
  // preview leaves out, and Apply writes the rest. What the stored tree
  // already breaks is not the rule's doing and is not counted against it.
  const errors = [];
  const tree = (g) => {
    const count = new Map();
    const headOf = new Map();
    for (const e of g.edges.values()) {
      if (isEnhancedLabel(e.label)) continue;
      count.set(e.tgt, (count.get(e.tgt) || 0) + 1);
      headOf.set(e.tgt, e.src);
    }
    return { count, headOf };
  };
  const was = tree(before);
  const now = tree(after);
  for (const [id, n] of now.count) {
    if (n > 1 && n > (was.count.get(id) || 0))
      errors.push(`${formOf(after, id)} would have ${n} heads.`);
  }
  if (!errors.length) {
    const known = new Set(cyclesOf(was.headOf).map((c) => [...c].sort().join(' ')));
    for (const cycle of cyclesOf(now.headOf)) {
      if (known.has([...cycle].sort().join(' '))) continue;
      const forms = cycle.map((id) => formOf(after, id));
      errors.push(
        forms.length === 1
          ? `${forms[0]} would head itself.`
          : `${forms.join(', ')} would form a cycle.`,
      );
    }
  }

  return { changes, writes, errors, loss };
}

// Each cycle of a one-head-a-word tree (`headOf` maps a word to its head), as
// its words in the order the heads lead. A word walked from leads either to
// the anchor or into a cycle.
function cyclesOf(headOf) {
  const out = [];
  const done = new Set();
  for (const start of headOf.keys()) {
    const path = [];
    const onPath = new Map();
    let cur = start;
    while (cur !== undefined && cur !== ANCHOR && !done.has(cur) && !onPath.has(cur)) {
      onPath.set(cur, path.length);
      path.push(cur);
      cur = headOf.get(cur);
    }
    if (cur !== undefined && onPath.has(cur)) out.push(path.slice(onPath.get(cur)));
    path.forEach((id) => done.add(id));
  }
  return out;
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

// A change line as `text` and as `parts`: the line's own words at even
// indices and each value it names (a form, a label, a feature) at odd ones.
// The preview isolates every value, since an Arabic form on each side of an
// arrow otherwise joins the arrow into one right-to-left run and the line
// reads as the relation going the other way.
function line(strings, ...values) {
  const parts = [strings[0]];
  values.forEach((v, i) => parts.push(String(v), strings[i + 1]));
  return { text: parts.join(''), parts };
}
