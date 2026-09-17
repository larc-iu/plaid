// Grew over the enhanced graph: `E:` labels in a search, in a rule's pattern
// and in its commands, and what the rewrite writes for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { parseAndCompile, readCounts } from '../src/grew/index.js';
import { parseGrs } from '../src/grew/parser.js';
import { splitLabel } from '../src/grew/edgeLabel.js';
import { labelMatches } from '../src/grew/rewrite/match.js';
import { graphFromSentence } from '../src/grew/rewrite/graph.js';
import { rewriteSentence } from '../src/grew/rewrite/engine.js';
import { diffGraphs } from '../src/grew/rewrite/diff.js';
import { GrewUnsupportedError, GrewRuntimeError } from '../src/grew/errors.js';

const LI = {
  sentenceTokenLayer: { id: 'SENT' },
  morphemeTokenLayer: { id: 'MORPH' },
  lemmaLayer: { id: 'LEMMA' },
  uposLayer: { id: 'UPOS' },
  xposLayer: { id: 'XPOS' },
  featuresLayer: { id: 'FEATS' },
  relationLayer: { id: 'REL' },
  enhancedRelationLayer: { id: 'EREL' },
};
const compile = (src, li = LI, opts) => parseAndCompile(src, li, opts);
const flat = (where) => {
  const out = [];
  const walk = (cl) => {
    if (!Array.isArray(cl)) return;
    out.push(cl);
    if (cl[0] === 'not') cl.slice(1).forEach(walk);
    if (cl[0] === 'or') cl.slice(1).forEach((g) => g.forEach(walk));
  };
  where.forEach(walk);
  return out;
};
const relations = (where) => flat(where).filter((c) => c[0] === 'relation');
const label = (src) =>
  parseGrs(`pattern { X -[${src}]-> Y } commands { X.a = b }`).rules[0].blocks[0].items[0].label;

// --- the one reading of a label ---

test('a label speaks of the tree, the extras, or both', () => {
  const sides = (src) => {
    const s = splitLabel(label(src));
    return [
      s.basic && (s.basic.labels || s.basic.type),
      s.enhanced && (s.enhanced.labels || s.enhanced.type),
    ];
  };
  assert.deepEqual(sides('nsubj'), [['nsubj'], null]);
  assert.deepEqual(sides('E:nsubj'), [null, ['nsubj']]);
  assert.deepEqual(sides('nsubj|E:nsubj:pass'), [['nsubj'], ['nsubj:pass']]);
  // A negation excludes nothing on the side it names nothing on.
  assert.deepEqual(sides('^nsubj'), [['nsubj'], 'any']);
  assert.deepEqual(sides('^E:nsubj'), ['any', ['nsubj']]);
  assert.deepEqual(sides('1=nsubj'), ['features', 'features']);
  assert.deepEqual(sides('1=nsubj, enhanced=yes'), [null, 'features']);
  assert.deepEqual(sides('1=nsubj, !enhanced'), ['features', null]);
  assert.deepEqual(sides('enhanced=yes'), [null, 'any']);
  assert.deepEqual(splitLabel({ type: 'any' }), {
    basic: { type: 'any' },
    enhanced: { type: 'any' },
  });
});

test('a regex opening with E: reads the extras, one opening with ^ the tree', () => {
  const re = (pattern) => splitLabel({ type: 'regex', pattern, flags: '' });
  assert.equal(re('E:nsubj').basic, null);
  assert.equal(re('E:nsubj').enhanced.pattern, 'nsubj');
  assert.equal(re('^E:n').enhanced.pattern, '^n');
  assert.equal(re('^nsubj').enhanced, null);
  assert.equal(re('subj').basic.pattern, 'subj');
  assert.equal(re('subj').enhanced.pattern, 'subj');
});

test('the local matcher asks a label of the side the edge is on', () => {
  assert.equal(labelMatches(label('nsubj'), 'nsubj'), true);
  assert.equal(labelMatches(label('nsubj'), 'E:nsubj'), false);
  assert.equal(labelMatches(label('E:nsubj'), 'E:nsubj'), true);
  assert.equal(labelMatches(label('E:nsubj'), 'nsubj'), false);
  assert.equal(labelMatches(label('^nsubj'), 'E:nsubj'), true);
  assert.equal(labelMatches(label('^E:nsubj'), 'E:nsubj'), false);
  assert.equal(labelMatches(label('1=nsubj'), 'E:nsubj:pass'), true);
  assert.equal(labelMatches(label('1=nsubj, !enhanced'), 'E:nsubj'), false);
  assert.equal(labelMatches(label('1=nsubj, enhanced=yes'), 'nsubj'), false);
  assert.equal(labelMatches({ type: 'any' }, 'E:nsubj'), true);
});

// --- search ---

test('a plain label still reads the tree alone', () => {
  const { query } = compile('pattern { X -[nsubj]-> Y }');
  assert.deepEqual(
    relations(query.where).map((c) => [c[2].layer, c[2].value]),
    [['REL', 'nsubj']],
  );
});

test('an E: label reads the enhanced layer under the bare deprel', () => {
  const { query } = compile('pattern { X -[E:nsubj|E:nsubj:xsubj]-> Y }');
  assert.deepEqual(
    relations(query.where).map((c) => [c[2].layer, c[2].value]),
    [['EREL', ['nsubj', 'nsubj:xsubj']]],
  );
});

test('an unlabelled edge reads both layers in one clause, and never a suppressor', () => {
  const { query } = compile('pattern { e: X -> Y }');
  // A suppressor is a row with no value, and "." asks for one.
  const [rel] = relations(query.where);
  assert.deepEqual(rel[2], {
    layer: '?rl1',
    value: { regex: '.' },
    source: '?lem_X',
    target: '?lem_Y',
  });
  assert.deepEqual(
    query.where.find((c) => c[0] === 'relation-layer'),
    ['relation-layer', '?rl1', { 'span-layer': 'LEMMA' }],
  );
  assert.equal(
    query.where.some((c) => c[0] === 'or'),
    false,
  );
  assert.ok(query.find.includes('?e_e'));
});

test('many unlabelled edges beside is_projective stay under the branch limit', () => {
  compile('pattern { A -> B; B -> C; C -> D; D -> E; E -> F } global { is_projective }');
});

test('another relation layer on Lemma, or a test that differs by side, is an or', () => {
  const crowded = {
    ...LI,
    lemmaLayer: { id: 'LEMMA', relationLayers: [{ id: 'REL' }, { id: 'EREL' }, { id: 'OTHER' }] },
  };
  for (const [src, li] of [
    ['pattern { X -> Y }', crowded],
    ['pattern { X -[^det]-> Y }', LI],
  ]) {
    const or = compile(src, li).query.where.find((c) => c[0] === 'or');
    assert.deepEqual(
      or.slice(1).map((g) => g[0][2].layer),
      ['REL', 'EREL'],
    );
  }
});

test('a mixed list asks each atom of its own layer', () => {
  const inNot = (src) => relations([compile(src).query.where.find((c) => c[0] === 'not')]);
  // The same label on both sides is the one clause again.
  assert.deepEqual(
    inNot('pattern { X [] } without { X -[nsubj|E:nsubj]-> Y }').map((c) => [
      c[2].layer,
      c[2].value,
    ]),
    [['?rl4', 'nsubj']],
  );
  assert.deepEqual(
    inNot('pattern { X [] } without { X -[nsubj|E:nsubj:xsubj]-> Y }').map((c) => [
      c[2].layer,
      c[2].value,
    ]),
    [
      ['REL', 'nsubj'],
      ['EREL', 'nsubj:xsubj'],
    ],
  );
});

test('a count by label is grouped by the layer the edge was bound with', () => {
  const by = (src) => compile(src, LI, { countBy: { node: 'e', field: 'label' } }).query;
  // One layer variable per entity: the server does not join a second to the first.
  const both = by('pattern { e: X -> Y }');
  assert.deepEqual(both.return.group, ['?groupValue', '?rl1']);
  assert.deepEqual(both.where.at(-1), ['relation', '?e_e', { value: { var: '?groupValue' } }]);
  assert.deepEqual(by('pattern { e: X -[^det]-> Y }').return.group, ['?groupValue', '?groupLayer']);

  assert.deepEqual(
    readCounts(
      [
        ['nsubj', 'REL', 2],
        ['nsubj', { id: 'EREL' }, 1],
        ['', 'REL', 4],
        ['NOUN', 7],
      ],
      LI,
    ),
    [
      { value: 'nsubj', count: 2 },
      { value: 'E:nsubj', count: 1 },
      { value: 'NOUN', count: 7 },
    ],
  );
});

test('a project with no enhanced layer: both means the tree, E: is refused', () => {
  const { enhancedRelationLayer: _gone, ...bare } = LI;
  const { query } = compile('pattern { X -> Y }', bare);
  assert.deepEqual(
    relations(query.where).map((c) => c[2].layer),
    ['REL'],
  );
  assert.throws(() => compile('pattern { X -[E:nsubj]-> Y }', bare), GrewUnsupportedError);
});

test('a root relation from a named head is refused with the spelling that works', () => {
  assert.throws(() => compile('pattern { X -[root]-> Y }'), /Write \* -\[root\]-> Y/);
  assert.throws(() => compile('pattern { X -[E:root]-> Y }'), GrewUnsupportedError);
  const [rel] = relations(compile('pattern { * -[E:root]-> Y }').query.where);
  assert.deepEqual(rel[2], { layer: 'EREL', value: 'root', target: '?lem_Y' });
});

test('->> follows one layer', () => {
  const rel = (src) => compile(src).query.where.find((c) => c[0] === 'related*')[3];
  assert.deepEqual(rel('pattern { X ->> Y }'), { layer: 'REL' });
  assert.deepEqual(rel('pattern { X -[E:conj]->> Y }'), { layer: 'EREL', value: 'conj' });
  assert.throws(() => compile('pattern { X -[conj|E:conj]->> Y }'), GrewUnsupportedError);
});

// --- rewrite ---

// "she sang and danced" with no enhanced graph yet, so the rule that shares
// the subject has work to do.
const CONLLU = [
  '# text = she sang and danced',
  '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t_\t_',
  '2\tsang\tsing\tVERB\t_\t_\t0\troot\t_\t_',
  '3\tand\tand\tCCONJ\t_\t_\t4\tcc\t_\t_',
  '4\tdanced\tdance\tVERB\t_\t_\t2\tconj\t_\t_',
].join('\n');

// The same with the enhanced graph already there: the shared subject, and
// `conj` relabelled `conj:and` (a suppressor plus an extra edge).
const ENHANCED = [
  '# text = she sang and danced',
  '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t2:nsubj|4:nsubj\t_',
  '2\tsang\tsing\tVERB\t_\t_\t0\troot\t0:root\t_',
  '3\tand\tand\tCCONJ\t_\t_\t4\tcc\t4:cc\t_',
  '4\tdanced\tdance\tVERB\t_\t_\t2\tconj\t2:conj:and\t_',
].join('\n');

const SHARED_SUBJECT = `
  pattern { V1 -[conj]-> V2; V1 -[nsubj]-> S }
  without { V2 -[E:nsubj]-> S }
  commands { add_edge V2 -[E:nsubj]-> S }
`;

const setup = (conllu) => {
  const doc = new ConlluDocument({ raw: rawDocFromConllu(conllu, 'doc', { enhanced: true }) });
  return { li: doc.layerInfo, before: graphFromSentence(doc.sentences[0]) };
};
const run = (conllu, src) => {
  const { li, before } = setup(conllu);
  const { graph: after, applications } = rewriteSentence(parseGrs(src), before);
  return { li, before, after, applications, ...diffGraphs(before, after, li) };
};
const edgeList = (g) =>
  [...g.edges.values()]
    .map((e) => `${g.nodes.get(e.src).form}-${e.label}->${g.nodes.get(e.tgt).form}`)
    .sort();

test('the graph holds the extras as E: edges and no suppressor as an edge', () => {
  const { before } = setup(ENHANCED);
  assert.deepEqual(edgeList(before), [
    '__0__-root->sang',
    'danced-E:nsubj->she',
    'danced-cc->and',
    'sang-E:conj:and->danced',
    'sang-conj->danced',
    'sang-nsubj->she',
  ]);
  assert.equal(before.suppressors.length, 1);
});

test('a rule adds the shared subject to the enhanced layer, once', () => {
  const r = run(CONLLU, SHARED_SUBJECT);
  assert.equal(r.applications.length, 1);
  assert.deepEqual(
    r.changes.map((c) => c.text),
    ['danced → she: E:nsubj added'],
  );
  assert.equal(r.writes.main.length, 1);
  const [w] = r.writes.main;
  assert.equal(w.op, 'createRelation');
  assert.equal(w.layer, r.li.enhancedRelationLayer.id);
  assert.equal(w.value, 'nsubj');
  // An extra head in the enhanced graph is what the graph is for.
  assert.deepEqual(r.warnings, []);
});

test('the same rule finds nothing to do where the edge already is', () => {
  assert.equal(run(ENHANCED, SHARED_SUBJECT).applications.length, 0);
});

test('an extra edge does not make the tree a non-tree', () => {
  const r = run(
    ENHANCED,
    'pattern { X [upos=PRON] } without { X [Seen] } global { is_tree; is_projective } commands { X.Seen = Yes }',
  );
  assert.equal(r.applications.length, 1);
});

test('relabel and delete an extra edge by its E: label', () => {
  const r = run(
    ENHANCED,
    `rule a { pattern { e: X -[E:nsubj]-> Y } commands { e.2 = xsubj } }
     rule b { pattern { X -[E:conj:and]-> Y } commands { del_edge X -[E:conj:and]-> Y } }`,
  );
  assert.deepEqual(r.changes.map((c) => c.text).sort(), [
    'danced → she: E:nsubj → E:nsubj:xsubj',
    'sang → danced: E:conj:and removed',
  ]);
  const update = r.writes.main.find((w) => w.op === 'updateRelation');
  assert.equal(update.value, 'nsubj:xsubj');
});

test('e.enhanced = yes moves an edge to the other layer', () => {
  const r = run(CONLLU, 'pattern { e: X -[cc]-> Y } commands { e.enhanced = yes }');
  assert.deepEqual(
    r.changes.map((c) => c.text),
    ['danced → and: cc → E:cc'],
  );
  assert.deepEqual(
    r.writes.main.map((w) => [w.op, w.layer, w.value]),
    [
      ['deleteRelation', undefined, undefined],
      ['createRelation', r.li.enhancedRelationLayer.id, 'cc'],
    ],
  );
});

test('a suppressor goes with the basic edge a rule removes or moves', () => {
  const { before } = setup(ENHANCED);
  const [suppressor] = before.suppressors;
  for (const commands of [
    'del_edge X -[conj]-> Y',
    'del_edge X -[conj]-> Y; add_edge Y -[flat]-> X',
  ]) {
    const r = run(ENHANCED, `pattern { X -[conj]-> Y } commands { ${commands} }`);
    assert.ok(
      r.writes.main.some((w) => w.op === 'deleteRelation' && w.id === suppressor.id),
      commands,
    );
  }
  // Relabelled in place, the pair is still joined and the suppressor stays.
  const kept = run(ENHANCED, 'pattern { e: X -[conj]-> Y } commands { e.label = parataxis }');
  assert.ok(!kept.writes.main.some((w) => w.id === suppressor.id));
});

test('an extra edge over a pair the tree joins is a relabel, as in the editor', () => {
  const r = run(
    CONLLU,
    'pattern { X -[cc]-> Y } without { X -[E:cc:and]-> Y } commands { add_edge X -[E:cc:and]-> Y }',
  );
  assert.deepEqual(
    r.changes.map((c) => c.text),
    ['danced → and: E:cc:and added', 'danced → and: cc left out of the enhanced graph'],
  );
  const eid = r.li.enhancedRelationLayer.id;
  assert.deepEqual(
    r.writes.main.map((w) => [w.op, w.layer, w.value, w.metadata]),
    [
      ['createRelation', eid, null, { suppress: true }],
      ['createRelation', eid, 'cc:and', undefined],
    ],
  );

  // Where the enhanced layer already says something over the pair, nothing
  // more is suppressed: ENHANCED has conj relabelled conj:and already.
  const second = run(
    ENHANCED,
    'pattern { X -[conj]-> Y } without { X -[E:conj:x]-> Y } commands { add_edge X -[E:conj:x]-> Y }',
  );
  assert.deepEqual(
    second.writes.main.map((w) => w.value),
    ['conj:x'],
  );
});

test('an E: edge the tree already gives the enhanced graph is ineffective', () => {
  const { before } = setup(CONLLU);
  assert.throws(
    () =>
      rewriteSentence(
        parseGrs('pattern { X -[cc]-> Y } commands { add_edge X -[E:cc]-> Y }'),
        before,
      ),
    GrewRuntimeError,
  );
});

test('an E: edge in a project with no enhanced layer refuses the row', () => {
  const doc = new ConlluDocument({ raw: rawDocFromConllu(CONLLU) });
  const before = graphFromSentence(doc.sentences[0]);
  const { graph: after } = rewriteSentence(parseGrs(SHARED_SUBJECT), before);
  assert.throws(() => diffGraphs(before, after, doc.layerInfo), GrewRuntimeError);
});
