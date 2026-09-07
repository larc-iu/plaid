import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { parseGrs } from '../src/grew/parser.js';
import { graphFromSentence } from '../src/grew/rewrite/graph.js';
import { rewriteSentence } from '../src/grew/rewrite/engine.js';
import { diffGraphs } from '../src/grew/rewrite/diff.js';

const CONLLU = [
  '# text = del perro vio',
  '1-2\tdel\t_\t_\t_\t_\t_\t_\t_\t_',
  '1\tde\tde\tADP\t_\t_\t3\tcase\t_\t_',
  '2\tel\tel\tDET\t_\tDefinite=Def|PronType=Art\t3\tdet\t_\t_',
  '3\tperro\tperro\tNOUN\tNN\tGender=Masc|Number=Sing\t4\tnsubj\t_\t_',
  '4\tvio\t_\tVERB\t_\t_\t0\troot\t_\t_',
].join('\n');

const setup = () => {
  const doc = new ConlluDocument({ raw: rawDocFromConllu(CONLLU) });
  const li = doc.layerInfo;
  const before = graphFromSentence(doc.sentences[0]);
  return { doc, li, before };
};
const run = (src) => {
  const { li, before } = setup();
  const { graph: after } = rewriteSentence(parseGrs(src), before);
  return { before, after, ...diffGraphs(before, after, li) };
};
const ops = (writes) => writes.map((w) => w.op);

test('column and FEATS changes become span writes with the old metadata', () => {
  const r = run(`pattern { N [upos=NOUN] } without { N [Done] } commands {
    N.upos = PROPN; N.xpos = NNP; N.Gender = Fem; N.Done = Yes; del_feat N.Number; N.lemma = "perr" }`);
  assert.deepEqual(
    r.changes.map((c) => c.text),
    [
      'perro: lemma perro → perr',
      'perro: upos NOUN → PROPN',
      'perro: xpos NN → NNP',
      'perro: Done=Yes added',
      'perro: Gender Masc → Fem',
      'perro: Number=Sing removed',
    ],
  );
  assert.deepEqual(ops(r.writes.main), [
    'updateSpan',
    'updateSpan',
    'updateSpan',
    'createSpan',
    'updateSpan',
    'deleteSpan',
  ]);
  const upos = r.writes.main[1];
  assert.equal(upos.id, r.before.nodes.get(r.before.order[3]).spanIds.upos);
  assert.equal(upos.value, 'PROPN');
  assert.equal(r.writes.main[3].value, 'Done=Yes');
  assert.equal(r.writes.main[3].layer, 'features-layer');
  assert.equal(r.writes.main[4].value, 'Gender=Fem');
  assert.equal(r.writes.tokens.length + r.writes.lemmaCreates.length, 0);
  assert.deepEqual(r.warnings, []);
});

test('a missing column is created; a form equal to the text drops the Form span', () => {
  let r = run('pattern { V [upos=VERB] } without { V [xpos] } commands { V.xpos = VBD }');
  assert.deepEqual(ops(r.writes.main), ['createSpan']);
  assert.equal(r.writes.main[0].layer, 'xpos-layer');
  // "de" is a multi-word token member: it carries a Form span. Setting the
  // form to the token text "del" removes it; any other form updates it.
  r = run('pattern { X [form="de"] } commands { X.form = "del" }');
  assert.deepEqual(ops(r.writes.main), ['deleteSpan']);
  r = run('pattern { X [form="de"] } commands { X.form = "d" }');
  assert.deepEqual(ops(r.writes.main), ['updateSpan']);
  // A one-word token has no Form span; a new form creates one.
  r = run('pattern { X [form="perro"] } commands { X.form = "perra" }');
  assert.deepEqual(ops(r.writes.main), ['createSpan']);
  assert.equal(r.writes.main[0].layer, 'form-layer');
});

test('edges: relabel, delete, create, and endpoint moves; lemma spans come first', () => {
  // "vio" has no lemma, so the import gave it no relations; the rule hands it
  // one, which needs the lemma span first.
  const r = run(`pattern { e: N -[det]-> D; N -[case]-> C; V [upos=VERB] } commands {
    e.label = "amod"; del_edge N -[case]-> C; add_edge V -[nsubj]-> N; shift_out N =[amod]=> V } strat main { rule }`);
  assert.deepEqual(
    r.changes.map((c) => c.text),
    [
      'perro → de: case removed',
      'vio → el: det → amod',
      'amod of el: head perro → vio',
      'vio → perro: nsubj added',
      'vio: lemma vio added',
    ],
  );
  assert.deepEqual(ops(r.writes.main), [
    'deleteRelation',
    'updateRelation',
    'setSource',
    'createRelation',
  ]);
  assert.deepEqual(ops(r.writes.lemmaCreates), ['createSpan']);
  assert.equal(r.writes.lemmaCreates[0].value, 'vio');
  assert.equal(r.writes.lemmaCreates[0].layer, 'lemma-layer');
  const create = r.writes.main[3];
  assert.equal(create.src, r.writes.lemmaCreates[0].node);
  assert.equal(r.writes.main[2].node, r.writes.lemmaCreates[0].node);
  assert.equal(create.value, 'nsubj');
});

test('del_node deletes the token (or just the word of a multi-word token) and nothing under it', () => {
  let r = run('pattern { X [form="perro"] } commands { del_node X }');
  assert.deepEqual(
    r.changes.map((c) => c.text),
    ['perro: word deleted'],
  );
  const perro = r.before.nodes.get(r.before.order[3]);
  assert.deepEqual(r.writes.tokens, [{ op: 'deleteToken', id: perro.wordId }]);
  assert.deepEqual(r.writes.main, []); // its relations cascade
  r = run('pattern { X [form="el"] } commands { del_node X }');
  assert.deepEqual(r.writes.tokens, [{ op: 'deleteToken', id: r.before.order[2] }]);
});

test('a second head is applied as written and flagged', () => {
  const r = run(
    'pattern { V [upos=VERB]; D [upos=DET] } commands { add_edge V -[det]-> D } strat main { rule }',
  );
  assert.deepEqual(r.warnings, ['el has 2 heads.']);
});

test('the root is a self-loop on the server: a root move writes both endpoints', () => {
  // shift_in moves every incoming edge of "saw", the anchor's root edge
  // included: "dog" becomes the root.
  const doc = new ConlluDocument({
    raw: rawDocFromConllu(
      [
        '# text = the dog saw',
        '1\tthe\tthe\tDET\t_\t_\t2\tdet\t_\t_',
        '2\tdog\tdog\tNOUN\t_\t_\t3\tnsubj\t_\t_',
        '3\tsaw\tsee\tVERB\t_\t_\t0\troot\t_\t_',
      ].join('\n'),
    ),
  });
  const before = graphFromSentence(doc.sentences[0]);
  const grs = parseGrs(
    'pattern { V [form="saw"]; N [form="dog"] } commands { del_edge V -[nsubj]-> N; shift_in V ==> N } strat main { rule }',
  );
  const { graph: after } = rewriteSentence(grs, before);
  const r = diffGraphs(before, after, doc.layerInfo);
  assert.deepEqual(
    r.changes.map((c) => c.text),
    ['saw → dog: nsubj removed', 'root from (root): saw → dog'],
  );
  // One relation: the old saw self-loop becomes a dog self-loop.
  assert.deepEqual(ops(r.writes.main), ['deleteRelation', 'setTarget', 'setSource']);
  const dog = before.order[2];
  assert.equal(r.writes.main[1].node, dog);
  assert.equal(r.writes.main[2].node, dog);
  assert.equal(r.writes.main[1].id, r.writes.main[2].id);
  assert.deepEqual(r.warnings, []);
});
