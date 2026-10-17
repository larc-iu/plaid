// A word's text deleted in another app (IGT's Baseline, Backspace over
// "muna ") deleted the UMR node aligned to it, with its edges and its
// document-level relations (H17-UMR-1). Core deletes a token whose whole text
// goes, and then a span left with no token, and the node's only tokens were
// its words' pieces. Ruling umr-igt-deleted-word says the node becomes an
// ordinary unaligned node, as it already did when IGT deleted the word token
// and kept its text. Every writer now gives an aligned node a hold beside its
// pieces (sentenceGraph.js `holdFor`): a token from where its words begin to
// the end of its sentence, which keeps the node when its words' text goes,
// and which no reader takes for an alignment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { isHoldToken, isRecordToken } from '../src/domain/sentenceGraph.js';
import { rawFromPlan } from './rawFromPlan.js';
import { twoWriterCore } from './twoWriterCore.js';
import { deleteText, layersOf, openInUmr, openWritesNothing, wordsOf } from './igtEdits.js';

const SEP = '#'.repeat(80);
const FILE = `${SEP}
# :: snt1
Index: 1 2 3
Words: the cat sleeps

# sentence level graph:
(s1s / sleep-01
    :ARG0 (s1c / cat
        :mod (s1t / the)))

# alignment:
s1s: 3-3
s1c: 2-2
s1t: 1-1

# document level annotation:
(s1s0 / sentence
    :modal ((author :full-affirmative s1s)
            (author :full-affirmative s1c)))

${SEP}
# :: snt2
Index: 1 2
Words: dogs bark

# sentence level graph:
(s2b / bark-01
    :ARG0 (s2d / dog))

# alignment:
s2b: 2-2
s2d: 1-1

# document level annotation:
(s2s0 / sentence)
`;

const load = () => rawFromPlan(planImport(parseUmrFile(FILE).sentences, []));
const read = (raw) => new UmrDocument({ raw: structuredClone(raw) });
const byVar = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);
const wordAt = (raw, text) => {
  const body = [...raw.textLayers[0].text.body];
  return wordsOf(raw).find((w) => body.slice(w.begin, w.end).join('') === text);
};
// The text of a word and the space after it, as Backspace over a selection
// of "cat " deletes it.
const deleteWordText = (raw, text) => {
  const w = wordAt(raw, text);
  deleteText(raw, w.begin, w.end + 1);
};
const edgesOf = (doc) =>
  doc.graph.sentences.flatMap((s) =>
    s.edges.map((e) => `${doc.node(e.source).var} ${e.role} ${doc.node(e.target).var}`),
  );
const triplesOf = (doc) =>
  doc.graph.sentences.flatMap((s) =>
    s.triples.map((t) => `${doc.node(t.source).var} ${t.rel} ${doc.node(t.target).var}`),
  );

test("a word's text deleted leaves its node as an unaligned node, edges and relations kept", async () => {
  const raw = load();
  const before = read(raw);
  deleteWordText(raw, 'cat');
  // Read before any repair as a node aligned to nothing, over its sentence.
  const doc = read(raw);
  const cat = byVar(doc, 's1c');
  assert.ok(cat, 'the node is kept');
  assert.equal(cat.aligned, false);
  assert.deepEqual(cat.alignment, []);
  assert.equal(cat.sentence, 1);
  assert.deepEqual(edgesOf(doc), edgesOf(before));
  assert.deepEqual(triplesOf(doc), triplesOf(before));
  // The open makes it an ordinary unaligned node and says so.
  const result = await openInUmr(raw);
  assert.equal(read(raw).describeReconcile(result), 'Repaired: 1 node lost its word (s1c)');
  const after = read(raw);
  assert.equal(byVar(after, 's1c').metadata.umr.sentence, after.sentence(1).tokenId);
  assert.equal(byVar(after, 's1c').metadata.umr.words, undefined);
  assert.deepEqual(edgesOf(after), edgesOf(before));
  assert.deepEqual(triplesOf(after), triplesOf(before));
  const file = after.toUmr();
  assert.match(file, /\ns1c: 0-0\n/);
  assert.match(file, /\ns1s: 2-2\n/);
  assert.match(file, /:ARG0 \(s1c \/ cat/);
  assert.ok(await openWritesNothing(raw));
});

test('the last word of a sentence, and its first, keep their nodes too', async () => {
  for (const [text, gone] of [
    ['sleeps', 's1s'],
    ['the', 's1t'],
    ['dogs', 's2d'],
    ['bark', 's2b'],
  ]) {
    const raw = load();
    const w = wordAt(raw, text);
    // The space before a last word, the space after any other.
    const last = [...raw.textLayers[0].text.body][w.end] === '\n';
    deleteText(raw, last ? w.begin - 1 : w.begin, last ? w.end : w.end + 1);
    const doc = read(raw);
    assert.ok(byVar(doc, gone), `${text}: its node is kept`);
    assert.equal(byVar(doc, gone).aligned, false, text);
    await openInUmr(raw);
    assert.ok(byVar(read(raw), gone).metadata.umr.sentence, text);
    assert.ok(await openWritesNothing(raw), text);
  }
});

test("a sentence's whole text deleted still takes its nodes", async () => {
  const raw = load();
  const [, second] = layersOf(raw).sentence.tokens;
  deleteText(raw, second.begin, second.end);
  const doc = read(raw);
  assert.equal(byVar(doc, 's2b'), undefined);
  assert.equal(byVar(doc, 's2d'), undefined);
  // No hold is left behind.
  assert.deepEqual(
    layersOf(raw)
      .nodes.tokens.filter((t) => !isRecordToken(t))
      .filter((t) => t.begin >= second.begin),
    [],
  );
});

test('a node made, re-anchored and deleted on the canvas has its hold made and taken', async () => {
  const core = twoWriterCore(load());
  const page = await core.open('a');
  const s2 = page.doc.sentence(2);
  const made = await page.doc.createNode({
    sentenceIndex: 2,
    concept: 'loud',
    wordIds: [s2.words[1].id],
    parentId: byVar(page.doc, 's2b').id,
    role: ':manner',
  });
  assert.ok(made);
  const holdsOf = (raw, nodeId) => {
    const span = layersOf(raw).concepts.spans.find((s) => s.id === nodeId);
    return layersOf(raw).nodes.tokens.filter((t) => span.tokens.includes(t.id) && isHoldToken(t));
  };
  const [hold] = holdsOf(core.raw, made.nodeId);
  assert.deepEqual([hold.begin, hold.end], [s2.words[1].begin, s2.end]);
  // Aligned to its word alone, the hold aside.
  assert.deepEqual(page.doc.node(made.nodeId).wordIds, [s2.words[1].id]);
  assert.deepEqual(page.doc.node(made.nodeId).metadata.umr.words, [s2.words[1].id]);
  // Re-anchored, it has one new hold.
  assert.ok(await page.doc.setAnchor(made.nodeId, [s2.words[0].id]));
  const after = holdsOf(core.raw, made.nodeId);
  assert.equal(after.length, 1);
  assert.deepEqual([after[0].begin, after[0].end], [s2.words[0].begin, s2.end]);
  // Made unaligned, it has none.
  assert.ok(await page.doc.setAnchor(made.nodeId, []));
  assert.deepEqual(holdsOf(core.raw, made.nodeId), []);
  // A node deleted leaves no token behind.
  const tokens = () => layersOf(core.raw).nodes.tokens.length;
  const s2d = byVar(page.doc, 's2d');
  const count = tokens();
  assert.ok(await page.doc.deleteNode(s2d.id));
  assert.equal(tokens(), count - s2d.tokenIds.length);
  assert.equal(s2d.tokenIds.length, 2);
  page.release();
  assert.ok(await openWritesNothing(core.raw));
});

test("a node the canvas made keeps itself when its word's text is deleted", async () => {
  const core = twoWriterCore(load());
  const page = await core.open('a');
  const s2 = page.doc.sentence(2);
  const made = await page.doc.createNode({
    sentenceIndex: 2,
    concept: 'pack',
    wordIds: [s2.words[0].id],
    parentId: byVar(page.doc, 's2d').id,
    role: ':part-of',
  });
  assert.ok(made);
  page.release();
  const raw = core.raw;
  deleteWordText(raw, 'dogs');
  const doc = read(raw);
  assert.ok(byVar(doc, 's2p'), 'the new node is kept');
  assert.ok(byVar(doc, 's2d'), 'the imported node is kept');
  assert.ok(edgesOf(doc).includes('s2d :part-of s2p'));
  await openInUmr(raw);
  assert.ok(await openWritesNothing(raw));
});
