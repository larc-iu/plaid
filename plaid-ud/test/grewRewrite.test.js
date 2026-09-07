import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { parseGrs } from '../src/grew/parser.js';
import { graphFromSentence, liveNodes, liveWords } from '../src/grew/rewrite/graph.js';
import { rewriteSentence, mainStrategy } from '../src/grew/rewrite/engine.js';
import { GrewRuntimeError, GrewUnsupportedError } from '../src/grew/errors.js';

const CONLLU = [
  '# text = the dog saw a cat',
  '1\tthe\tthe\tDET\t_\tDefinite=Def|PronType=Art\t2\tdet\t_\t_',
  '2\tdog\tdog\tNOUN\tNN\tNumber=Sing\t3\tnsubj:pass\t_\t_',
  '3\tsaw\tsee\tVERB\tVBD\tTense=Past\t0\troot\t_\t_',
  '4\ta\ta\tDET\t_\tDefinite=Ind\t5\tdet\t_\t_',
  '5\tcat\tcat\tNOUN\tNN\tNumber=Sing\t3\tobj\t_\t_',
].join('\n');

const fresh = () =>
  graphFromSentence(new ConlluDocument({ raw: rawDocFromConllu(CONLLU) }).sentences[0]);
const rewrite = (src, g = fresh()) => rewriteSentence(parseGrs(src), g);
// One application of the anonymous rule (a bare rule name as the strategy).
const once = (src, g = fresh()) => rewriteSentence(parseGrs(`${src} strat main { rule }`), g);
const byForm = (g, form) => liveNodes(g).find((n) => n.form === form);
const edgeList = (g) =>
  [...g.edges.values()]
    .map((e) => `${g.nodes.get(e.src).form}-${e.label}->${g.nodes.get(e.tgt).form}`)
    .sort();

test('feature assignment: literal, copy, concatenation, slicing, FEATS keys', () => {
  const { graph, applications } = rewrite(`
    pattern { N [upos=NOUN]; D [upos=DET]; N -[det]-> D }
    without { N [Definite] }
    commands { N.Definite = D.Definite; N.xpos = N.upos + "/" + N.lemma[:2]; D.upos = "X" }
  `);
  assert.equal(applications.length, 2);
  const dog = byForm(graph, 'dog');
  assert.equal(dog.feats.get('Definite'), 'Def');
  assert.equal(dog.xpos, 'NOUN/do');
  assert.equal(byForm(graph, 'the').upos, 'X');
  assert.equal(byForm(graph, 'cat').feats.get('Definite'), 'Ind');
  // The original graph is untouched.
  assert.equal(byForm(fresh(), 'dog').xpos, 'NN');
});

test('del_feat on a column and on a FEATS key', () => {
  const { graph } = rewrite('pattern { N [xpos] } commands { del_feat N.xpos; del_feat N.Number }');
  assert.equal(byForm(graph, 'dog').xpos, undefined);
  assert.equal(byForm(graph, 'dog').feats.has('Number'), false);
  assert.equal(byForm(graph, 'saw').xpos, undefined);
});

test('edge relabel through e.label, e.1, e.2 and del_feat e.2', () => {
  // Onf keeps going while the pattern matches: `1=nsubj` still matches after
  // the subtype changes, so that rule runs once through the strategy.
  let { graph } = once('pattern { e: X -[1=nsubj]-> Y } commands { e.2 = outer }');
  assert.ok(edgeList(graph).includes('saw-nsubj:outer->dog'));
  ({ graph } = rewrite('pattern { e: X -[1=nsubj, 2=pass]-> Y } commands { del_feat e.2 }'));
  assert.ok(edgeList(graph).includes('saw-nsubj->dog'));
  ({ graph } = rewrite('pattern { e: X -[obj]-> Y } commands { e.label = "iobj" }'));
  assert.ok(edgeList(graph).includes('saw-iobj->cat'));
  ({ graph } = rewrite('pattern { e: X -[obj]-> Y } commands { e.1 = e.1 + ":lvc" }'));
  assert.ok(edgeList(graph).includes('saw-obj:lvc->cat'));
  // Under Onf the same rule would match again and change nothing.
  assert.throws(
    () => rewrite('pattern { e: X -[1=nsubj]-> Y } commands { e.2 = outer }'),
    (e) => e instanceof GrewRuntimeError && /changed nothing/.test(e.message),
  );
});

test('del_edge and add_edge: by name, by description, label copy, second head allowed', () => {
  let { graph } = rewrite(
    'pattern { e: X -[obj]-> Y } commands { del_edge e; add_edge X -[iobj]-> Y }',
  );
  assert.ok(!edgeList(graph).includes('saw-obj->cat') && edgeList(graph).includes('saw-iobj->cat'));
  ({ graph } = once(
    'pattern { X [upos=VERB]; Y [form="cat"] } commands { del_edge X -[obj]-> Y }',
  ));
  assert.equal(edgeList(graph).includes('saw-obj->cat'), false);
  // add_edge e: X -> Y copies e's label; the word keeps its old head too.
  ({ graph } = once('pattern { e: V -[obj]-> O; N [form="dog"] } commands { add_edge e: N -> O }'));
  assert.ok(edgeList(graph).includes('dog-obj->cat') && edgeList(graph).includes('saw-obj->cat'));
  assert.throws(
    () => once('pattern { X [upos=VERB]; Y [form="dog"] } commands { del_edge X -[obj]-> Y }'),
    (e) => e instanceof GrewRuntimeError && /No edge/.test(e.message),
  );
});

test('an add_edge that is already there is ineffective, so the rule loops and stops', () => {
  assert.throws(
    () => rewrite('pattern { X -[obj]-> Y } commands { add_edge X -[obj]-> Y }'),
    (e) => e instanceof GrewRuntimeError && /changed nothing/.test(e.message),
  );
});

test('shift moves incident edges, root status travels, edges between the two stay', () => {
  // Promote "dog" to head of everything "saw" governs, and make it the root.
  const { graph } = once('pattern { V [upos=VERB]; N [form="dog"] } commands { shift V ==> N }');
  assert.deepEqual(edgeList(graph), [
    '__0__-root->dog',
    'cat-det->a',
    'dog-det->the',
    'dog-obj->cat',
    'saw-nsubj:pass->dog',
  ]);
  const out = once(
    'pattern { V [upos=VERB]; N [form="dog"] } commands { shift_out V =[obj]=> N }',
  ).graph;
  assert.deepEqual(edgeList(out), [
    '__0__-root->saw',
    'cat-det->a',
    'dog-det->the',
    'dog-obj->cat',
    'saw-nsubj:pass->dog',
  ]);
  const inn = once(
    'pattern { V [upos=VERB]; N [form="dog"] } commands { shift_in V =[^root]=> N }',
  ).graph;
  assert.deepEqual(edgeList(inn), [
    '__0__-root->saw',
    'cat-det->a',
    'dog-det->the',
    'saw-nsubj:pass->dog',
    'saw-obj->cat',
  ]);
});

test('del_node removes the word and its edges; later commands on it fail', () => {
  const { graph } = rewrite('pattern { D [upos=DET] } commands { del_node D }');
  assert.deepEqual(
    liveWords(graph).map((n) => n.form),
    ['dog', 'saw', 'cat'],
  );
  assert.deepEqual(edgeList(graph), ['__0__-root->saw', 'saw-nsubj:pass->dog', 'saw-obj->cat']);
  assert.throws(
    () => rewrite('pattern { D [upos=DET] } commands { del_node D; D.upos = X }'),
    (e) => e instanceof GrewRuntimeError && /deleted/.test(e.message),
  );
});

test('append_feats and prepend_feats: FEATS only, separator, name filter', () => {
  const { graph } = rewrite(
    'pattern { D [form="the"]; N [form="dog"] } commands { append_feats D ==> N; del_node D }',
  );
  const dog = byForm(graph, 'dog');
  assert.equal(dog.feats.get('Definite'), 'Def');
  assert.equal(dog.feats.get('PronType'), 'Art');
  assert.equal(dog.feats.get('Number'), 'Sing');
  assert.equal(dog.upos, 'NOUN'); // the columns never travel
  // Both have Definite: joined with the separator, in append or prepend order.
  const a1 = byForm(
    once('pattern { D [form="the"]; N [form="a"] } commands { append_feats "/" D ==> N }').graph,
    'a',
  );
  assert.equal(a1.feats.get('Definite'), 'Ind/Def');
  assert.equal(a1.feats.get('PronType'), 'Art');
  const a2 = byForm(
    once(
      'pattern { D [form="the"]; N [form="a"] } commands { prepend_feats "/" D =[re"Definite"]=> N }',
    ).graph,
    'a',
  );
  assert.equal(a2.feats.get('Definite'), 'Def/Ind');
  assert.equal(a2.feats.has('PronType'), false); // filtered out
});

test('runtime errors: undefined feature, lemma with dependencies, unknown node; unsupported add_node', () => {
  assert.throws(
    () => rewrite('pattern { X [form="the"] } commands { X.upos = X.Number }'),
    (e) => e instanceof GrewRuntimeError && /X.Number is undefined/.test(e.message) && e.line === 1,
  );
  assert.throws(
    () => rewrite('pattern { X [form="dog"] } commands { del_feat X.lemma }'),
    (e) => e instanceof GrewRuntimeError && /dependencies/.test(e.message),
  );
  assert.throws(
    () => rewrite('pattern { X [form="dog"] } commands { Y.upos = X }'),
    (e) => e instanceof GrewRuntimeError && /not a node/.test(e.message),
  );
  assert.throws(
    () => rewrite('pattern { X [form="dog"] } commands { add_node N :< X }'),
    (e) => e instanceof GrewUnsupportedError && e.feature === 'add_node',
  );
});

test('Onf iterates to the normal form, the without clause ends it', () => {
  const { graph, applications } = rewrite(`
    pattern { X [upos=DET] } without { X [Done=Yes] } commands { X.Done = Yes }
  `);
  assert.equal(applications.length, 2);
  assert.deepEqual(
    applications.map((a) => a.rule),
    ['rule', 'rule'],
  );
  assert.ok(liveNodes(graph).filter((n) => n.feats.get('Done') === 'Yes').length === 2);
});

test('a rule that cannot terminate hits the cap', () => {
  const g = fresh();
  for (const n of liveNodes(g)) n.feats.set('Count', '');
  assert.throws(
    () =>
      rewriteSentence(
        parseGrs('pattern { X [upos=DET] } commands { X.Count = X.Count + "x" }'),
        g,
        { maxApplications: 20 },
      ),
    (e) => e instanceof GrewRuntimeError && /did not terminate/.test(e.message),
  );
});

test('strategies: default Onf(Alt), main strat, Seq, Alt, Try, Empty, Iter', () => {
  const grs = parseGrs(`
    rule det { pattern { X [upos=DET] } commands { X.upos = D } }
    rule noun { pattern { X [upos=NOUN] } commands { X.upos = N } }
  `);
  assert.deepEqual(mainStrategy(grs), {
    op: 'Onf',
    args: [
      {
        op: 'Alt',
        args: [
          { op: 'rule', name: 'det' },
          { op: 'rule', name: 'noun' },
        ],
      },
    ],
  });
  let r = rewriteSentence(grs, fresh());
  assert.deepEqual(
    r.applications.map((a) => a.rule),
    ['det', 'det', 'noun', 'noun'],
  );

  // Seq: one application each, in order; Try(Seq) with a failing member is the identity.
  r = rewrite(`
    rule det { pattern { X [upos=DET] } commands { X.upos = D } }
    rule noun { pattern { X [upos=NOUN] } commands { X.upos = N } }
    rule none { pattern { X [upos=ZZZ] } commands { X.upos = Q } }
    strat main { Seq(det, noun) }
  `);
  assert.deepEqual(
    r.applications.map((a) => a.rule),
    ['det', 'noun'],
  );
  r = rewrite(`
    rule det { pattern { X [upos=DET] } commands { X.upos = D } }
    rule none { pattern { X [upos=ZZZ] } commands { X.upos = Q } }
    strat main { Try(Seq(det, none)) }
  `);
  assert.deepEqual(
    r.applications.map((a) => a.rule),
    ['det'],
  );
  assert.equal(byForm(r.graph, 'the').upos, 'DET'); // Try returned the input graph
  r = rewrite(`
    rule det { pattern { X [upos=DET] } commands { X.upos = D } }
    rule none { pattern { X [upos=ZZZ] } commands { X.upos = Q } }
    strat s { Iter(Alt(none, det)) }
    strat main { Seq(Empty, s) }
  `);
  assert.deepEqual(
    r.applications.map((a) => a.rule),
    ['det', 'det'],
  );
  assert.throws(
    () =>
      rewrite(
        'rule det { pattern { X [upos=DET] } commands { X.upos = D } } strat main { Onf(nope) }',
      ),
    (e) => e instanceof GrewRuntimeError && /Unknown rule or strategy 'nope'/.test(e.message),
  );
});

test('an inline lexicon narrows the match and supplies command values', () => {
  const src = [
    'pattern { X [upos=NOUN, !Gender]; X.lemma = lex.noun }',
    'commands { X.Gender = lex.Gender; X.Note = lex.Gender[:1] + "." }',
    '#BEGIN lex',
    'noun\tGender',
    '%--------------',
    'dog\tMasc',
    '',
    'cat\tFem',
    '#END',
  ].join('\n');
  const { graph, applications } = rewrite(src);
  assert.equal(applications.length, 2);
  assert.equal(byForm(graph, 'dog').feats.get('Gender'), 'Masc');
  assert.equal(byForm(graph, 'dog').feats.get('Note'), 'M.');
  assert.equal(byForm(graph, 'cat').feats.get('Gender'), 'Fem');
  // The bracket form and a named rule with the lexicon inside it.
  const named = rewrite(
    [
      'rule g { pattern { X [upos=NOUN, lemma=lex.noun, !Gender] } commands { X.Gender = lex.Gender }',
      '#BEGIN lex',
      'noun\tGender',
      'cat\tFem',
      '#END',
      '}',
    ].join('\n'),
  );
  assert.equal(named.applications.length, 1);
  assert.equal(byForm(named.graph, 'cat').feats.get('Gender'), 'Fem');
  assert.equal(byForm(named.graph, 'dog').feats.has('Gender'), false);
});

test('lexicon errors: ambiguous value, unknown field, files, and the search box', () => {
  const two = [
    'pattern { X [upos=NOUN, lemma=lex.noun, !Gender] } commands { X.Gender = lex.Gender }',
    '#BEGIN lex',
    'noun\tGender',
    'dog\tMasc',
    'dog\tFem',
    '#END',
  ].join('\n');
  assert.throws(
    () => rewrite(two),
    (e) => e instanceof GrewRuntimeError && /lex.Gender is ambiguous: 2 entries/.test(e.message),
  );
  assert.throws(
    () => rewrite(two.replace('lex.Gender', 'lex.Nope')),
    (e) => e instanceof GrewRuntimeError && /no field 'Nope'/.test(e.message),
  );
  assert.throws(
    () => parseGrs('rule r (lex from "x.lex") { pattern { X [] } commands { del_node X } }'),
    (e) => e instanceof GrewUnsupportedError && e.feature === 'lexicon-file',
  );
  assert.throws(
    () => parseGrs('pattern { X [] } commands { del_node X }\n#BEGIN lex\na\tb\nc\n#END'),
    (e) => /1 fields on a line, 2 in the header/.test(e.message) && e.line === 4,
  );
});
