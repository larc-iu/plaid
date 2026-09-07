import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { parse } from '../src/grew/parser.js';
import { graphFromSentence, liveWords } from '../src/grew/rewrite/graph.js';
import { findMatches, firstMatch, isProjective } from '../src/grew/rewrite/match.js';

// "the dog saw a cat" with a passive-ish subtype and a projective tree, plus a
// second, non-projective sentence.
const CONLLU = [
  '# text = the dog saw a cat',
  '# sent_id = s1',
  '1\tthe\tthe\tDET\t_\tDefinite=Def|PronType=Art\t2\tdet\t_\t_',
  '2\tdog\tdog\tNOUN\tNN\tNumber=Sing\t3\tnsubj:pass\t_\t_',
  '3\tsaw\tsee\tVERB\tVBD\tTense=Past\t0\troot\t_\t_',
  '4\ta\ta\tDET\t_\tDefinite=Ind\t5\tdet\t_\t_',
  '5\tcat\tcat\tNOUN\tNN\tNumber=Sing\t3\tobj\t_\t_',
  '',
  '# text = a hearing is scheduled today',
  '# sent_id = s2',
  '1\ta\ta\tDET\t_\t_\t2\tdet\t_\t_',
  '2\thearing\thearing\tNOUN\t_\t_\t4\tnsubj\t_\t_',
  '3\tis\tbe\tAUX\t_\t_\t4\taux\t_\t_',
  '4\tscheduled\tschedule\tVERB\t_\t_\t0\troot\t_\t_',
  '5\ttoday\ttoday\tNOUN\t_\t_\t2\tnmod\t_\t_',
  '',
  '# text = x y',
  '1\tx\tx\tNOUN\t_\t_\t2\tobl\t_\t_',
  '2\ty\ty\tVERB\t_\t_\t3\tadvmod\t_\t_',
].join('\n');

const doc = new ConlluDocument({ raw: rawDocFromConllu(CONLLU) });
const g1 = graphFromSentence(doc.sentences[0]);
const g2 = graphFromSentence(doc.sentences[1]);
const forms = (g, m, ...vars) => vars.map((v) => g.nodes.get(m.nodes.get(v)).form);
const all = (g, src) => findMatches(parse(src), g);

test('graph: nodes carry columns, FEATS, span ids; edges resolve to nodes', () => {
  // The anchor comes first, at position 0, as in Grew.
  assert.deepEqual(
    g1.order.map((id) => g1.nodes.get(id).form),
    ['__0__', 'the', 'dog', 'saw', 'a', 'cat'],
  );
  assert.deepEqual(
    liveWords(g1).map((n) => n.form),
    ['the', 'dog', 'saw', 'a', 'cat'],
  );
  const dog = g1.nodes.get(g1.order[2]);
  assert.equal(dog.lemma, 'dog');
  assert.equal(dog.upos, 'NOUN');
  assert.equal(dog.xpos, 'NN');
  assert.equal(dog.feats.get('Number'), 'Sing');
  assert.ok(dog.spanIds.upos && dog.spanIds.features.get('Number'));
  const edges = [...g1.edges.values()].map(
    (e) => `${g1.nodes.get(e.src).form}-${e.label}->${g1.nodes.get(e.tgt).form}`,
  );
  assert.deepEqual(
    edges.sort(),
    ['cat-det->a', 'dog-det->the', 'saw-nsubj:pass->dog', 'saw-obj->cat', '__0__-root->saw'].sort(),
  );
  assert.equal(g1.sentence.metadata.sent_id, 's1');
});

test('node features: literal, list, regex, defined, undefined, not-equal', () => {
  assert.equal(all(g1, 'pattern { X [upos=DET] }').length, 2);
  assert.equal(all(g1, 'pattern { X [upos=DET|NOUN] }').length, 4);
  assert.equal(all(g1, 'pattern { X [lemma=re"^s"] }').length, 1);
  assert.equal(all(g1, 'pattern { X [lemma=/^S/i] }').length, 1);
  assert.equal(all(g1, 'pattern { X [xpos] }').length, 3);
  assert.equal(all(g1, 'pattern { X [!xpos] }').length, 3); // the anchor too
  assert.equal(all(g1, 'pattern { X [] }').length, 6);
  assert.equal(all(g1, 'pattern { X [form="__0__"] }').length, 1);
  assert.equal(all(g1, 'pattern { X [Number=Sing] }').length, 2);
  assert.equal(all(g1, 'pattern { X [Number<>Plur] }').length, 2);
  assert.equal(all(g1, 'pattern { X [upos<>NOUN] }').length, 3);
  assert.equal(all(g1, 'pattern { X [form="dog"] }').length, 1);
  assert.equal(all(g1, 'pattern { X [upos=NOUN] | [upos=VERB] }').length, 3);
  assert.equal(all(g1, 'pattern { X []; X.upos = VERB }').length, 1);
});

test('edges: exact label, list, negation, regex, subtype prefix, wildcards, named', () => {
  assert.equal(all(g1, 'pattern { X -[nsubj]-> Y }').length, 0); // exact
  assert.equal(all(g1, 'pattern { X -[1=nsubj]-> Y }').length, 1); // main type
  assert.equal(all(g1, 'pattern { X -[1=nsubj, 2=pass]-> Y }').length, 1);
  assert.equal(all(g1, 'pattern { X -[det|obj]-> Y }').length, 3);
  assert.equal(all(g1, 'pattern { X -[^det]-> Y }').length, 3); // nsubj:pass, obj, root (from the anchor)
  assert.equal(all(g1, 'pattern { X -[re"^n"]-> Y }').length, 1);
  assert.equal(all(g1, 'pattern { X [upos=VERB]; X -> * }').length, 2);
  assert.equal(all(g1, 'pattern { X []; * -[root]-> X }').length, 1);
  assert.equal(all(g1, 'pattern { R [form="__0__"]; R -[root]-> X }').length, 1);
  const [m] = all(g1, 'pattern { e: X -[obj]-> Y }');
  assert.ok(g1.edges.get(m.edges.get('e')).label === 'obj');
  assert.deepEqual(forms(g1, m, 'X', 'Y'), ['saw', 'cat']);
});

test('injective by default, $ relaxes it', () => {
  assert.equal(all(g1, 'pattern { X [upos=VERB]; Y [upos=VERB] }').length, 0);
  assert.equal(all(g1, 'pattern { X [upos=VERB]; Y$ [upos=VERB] }').length, 1);
});

test('order, distance, dominance, feature comparison', () => {
  assert.equal(all(g1, 'pattern { D [upos=DET]; N [upos=NOUN]; D < N }').length, 2);
  assert.equal(all(g1, 'pattern { D [upos=DET]; N [upos=NOUN]; N > D }').length, 2);
  assert.equal(all(g1, 'pattern { X [upos=DET]; Y [upos=NOUN]; X >> Y }').length, 1); // a >> dog
  assert.equal(all(g1, 'pattern { X [upos=DET]; Y [upos=NOUN]; Y << X }').length, 1); // dog << a
  assert.equal(all(g1, 'pattern { X [form="the"]; Y []; delta(X,Y) = 2 }').length, 1);
  assert.equal(all(g1, 'pattern { X [form="saw"]; Y []; length(X,Y) <= 1 }').length, 2);
  assert.equal(all(g1, 'pattern { V [upos=VERB]; X []; V ->> X }').length, 4);
  assert.equal(all(g1, 'pattern { V [upos=VERB]; X []; V -[det]->> X }').length, 0);
  assert.equal(all(g1, 'pattern { V [upos=VERB]; X []; V -[obj|det]->> X }').length, 2);
  assert.equal(all(g1, 'pattern { X [upos=DET]; Y [upos=DET]; X.upos = Y.upos }').length, 2);
  assert.equal(all(g1, 'pattern { X [upos=NOUN]; Y [upos=NOUN]; X.lemma <> Y.lemma }').length, 2);
});

test('without blocks, with local nodes and named outer edges', () => {
  assert.equal(all(g1, 'pattern { V [upos=VERB] } without { V -[obj]-> * }').length, 0);
  assert.equal(all(g1, 'pattern { N [upos=NOUN] } without { N -[det]-> D }').length, 0);
  assert.equal(
    all(g1, 'pattern { N [upos=NOUN] } without { N -[det]-> D; D [Definite=Ind] }').length,
    1,
  );
  assert.equal(all(g1, 'pattern { e: V -[obj]-> N } without { V -[nsubj]-> * }').length, 1);
});

test('matches are deterministic and in linear order', () => {
  const ms = all(g1, 'pattern { X [upos=DET]; Y []; X < Y }');
  assert.deepEqual(
    ms.map((m) => forms(g1, m, 'X', 'Y')),
    [
      ['the', 'dog'],
      ['a', 'cat'],
    ],
  );
  assert.deepEqual(forms(g1, firstMatch(parse('pattern { X [upos=NOUN] }'), g1), 'X'), ['dog']);
});

test('global block: projectivity, tree flags, and sentence metadata', () => {
  assert.equal(isProjective(g1), true);
  assert.equal(isProjective(g2), false);
  assert.equal(all(g1, 'pattern { X [upos=VERB] } global { is_projective }').length, 1);
  assert.equal(all(g2, 'pattern { X [upos=VERB] } global { is_projective }').length, 0);
  assert.equal(all(g2, 'pattern { X [upos=VERB] } global { is_not_projective }').length, 1);
  assert.equal(
    all(g1, 'pattern { X [upos=VERB] } global { is_tree; is_forest; is_not_cyclic }').length,
    1,
  );
  assert.equal(all(g1, 'pattern { X [upos=VERB] } global { is_cyclic }').length, 0);
  assert.equal(all(g1, 'pattern { X [upos=VERB] } global { sent_id = "s1" }').length, 1);
  assert.equal(all(g1, 'pattern { X [upos=VERB] } global { sent_id <> "s1" }').length, 0);
  assert.equal(all(g1, 'pattern { X [upos=VERB] } global { text = re".*dog.*" }').length, 1);
  assert.equal(all(g1, 'pattern { X [upos=VERB] } global { !newpar }').length, 1);
  // A dangling head (3 has no node) drops that relation: y is then a root.
  const g3 = graphFromSentence(doc.sentences[2]);
  assert.equal(all(g3, 'pattern { X [upos] } global { is_tree }').length, 2);
  assert.equal(all(g3, 'pattern { X [] } global { is_not_tree }').length, 0);
});

test('edge crossing', () => {
  // s2: nsubj scheduled->hearing spans "is"; nmod hearing->today spans "is scheduled": they cross? No: nested.
  assert.equal(all(g2, 'pattern { e1: X -[nsubj]-> Y; e2: Y -[nmod]-> Z; e1 >< e2 }').length, 0);
  // det a<-hearing and aux is<-scheduled: [1,2] vs [3,4], disjoint, no crossing.
  assert.equal(all(g2, 'pattern { e1: X -[det]-> Y; e2: Z -[aux]-> W; e1 >< e2 }').length, 0);
  // nsubj (2,4) and nmod (2,5)? share an endpoint: not interleaved.
  // nmod hearing(2)->today(5) vs aux scheduled(4)->is(3): [2,5] contains [3,4], no. Make one: root loop excluded.
  const g = graphFromSentence(doc.sentences[1]);
  // Add a synthetic edge is(3)->today(5)? Instead cross nmod(2,5) with an edge (3,?)…: aux (4,3) and nsubj (4,2): [3,4] vs [2,4] share 4.
  assert.equal(all(g, 'pattern { e1: X -[nmod]-> Y; e2: Z -[aux]-> W; e1 >< e2 }').length, 0);
});
