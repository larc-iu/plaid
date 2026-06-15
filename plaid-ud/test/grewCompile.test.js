import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndCompile } from '../src/grew/index.js';

// Stable, readable layer ids so compiled output is deterministic.
const LI = {
  sentenceTokenLayer: { id: 'SENT' },
  morphemeTokenLayer: { id: 'MORPH' },
  lemmaLayer: { id: 'LEMMA' },
  uposLayer: { id: 'UPOS' },
  xposLayer: { id: 'XPOS' },
  featuresLayer: { id: 'FEATS' },
  relationLayer: { id: 'REL' },
};

const compile = (src, opts) => parseAndCompile(src, LI, opts);

// Recursively collect every clause, descending into or/not groups.
function flat(where) {
  const out = [];
  const walk = (cl) => {
    if (!Array.isArray(cl)) return;
    out.push(cl);
    if (cl[0] === 'not') cl.slice(1).forEach(walk);
    if (cl[0] === 'or') cl.slice(1).forEach(g => g.forEach(walk));
  };
  where.forEach(walk);
  return out;
}
const clauses = (where, head) => flat(where).filter(c => c[0] === head);

test('single-node upos query is exact', () => {
  const { query, impossible } = compile('pattern { X [upos=VERB] }');
  assert.equal(impossible, false);
  assert.deepEqual(query, {
    find: ['?S', '?n_X'],
    where: [
      ['token', '?S', { layer: 'SENT' }],
      ['token', '?n_X', { layer: 'MORPH' }],
      ['within', '?n_X', '?S'],
      ['span', '?s1', { layer: 'UPOS', value: 'VERB' }],
      ['covers', '?s1', '?n_X'],
    ],
    return: 'entities',
    orderBy: [['?S', 'doc'], ['?S', 'begin']],
    limit: 200,
  });
});

test('project scope + custom limit', () => {
  const { query } = compile('pattern { X [upos=VERB] }', { projectId: 'P1', limit: 50 });
  assert.deepEqual(query.scope, { projectIds: ['P1'] });
  assert.equal(query.limit, 50);
});

test('labeled edge: relation with lemma-span source/target + injective !=', () => {
  const { query } = compile('pattern { X [upos=VERB]; Y [upos=NOUN]; X -[nsubj]-> Y }');
  const rel = clauses(query.where, 'relation')[0];
  assert.equal(rel[2].layer, 'REL');
  assert.equal(rel[2].value, 'nsubj');
  // source/target are lemma-span vars, each covering the right node token.
  const covers = clauses(query.where, 'covers');
  assert.ok(covers.some(c => c[2] === '?n_X'));
  assert.ok(covers.some(c => c[2] === '?n_Y'));
  assert.ok(query.where.some(c => c[0] === '!=' && c[1] === '?n_X' && c[2] === '?n_Y'));
});

test('value list (upos=VERB|AUX) is an array, no extra branches', () => {
  const { query } = compile('pattern { X [upos=VERB|AUX] }');
  const span = clauses(query.where, 'span')[0];
  assert.deepEqual(span[2].value, ['VERB', 'AUX']);
});

test('FEATS: equality, defined, inequality, undefined', () => {
  assert.equal(clauses(compile('pattern { X [Number=Sing] }').query.where, 'span')[0][2].value, 'Number=Sing');
  assert.deepEqual(clauses(compile('pattern { X [Number] }').query.where, 'span')[0][2].value, { regex: '^Number=' });
  assert.deepEqual(clauses(compile('pattern { X [Number<>Sing] }').query.where, 'span')[0][2].value, { regex: '^Number=(?!Sing$)' });
  // !Number -> a not-wrapped FEATS span
  const { query } = compile('pattern { X [!Person] }');
  const not = query.where.find(c => c[0] === 'not');
  assert.ok(not);
  assert.deepEqual(not[1], ['span', not[1][1], { layer: 'FEATS', value: { regex: '^Person=' } }]);
});

test('upos<> uses a not-exactly regex', () => {
  const span = clauses(compile('pattern { X [upos<>VERB] }').query.where, 'span')[0];
  assert.deepEqual(span[2], { layer: 'UPOS', value: { regex: '^(?!VERB$)' } });
});

test('regex and pcre values', () => {
  assert.deepEqual(clauses(compile('pattern { X [lemma=re"^be"] }').query.where, 'span')[0][2].value, { regex: '^be' });
  assert.deepEqual(clauses(compile('pattern { X [lemma=/be/i] }').query.where, 'span')[0][2].value, { regex: 'be', flags: 'i' });
});

test('without { X -[obj]-> Y } wraps in not, no injective != inside', () => {
  const { query } = compile('pattern { X [upos=VERB] } without { X -[obj]-> Y }');
  const not = query.where.find(c => c[0] === 'not');
  assert.ok(not);
  const rel = not.slice(1).find(c => c[0] === 'relation');
  assert.equal(rel[2].value, 'obj');
  // no `!=` anywhere inside the not
  assert.ok(!flat([not]).some(c => c[0] === '!='));
});

test('node feature-structure disjunction -> or with branch tracking', () => {
  const { query } = compile('pattern { X [upos=VERB,Tense=Past] | [upos=ADJ] }');
  const or = query.where.find(c => c[0] === 'or');
  assert.ok(or);
  assert.equal(or.length - 1, 2); // two groups
});

test('ordering and dominance', () => {
  assert.ok(clauses(compile('pattern { X[]; Y[]; X < Y }').query.where, 'precedes').length === 1);
  assert.ok(clauses(compile('pattern { X[]; Y[]; X << Y }').query.where, 'precedes*').length === 1);
  const dom = clauses(compile('pattern { X[]; Y[]; X ->> Y }').query.where, 'related*')[0];
  assert.equal(dom[3].layer, 'REL');
});

test('is_projective: not-wrapped crossing/root-cover encoding, no recursive related*', () => {
  const proj = compile('pattern { X [upos=VERB] } global { is_projective }');
  const not = proj.query.where.find(c => c[0] === 'not');
  assert.ok(not, 'expected a not clause');
  const inner = flat([not]);
  assert.ok(inner.some(c => c[0] === 'precedes*'), 'uses precedence');
  assert.ok(inner.some(c => c[0] === 'relation'), 'uses relations');
  assert.ok(!inner.some(c => c[0] === 'related*'), 'avoids the recursive related*');
});

test('is_not_projective: positive top-level crossing/root-cover or, no negation', () => {
  const { query } = compile('pattern { X [] } global { is_not_projective }');
  assert.ok(!query.where.some(c => c[0] === 'not'), 'positive form has no outer not');
  const or = query.where.find(c => c[0] === 'or');
  assert.ok(or && or.length - 1 === 2, 'an or of crossing + root-cover groups');
  assert.ok(!flat(query.where).some(c => c[0] === 'related*'));
  // arcs are pinned to the sentence's document so the engine can use an index.
  const rels = flat(query.where).filter(c => c[0] === 'relation');
  assert.ok(rels.length > 0 && rels.every(r => r[2].doc && r[2].doc.var), 'arcs are doc-correlated');
});

test('is_cyclic constant-folds to impossible; is_tree is fine', () => {
  assert.equal(compile('global { is_cyclic }').impossible, true);
  assert.equal(compile('global { is_tree }').impossible, false);
});

test('delta = 2 builds a precedes chain with one intermediate', () => {
  const { query } = compile('pattern { X[]; Y[]; delta(X,Y) = 2 }');
  const prec = clauses(query.where, 'precedes');
  assert.equal(prec.length, 2); // X -> t -> Y
});

test('cross-node X.lemma = Y.lemma uses a shared value variable', () => {
  const { query } = compile('with { X.lemma = Y.lemma }');
  const spans = clauses(query.where, 'span').filter(s => s[2].layer === 'LEMMA');
  assert.equal(spans.length, 2);
  assert.deepEqual(spans[0][2].value, spans[1][2].value); // same {var: '?v..'}
  assert.ok(spans[0][2].value.var);
});

test('non-injective $ excludes a node from the != set', () => {
  const inj = compile('pattern { X[]; Y[]; Z[] }').query.where.filter(c => c[0] === '!=').length;
  assert.equal(inj, 3); // X-Y, X-Z, Y-Z
  const withDollar = compile('pattern { X[]; Y[]; Z$[] }').query.where.filter(c => c[0] === '!=').length;
  assert.equal(withDollar, 1); // only X-Y
});

test('residue errors are GrewUnsupportedError', () => {
  const unsup = (src) => {
    try { compile(src); return null; } catch (e) { return e; }
  };
  assert.equal(unsup('pattern { X[]; Y[]; delta(X,Y) = 999 }').name, 'GrewUnsupportedError');
  assert.equal(unsup('pattern { X -[!deep]-> Y }').name, 'GrewUnsupportedError'); // non-numeric edge feature
  assert.equal(unsup('pattern { X[]; Y[]; X -[re"x"]->> Y }').name, 'GrewUnsupportedError'); // regex transitive label
  assert.equal(unsup('pattern { X[] } without { X.lemma <> Y.lemma }').name, 'GrewUnsupportedError');
});

test('missing layer in this project -> GrewUnsupportedError', () => {
  const noXpos = { ...LI, xposLayer: null };
  assert.throws(() => parseAndCompile('pattern { X [xpos=NN] }', noXpos),
    (e) => e.name === 'GrewUnsupportedError' && /xpos/.test(e.message));
});

test('sent_id produces a warning', () => {
  const { warnings } = compile('global { sent_id = "x" }');
  assert.ok(warnings.some(w => /sent_id/.test(w)));
});
