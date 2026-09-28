// The document model's fixes from the UMR round of 2026-09-28: a mended graph
// keeps the words its file aligned, the doc-graph variable is refused, a
// delete's History label names both ends, two nodes sharing a variable are
// reported, and an edit leaves every untouched sentence's object as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const WORDS = 'Lindsay left in order to eat lunch .';
const block = (
  n,
  graph,
  alignment,
  doc = '',
) => `################################################################################
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

const LUNCH = `(s1l / leave-02
    :ARG0 (s1p / person)
    :purpose (s1e / eat-01
        :ARG1 (s1l2 / lunch)
        :place (s1r / restaurant)))`;
const LUNCH_ALIGNED = 's1l: 2-2\ns1p: 1-1\ns1e: 6-6\ns1l2: 7-7\ns1r: 0-0';

const rawOf = (text) => rawFromPlan(planImport(parseUmrFile(text).sentences, []));

const load = (text, edit = null) => {
  const raw = structuredClone(rawOf(text));
  if (edit) edit(raw);
  const { client, calls } = recordingClient();
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  return { doc, calls, errors };
};

const byVar = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);
const labels = (calls) => calls.filter((c) => c.name === 'operation').map((c) => c.args[0]);

// ----- a mended graph keeps its alignment (V2 F2, V6 F3) -----

test('mending a graph kept as text anchors each node to the words its file named', async () => {
  const broken = '(s1l / leave-02 :ARG0 (s1p / person) :purpose (s1e / eat-01)';
  const { doc } = load(block(1, broken, 's1l: 2-2\ns1p: 1-1\ns1e: 0-0'));
  assert.equal(doc.sentence(1).nodes.length, 0);
  assert.equal(
    await doc.applyPenman(1, '(s1l / leave-02 :ARG0 (s1p / person) :purpose (s1e / eat-01))'),
    4,
  );
  const words = doc.sentence(1).words;
  const left = byVar(doc, 's1l');
  assert.equal(left.aligned, true);
  assert.deepEqual(left.wordIds, [words[1].id]);
  assert.equal(left.metadata.umr.sentence, undefined);
  assert.deepEqual(byVar(doc, 's1p').wordIds, [words[0].id]);
  // A node the file aligned to nothing records its sentence, as before.
  const eat = byVar(doc, 's1e');
  assert.equal(eat.aligned, false);
  assert.equal(eat.metadata.umr.sentence, doc.sentence(1).tokenId);
  const out = doc.toUmr();
  assert.match(out, /^s1l: 2-2$/m);
  assert.match(out, /^s1p: 1-1$/m);
  assert.match(out, /^s1e: 0-0$/m);
});

// ----- the doc-graph variable (V6 F4) -----

test('a variable naming the sentence document graph is refused on the canvas and in text', () => {
  const { doc } = load(block(1, LUNCH, LUNCH_ALIGNED));
  const person = byVar(doc, 's1p');
  assert.equal(doc.variableProblem(person.id, 's1s0'), "s1s0 names the sentence's document graph.");
  // s1s2 and s1s are ordinary variables.
  assert.equal(doc.variableProblem(person.id, 's1s'), null);
  assert.equal(doc.variableProblem(person.id, 's1s2'), null);
  const plan = doc.planPenman(1, LUNCH.replace('(s1r / restaurant)', '(s1s0 / restaurant)'));
  assert.ok(plan.errors?.some((e) => /s1s0 names the sentence's document graph/.test(e.message)));
});

// ----- the delete-edge label (V1 F7, V5 F8) -----

test('deleting the edge to a leaf names the leaf by its variable and counts nothing below it', async () => {
  const { doc, calls } = load(block(1, LUNCH, LUNCH_ALIGNED));
  const eat = byVar(doc, 's1e');
  const edge = eat.out.find((e) => e.role === ':place');
  assert.equal(await doc.deleteEdge(edge.id), 1);
  assert.deepEqual(labels(calls), ['Delete :place from s1e to s1r']);
});

test('deleting the edge to a subtree counts the nodes below its target', async () => {
  const { doc, calls } = load(block(1, LUNCH, LUNCH_ALIGNED));
  const edge = byVar(doc, 's1l').out.find((e) => e.role === ':purpose');
  assert.equal(await doc.deleteEdge(edge.id), 3);
  assert.deepEqual(labels(calls), ['Delete :purpose from s1l to s1e and 2 below it']);
});

test('an edge deleted alone names its target, which stays', async () => {
  const { doc, calls } = load(block(1, LUNCH, LUNCH_ALIGNED));
  const edge = byVar(doc, 's1e').out.find((e) => e.role === ':ARG1');
  assert.equal(await doc.deleteEdge(edge.id, { subtree: false }), 0);
  assert.deepEqual(labels(calls), ['Delete :ARG1 from s1e to s1l2']);
});

// ----- two nodes sharing a variable (V5 F1) -----

// Two annotators each added a node under one variable (what a write made
// over a stale page did before strict mode): stored as two spans.
const twinVar = (raw) => {
  const spans = raw.textLayers[0].tokenLayers[2].spanLayers[0].spans;
  spans.find((s) => s.metadata.umr.var === 's1r').metadata.umr.var = 's1p';
};

test('two nodes of a sentence sharing a variable are an error, and the export refuses them', () => {
  const { doc } = load(block(1, LUNCH, LUNCH_ALIGNED), twinVar);
  const twins = doc.problems.filter((p) => p.code === 'non-unique-node-id');
  assert.equal(twins.length, 1);
  assert.equal(twins[0].sentence, 1);
  assert.equal(twins[0].var, 's1p');
  assert.equal(twins[0].level, 'error');
  assert.ok(doc.problemsBySentence.get(1).some((p) => p.code === 'non-unique-node-id'));
  assert.ok(doc.exportProblems.some((p) => p.var === 's1p' && /2 nodes/.test(p.message)));
  assert.throws(() => doc.toUmr());
});

test('two sentences sharing a variable are reported once, by the official check, and exported', () => {
  const text = block(1, LUNCH, LUNCH_ALIGNED) + block(2, '(s2l / leave-02)', 's2l: 2-2');
  const { doc } = load(text, (raw) => {
    const spans = raw.textLayers[0].tokenLayers[2].spanLayers[0].spans;
    spans.find((s) => s.metadata.umr.var === 's2l').metadata.umr.var = 's1l';
  });
  assert.equal(doc.problems.filter((p) => p.code === 'non-unique-node-id').length, 1);
  // The file reads back as it was, and a released corpus has such pairs.
  assert.deepEqual(doc.exportProblems, []);
  assert.match(doc.toUmr(), /\(s1l \/ leave-02\)/);
});

// ----- stable sentence objects (V8 F8) -----

test('an edit rebuilds the sentence it touches and hands back the others as they were', async () => {
  const text =
    block(1, LUNCH, LUNCH_ALIGNED) +
    block(2, '(s2l / leave-02 :ARG0 (s2p / person))', 's2l: 2-2\ns2p: 1-1') +
    block(3, '(s3l / leave-02)', 's3l: 2-2', '(s3s0 / sentence :temporal ((s2l :before s3l)))');
  const { doc } = load(text);
  const [one, two, three] = doc.sentences;
  const problems2 = doc.problemsBySentence.get(2) ?? null;
  await doc.setConcept(byVar(doc, 's1p').id, 'woman');
  const [one2, two2, three2] = doc.sentences;
  assert.notEqual(one2, one);
  assert.equal(one2.nodes.find((n) => n.var === 's1p').concept, 'woman');
  assert.equal(two2, two);
  assert.equal(three2, three);
  assert.equal(doc.problemsBySentence.get(2) ?? null, problems2);
  // The document map holds the same node objects the kept sentences do.
  two2.nodes.forEach((n) => assert.equal(doc.graph.nodesById.get(n.id), n));

  // A node renamed in sentence 2 changes the tag sentence 3's node wears for
  // the triple between them, so sentence 3 is rebuilt too.
  await doc.setVariable(byVar(doc, 's2l').id, 's2l2');
  const [, two3, three3] = doc.sentences;
  assert.notEqual(two3, two2);
  assert.notEqual(three3, three2);
  assert.equal(doc.sentence(1), one2);

  // A coreference chain that grows changes the size a node of it shows.
  await doc.createTriple({
    source: byVar(doc, 's2p').id,
    target: byVar(doc, 's3l').id,
    rel: ':same-entity',
  });
  const two4 = doc.sentence(2);
  assert.notEqual(two4, two3);
  // s1p joins the chain through s3l: sentence 2 is not in the triple, but
  // its node's chain now has three mentions.
  await doc.createTriple({
    source: byVar(doc, 's1p').id,
    target: byVar(doc, 's3l').id,
    rel: ':same-entity',
  });
  const two5 = doc.sentence(2);
  assert.equal(two5.triples.length, two4.triples.length);
  assert.notEqual(two5, two4);
});

// ----- NFC on every string the model takes (V6 F1) -----

// `e` and a combining acute accent: what some keyboards type for \u00e9.
const NFD_E = 'e\u0301';
const NFC_E = '\u00e9';

test('every string a canvas edit takes is stored in NFC', async () => {
  const { doc, calls, errors } = load(block(1, LUNCH, LUNCH_ALIGNED));
  const s1 = doc.sentence(1);
  const made = await doc.createNode({
    sentenceIndex: 1,
    concept: `caf${NFD_E}`,
    parentId: byVar(doc, 's1l').id,
    role: ':mod',
    attrs: [{ rel: ':op1', value: `"Caf${NFD_E}"` }],
  });
  assert.ok(made, errors.join('\n'));
  const node = doc.node(made.nodeId);
  assert.equal(node.concept, `caf${NFC_E}`);
  assert.equal(node.attrs[0].value, `"Caf${NFC_E}"`);
  const created = calls.find((c) => c.name === 'spans.create');
  assert.equal(created.args[2], `caf${NFC_E}`);

  await doc.setConcept(byVar(doc, 's1r').id, `r${NFD_E}sum${NFD_E}`);
  assert.equal(byVar(doc, 's1r').concept, `r${NFC_E}sum${NFC_E}`);
  assert.equal(calls.findLast((c) => c.name === 'spans.update').args[1], `r${NFC_E}sum${NFC_E}`);

  // A variable typed with the accent apart is a letter once composed.
  assert.equal(doc.variableProblem(byVar(doc, 's1p').id, `s1${NFD_E}`), null);
  await doc.setVariable(byVar(doc, 's1p').id, `s1${NFD_E}`);
  assert.equal(doc.node(byVar(doc, `s1${NFC_E}`).id).var, `s1${NFC_E}`);

  await doc.setAttrs(byVar(doc, 's1e').id, [{ rel: ':op1', value: `"${NFD_E}"` }]);
  assert.equal(byVar(doc, 's1e').attrs[0].value, `"${NFC_E}"`);
  assert.deepEqual(errors, []);
  assert.doesNotMatch(doc.toUmr(), /\u0301/);
  assert.equal(s1.index, 1);
});

test('text mode stores what it applies in NFC', async () => {
  const { doc } = load(block(1, LUNCH, LUNCH_ALIGNED));
  const text = doc.penmanOf(1).replace('(s1r / restaurant)', `(s1r / caf${NFD_E})`);
  assert.equal(await doc.applyPenman(1, text), 1);
  assert.equal(byVar(doc, 's1r').concept, `caf${NFC_E}`);
});
