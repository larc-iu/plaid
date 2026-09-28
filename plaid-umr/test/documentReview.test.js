// Review of the document round (2026-09-28): an edit hands back the object
// of every sentence it left as it was (keepUnchangedSentences). What a kept
// sentence shows of the rest of the document must still be what the
// document holds: a document-level triple written in one sentence's block
// and pointing into another is worn by the node at each end, so a change to
// it in the later block is a change to the earlier sentence too. And the
// readers that compared graph objects by identity must not be fooled by a
// kept sentence's objects from the version before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROV } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { docTagsOf } from '../src/domain/sentenceGraph.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const WORDS = 'Lindsay left in order to eat lunch .';
const block = (n, graph, alignment, doc = '') => `${'#'.repeat(80)}
# :: snt${n}\t${WORDS}
Index: 1 2 3 4 5 6 7 8
Words: ${WORDS}

# sentence level graph:
${graph}

# alignment:
${alignment}

# document level annotation:
${doc}

`;

const load = (text, edit = null) => {
  const raw = structuredClone(rawFromPlan(planImport(parseUmrFile(text).sentences, [])));
  if (edit) edit(raw);
  const { client, calls } = recordingClient();
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  return { doc, calls, errors };
};

const byVar = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);
// The tags a node wears, as the canvas draws them.
const tags = (doc, v) => docTagsOf(byVar(doc, v), doc.graph.nodesById).map((t) => t.text);

// Three sentences. Sentence 3's block writes a triple from s3l into
// sentence 1's s1p, so s1p wears it though sentence 1's block does not.
const THREE =
  block(1, '(s1l / leave-02 :ARG0 (s1p / person))', 's1l: 2-2\ns1p: 1-1') +
  block(2, '(s2l / leave-02)', 's2l: 2-2') +
  block(
    3,
    '(s3l / leave-02 :ARG0 (s3p / person))',
    's3l: 2-2\ns3p: 1-1',
    '(s3s0 / sentence :coref ((s3p :same-entity s1p)))',
  );

test('a triple relabelled in a later block is relabelled on the earlier node it points into', async () => {
  const { doc, errors } = load(THREE);
  const one = doc.sentence(1);
  const two = doc.sentence(2);
  assert.deepEqual(tags(doc, 's1p'), ['s3p :same-entity']);
  const triple = doc.sentence(3).triples[0];
  assert.ok(await doc.setTripleRelation(triple.id, ':subset-of'), errors.join('\n'));
  // Sentence 1's own block did not change, but its node's tag did.
  assert.notEqual(doc.sentence(1), one);
  assert.deepEqual(tags(doc, 's1p'), ['s3p :subset-of']);
  assert.equal(byVar(doc, 's1p').docIn[0].rel, ':subset-of');
  // Sentence 2 is in no part of it.
  assert.equal(doc.sentence(2), two);
});

test('a triple deleted in a later block leaves the earlier node without its tag', async () => {
  const { doc, errors } = load(THREE);
  const one = doc.sentence(1);
  assert.ok(await doc.deleteTriple(doc.sentence(3).triples[0].id), errors.join('\n'));
  assert.notEqual(doc.sentence(1), one);
  assert.deepEqual(tags(doc, 's1p'), []);
  assert.deepEqual(byVar(doc, 's1p').docIn, []);
});

test('a node deleted in a later sentence takes its tag off the earlier node', async () => {
  const { doc, errors } = load(THREE);
  const one = doc.sentence(1);
  assert.ok(await doc.deleteNode(byVar(doc, 's3p').id, { subtree: false }), errors.join('\n'));
  assert.notEqual(doc.sentence(1), one);
  assert.deepEqual(byVar(doc, 's1p').docIn, []);
  assert.equal(byVar(doc, 's1p').chain, null);
});

test('a triple added in a later block puts its tag on the earlier node', async () => {
  const { doc, errors } = load(THREE);
  const one = doc.sentence(1);
  const made = await doc.createTriple({
    source: byVar(doc, 's3l').id,
    target: byVar(doc, 's1l').id,
    rel: ':after',
  });
  assert.ok(made, errors.join('\n'));
  assert.notEqual(doc.sentence(1), one);
  assert.deepEqual(tags(doc, 's1l'), ['s3l :after']);
});

test('the document map and each kept sentence hold the same node objects after every edit', async () => {
  const { doc, errors } = load(THREE);
  const check = () => {
    doc.sentences.forEach((s) =>
      s.nodes.forEach((n) => assert.equal(doc.graph.nodesById.get(n.id), n, n.var)),
    );
    // Each triple a node wears is one the document holds, with the same
    // relation.
    doc.graph.nodesById.forEach((n) =>
      [...n.docIn, ...n.docOut].forEach((t) => {
        const held = doc.sentences.flatMap((s) => s.triples).find((x) => x.id === t.id);
        assert.ok(held, `${n.var} wears ${t.id}, which no block writes`);
        assert.equal(held.rel, t.rel);
      }),
    );
  };
  check();
  await doc.setConcept(byVar(doc, 's2l').id, 'go-02');
  check();
  await doc.setTripleRelation(doc.sentence(3).triples[0].id, ':subset-of');
  check();
  await doc.setVariable(byVar(doc, 's3p').id, 's3p2');
  check();
  assert.deepEqual(tags(doc, 's1p'), ['s3p2 :subset-of']);
  assert.deepEqual(errors, []);
});

// Discard graph asks which triples a sentence's block alone writes. A triple
// between two constants is written in every block its record names, and
// after an edit to one of those sentences the other one is a kept object
// from the version before, holding its own copy of the triple.
test('discard after an edit elsewhere keeps a drafted triple another block also writes', async () => {
  const text =
    block(1, '(s1l / leave-02)', 's1l: 2-2', '(s1s0 / sentence :modal ((root :modal author)))') +
    block(2, '(s2l / leave-02)', 's2l: 2-2', '(s2s0 / sentence :modal ((root :modal author)))');
  const machine = { [PROV.key]: PROV.INFERRED, [PROV.sourceKey]: 'service:x' };
  const { doc, errors } = load(text, (raw) => {
    const layer = raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);
    const concepts = layer.spanLayers[0];
    concepts.spans.forEach((s) => Object.assign((s.metadata ||= {}), machine));
    concepts.relationLayers.forEach((l) =>
      l.relations.forEach((r) => Object.assign((r.metadata ||= {}), machine)),
    );
  });
  const shared = doc.sentence(1).triples[0];
  assert.ok(shared);
  assert.equal(doc.sentence(2).triples[0].id, shared.id);
  const before = doc.discardPlan(2).relations.map((r) => r.id);
  assert.ok(!before.includes(shared.id));
  // An edit to sentence 2 only: sentence 1 is handed back as it was.
  const one = doc.sentence(1);
  assert.ok(await doc.setConcept(byVar(doc, 's2l').id, 'go-02'), errors.join('\n'));
  assert.equal(doc.sentence(1), one);
  assert.ok(!doc.discardPlan(2).relations.some((r) => r.id === shared.id));
});
