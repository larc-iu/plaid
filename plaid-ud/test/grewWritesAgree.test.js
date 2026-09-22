// What a rewrite WRITES must leave the document saying what the rewritten
// graph says. The other Grew tests read `writes` and check the ops one by one,
// which is a test of the diff's reasoning against itself. This one applies the
// ops to the document, reads the result back the way every reader does
// (sentenceRows, enhancedGraph, the CoNLL-U export) and compares that to the
// graph the rules actually produced.
//
// Three invariants, over a list of rules that between them create, relabel,
// move and delete edges in both graphs:
//   1. the tree the document ends with is the rule's own tree
//   2. the enhanced graph holds every edge the rule put in it, and holds no
//      edge twice (DEPS names a head and relation once)
//   3. the CoNLL-U the document exports parses back to the same graph
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { parseGrs } from '../src/grew/parser.js';
import { graphFromSentence, ANCHOR } from '../src/grew/rewrite/graph.js';
import { rewriteSentence } from '../src/grew/rewrite/engine.js';
import { diffGraphs } from '../src/grew/rewrite/diff.js';
import { enhancedEdges, isSuppressor } from '../src/domain/enhancedGraph.js';
import { isEnhancedLabel, bareLabel } from '../src/grew/edgeLabel.js';

// "she sang and danced loudly": a coordination, a shared subject the enhanced
// graph already records, a relabelled conj (so one suppressor), and a word
// with no head at all, which is the one that has no Lemma span.
const CONLLU = [
  '# text = she sang and danced loudly',
  '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t2:nsubj|4:nsubj\t_',
  '2\tsang\tsing\tVERB\t_\t_\t0\troot\t0:root\t_',
  '3\tand\tand\tCCONJ\t_\t_\t4\tcc\t4:cc\t_',
  '4\tdanced\tdance\tVERB\t_\t_\t2\tconj\t2:conj:and\t_',
  '5\tloudly\t_\tADV\t_\t_\t_\t_\t_\t_',
].join('\n');

const RULES = [
  [
    'a shared subject added',
    'pattern { V1 -[conj]-> V2; V1 -[nsubj]-> S } without { V2 -[E:cc]-> S } commands { add_edge V2 -[E:cc]-> S }',
  ],
  ['an extra relabelled', 'pattern { e: V -[E:nsubj]-> S } commands { e.2 = xsubj }'],
  [
    'an extra moved onto a pair the tree joins',
    'pattern { V [lemma="dance"]; W [lemma="sing"]; V -[E:nsubj]-> S } commands { shift_out V =[1=nsubj, enhanced=yes]=> W }',
  ],
  ['an extra deleted', 'pattern { V -[E:conj:and]-> W } commands { del_edge V -[E:conj:and]-> W }'],
  [
    'a relabel of a pair the tree joins',
    'pattern { V -[cc]-> C } without { V -[E:cc:and]-> C } commands { add_edge V -[E:cc:and]-> C }',
  ],
  [
    'a basic edge moved out from under a suppressor',
    'pattern { V [lemma="sing"]; e: V -[conj]-> W } commands { del_edge e; add_edge W -[parataxis]-> V }',
  ],
  ['a basic edge relabelled', 'pattern { e: V -[cc]-> C } commands { e.label = "mark" }'],
  [
    'an edge moved into the enhanced graph',
    'pattern { e: V -[cc]-> C } commands { e.enhanced = yes }',
  ],
  [
    'an edge moved out of the enhanced graph',
    'pattern { e: V -[E:conj:and]-> W } commands { del_feat e.enhanced }',
  ],
  [
    'a word with no lemma gains an edge',
    'pattern { V [lemma="dance"]; H [form="loudly", !lemma] } without { V -[E:advmod]-> H } commands { add_edge V -[E:advmod]-> H }',
  ],
  [
    'a basic head re-pointed',
    'pattern { V [lemma="sing"]; W [lemma="dance"]; e: V -[nsubj]-> S } commands { shift_out V =[nsubj]=> W }',
  ],
  [
    'a word deleted from under a suppressor',
    'pattern { N [lemma="dance"] } commands { del_node N }',
  ],
  ['a word with no lemma span deleted', 'pattern { N [form="loudly"] } commands { del_node N }'],
  [
    'the incoming edges of a word shifted onto one with no lemma span',
    'pattern { X [lemma="dance"]; Y [form="loudly"] } without { Z -> Y } commands { shift_in X ==> Y }',
  ],
  [
    'a basic edge deleted from under a suppressor',
    'pattern { e: V -[conj]-> W } commands { del_edge e }',
  ],
  [
    'edges shifted both ways at once',
    'pattern { X [lemma="dance"]; Y [form="loudly"] } without { Z -> Y } commands { shift X ==> Y }',
  ],
];

// --- applying the writes, the way runner.js applies them ---

const SPAN_LAYERS = ['formLayer', 'lemmaLayer', 'uposLayer', 'xposLayer', 'featuresLayer'];

function applyWrites(li, writes) {
  let n = 0;
  const newId = () => `w${++n}`;
  const spanLayerById = (id) => SPAN_LAYERS.map((k) => li[k]).find((l) => l && l.id === id) || null;
  const relLayerById = (id) =>
    [li.relationLayer, li.enhancedRelationLayer].find((l) => l && l.id === id) || null;
  const relations = () => [li.relationLayer, li.enhancedRelationLayer].filter(Boolean);
  const findRel = (id) =>
    relations()
      .flatMap((l) => l.relations || [])
      .find((r) => r.id === id);

  // Deleted words first, as the runner does, and with the cascade the server
  // performs for it: a word token takes its syntactic words, a token takes the
  // spans over it, and a span takes the relations hanging off it. The diff
  // writes no relation delete for an edge that touches a deleted word
  // (`touchesDeleted`), so an applier that did not cascade would leave those
  // rows behind and the comparison below would pass on a document the server
  // would never produce.
  const doomedTokens = new Set();
  for (const w of writes.tokens) {
    if (w.op !== 'deleteToken') throw new Error(`the applier has no ${w.op}`);
    doomedTokens.add(w.id);
    const word = (li.wordTokenLayer?.tokens || []).find((t) => t.id === w.id);
    if (!word) continue;
    for (const m of li.morphemeTokenLayer?.tokens || [])
      if (m.begin >= word.begin && m.end <= word.end) doomedTokens.add(m.id);
  }
  if (doomedTokens.size) {
    for (const layer of [li.sentenceTokenLayer, li.wordTokenLayer, li.morphemeTokenLayer]) {
      if (layer) layer.tokens = (layer.tokens || []).filter((t) => !doomedTokens.has(t.id));
    }
    const doomedSpans = new Set();
    for (const layer of SPAN_LAYERS.map((k) => li[k])) {
      if (!layer) continue;
      for (const s of layer.spans || [])
        if ((s.tokens || []).some((t) => doomedTokens.has(t))) doomedSpans.add(s.id);
      layer.spans = (layer.spans || []).filter((s) => !doomedSpans.has(s.id));
    }
    for (const layer of relations()) {
      layer.relations = (layer.relations || []).filter(
        (r) => !doomedSpans.has(r.source) && !doomedSpans.has(r.target),
      );
    }
  }

  const lemmaOf = new Map();
  for (const s of li.lemmaLayer.spans || []) for (const t of s.tokens || []) lemmaOf.set(t, s.id);

  // The lemma spans a relation will hang on, next and in their own batch.
  for (const w of writes.lemmaCreates) {
    const id = newId();
    li.lemmaLayer.spans.push({ id, tokens: [...w.tokens], value: w.value });
    lemmaOf.set(w.node, id);
  }
  for (const w of writes.main) {
    switch (w.op) {
      case 'createRelation': {
        const layer = relLayerById(w.layer);
        if (!Array.isArray(layer.relations)) layer.relations = [];
        layer.relations.push({
          id: newId(),
          source: lemmaOf.get(w.src),
          target: lemmaOf.get(w.tgt),
          value: w.value,
          ...(w.metadata ? { metadata: w.metadata } : {}),
        });
        break;
      }
      case 'updateRelation':
        findRel(w.id).value = w.value;
        break;
      case 'setSource':
        findRel(w.id).source = lemmaOf.get(w.node);
        break;
      case 'setTarget':
        findRel(w.id).target = lemmaOf.get(w.node);
        break;
      case 'deleteRelation':
        for (const l of relations()) {
          const i = (l.relations || []).findIndex((r) => r.id === w.id);
          if (i >= 0) l.relations.splice(i, 1);
        }
        break;
      case 'createSpan':
        spanLayerById(w.layer).spans.push({ id: newId(), tokens: [...w.tokens], value: w.value });
        break;
      case 'updateSpan':
        for (const l of SPAN_LAYERS.map((k) => li[k])) {
          const s = (l?.spans || []).find((x) => x.id === w.id);
          if (s) s.value = w.value;
        }
        break;
      case 'deleteSpan':
        for (const l of SPAN_LAYERS.map((k) => li[k])) {
          const i = (l?.spans || []).findIndex((x) => x.id === w.id);
          if (i >= 0) l.spans.splice(i, 1);
        }
        break;
      default:
        throw new Error(`the applier has no ${w.op}`);
    }
  }
}

// --- reading both sides as sets of (head form, dependent form, label) ---

const edgeKey = (h, d, v) => `${h} -${v}-> ${d}`;

/** The rewritten graph, as the rule left it: its tree, and its enhanced graph. */
function localGraph(after, suppressedPairs) {
  const form = (id) => after.nodes.get(id)?.form ?? '?';
  const tree = [];
  const enhanced = [];
  for (const e of after.edges.values()) {
    const head = e.src === ANCHOR ? form(e.tgt) : form(e.src);
    const key = edgeKey(head, form(e.tgt), bareLabel(e.label));
    if (isEnhancedLabel(e.label)) enhanced.push(key);
    else {
      tree.push(key);
      if (!suppressedPairs.has(`${e.src}>${e.tgt}`)) enhanced.push(key);
    }
  }
  return { tree, enhanced };
}

/** The same two graphs as the document now holds them. */
function documentGraph(raw) {
  const doc = new ConlluDocument({ raw });
  const row = doc.sentences[0];
  const formOf = new Map();
  for (const entry of row.tokens) if (entry.lemma?.id) formOf.set(entry.lemma.id, entry.tokenForm);
  const form = (id) => formOf.get(id) ?? '?';
  const tree = (row.relations || []).map((r) => edgeKey(form(r.source), form(r.target), r.value));
  const enhanced = enhancedEdges(row.relations, row.enhancedRelations).map((e) =>
    edgeKey(form(e.source), form(e.target), e.value),
  );
  return { doc, tree, enhanced };
}

for (const [name, src] of RULES) {
  test(`the writes agree with the graph: ${name}`, () => {
    const raw = rawDocFromConllu(CONLLU, 'd', { enhanced: true });
    const li = new ConlluDocument({ raw }).layerInfo;
    const before = graphFromSentence(new ConlluDocument({ raw }).sentences[0]);
    const { graph: after, applications } = rewriteSentence(parseGrs(src), before);
    assert.ok(applications.length > 0, 'the rule must do something, or it tests nothing');

    const { writes, warnings } = diffGraphs(before, after, li);
    applyWrites(li, writes);
    const doc = documentGraph(raw);

    // Which pairs the document ends up leaving out of the enhanced graph is
    // the document's own answer, so the rewritten graph is read against it.
    const suppressedPairs = new Set();
    const nodeOfLemma = new Map();
    for (const entry of doc.doc.sentences[0].tokens) {
      if (entry.lemma?.id) nodeOfLemma.set(entry.lemma.id, entry.token.id);
    }
    for (const r of doc.doc.sentences[0].enhancedRelations || []) {
      if (!isSuppressor(r)) continue;
      const s = nodeOfLemma.get(r.source);
      const t = nodeOfLemma.get(r.target);
      suppressedPairs.add(`${s === t ? ANCHOR : s}>${t}`);
    }
    const local = localGraph(after, suppressedPairs);

    // 1. the tree
    assert.deepEqual(doc.tree.sort(), local.tree.sort(), 'the tree the document holds');

    // 2. the enhanced graph: every edge the rule put there, and none twice
    assert.deepEqual(
      [...new Set(doc.enhanced)].sort(),
      [...new Set(local.enhanced)].sort(),
      'the enhanced graph the document holds',
    );
    assert.deepEqual(
      doc.enhanced.length,
      new Set(doc.enhanced).size,
      `one edge is held twice: ${doc.enhanced.join(', ')}`,
    );

    // 3. and it survives a trip through the column. A rule may leave a word
    // with two heads, which Grew allows and the preview warns about: the HEAD
    // column holds one, so that sentence cannot round trip and is not asked to.
    if (warnings.some((w) => /\d heads/.test(w))) return;
    // 3. and it survives a trip through the column
    const reread = documentGraph(rawDocFromConllu(doc.doc.toConllu(), 'd', { enhanced: true }));
    assert.deepEqual(reread.tree.sort(), doc.tree.sort(), 'the tree after a round trip');
    assert.deepEqual(
      [...new Set(reread.enhanced)].sort(),
      [...new Set(doc.enhanced)].sort(),
      'the enhanced graph after a round trip',
    );
  });
}
