import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/grew/parser.js';

const onlyBlock = (s) => parse(s).blocks[0];
const items = (s) => onlyBlock(s).items;

test('node with features, disjunction of values', () => {
  const [node] = items('pattern { X [upos=VERB, Number=Sing|Plur, !Person] }');
  assert.equal(node.kind, 'node');
  assert.equal(node.id, 'X');
  assert.equal(node.alts.length, 1);
  const [upos, num, person] = node.alts[0];
  assert.deepEqual(upos, { name: 'upos', op: '=', value: { type: 'lit', value: 'VERB' } });
  assert.equal(num.op, '=');
  assert.deepEqual(num.value, { type: 'disj', items: [{ type: 'lit', value: 'Sing' }, { type: 'lit', value: 'Plur' }] });
  assert.deepEqual(person, { name: 'Person', op: 'undefined', value: null });
});

test('node feature-structure disjunction with |', () => {
  const [node] = items('pattern { X [upos=VERB,Tense=Past] | [upos=ADJ] }');
  assert.equal(node.alts.length, 2);
  assert.equal(node.alts[0].length, 2);
  assert.equal(node.alts[1].length, 1);
});

test('inequality feature and regex value', () => {
  const [a, b] = items('pattern { X [Tense<>Fut]; Y [lemma=re"^be"] }');
  assert.equal(a.alts[0][0].op, '<>');
  assert.deepEqual(b.alts[0][0].value, { type: 'regex', pattern: '^be', flavor: 're', flags: '' });
});

test('labeled edge, label disjunction, negation, subtype, regex', () => {
  assert.deepEqual(items('pattern { X -[nsubj]-> Y }')[0],
    { kind: 'edge', id: null, src: { wild: false, id: 'X' }, tgt: { wild: false, id: 'Y' },
      label: { type: 'list', labels: ['nsubj'], negated: false } });
  assert.deepEqual(items('pattern { X -[nsubj|obj]-> Y }')[0].label,
    { type: 'list', labels: ['nsubj', 'obj'], negated: false });
  assert.deepEqual(items('pattern { X -[^nsubj|obj]-> Y }')[0].label,
    { type: 'list', labels: ['nsubj', 'obj'], negated: true });
  assert.deepEqual(items('pattern { X -[nsubj:pass]-> Y }')[0].label,
    { type: 'list', labels: ['nsubj:pass'], negated: false });
  assert.deepEqual(items('pattern { X -[1=nsubj,2=pass]-> Y }')[0].label,
    { type: 'features', feats: [{ key: '1', val: 'nsubj' }, { key: '2', val: 'pass' }] });
  assert.equal(items('pattern { X -[re".*subj"]-> Y }')[0].label.type, 'regex');
});

test('any edge, named edge, wildcard endpoints', () => {
  assert.deepEqual(items('pattern { X -> Y }')[0].label, { type: 'any' });
  assert.deepEqual(items('pattern { e: X -[obj]-> Y }')[0].id, 'e');
  assert.deepEqual(items('pattern { * -[nsubj]-> Y }')[0].src, { wild: true });
  assert.deepEqual(items('pattern { X -[nsubj]-> * }')[0].tgt, { wild: true });
});

test('ordering, dominance (plain + labeled), crossing', () => {
  assert.deepEqual(items('pattern { X < Y }')[0], { kind: 'order', op: '<', left: 'X', right: 'Y' });
  assert.deepEqual(items('pattern { X << Y }')[0], { kind: 'order', op: '<<', left: 'X', right: 'Y' });
  const dom = items('pattern { X ->> Y }')[0];
  assert.equal(dom.kind, 'dominates');
  assert.deepEqual(dom.label, { type: 'any' });
  assert.equal(items('pattern { X -[nsubj]->> Y }')[0].label.labels[0], 'nsubj');
  assert.deepEqual(items('pattern { e1 >< e2 }')[0], { kind: 'cross', left: 'e1', right: 'e2', line: 1 });
});

test('cross-node feature comparison vs single-node feature constraint', () => {
  assert.deepEqual(items('with { X.lemma = Y.lemma }')[0],
    { kind: 'featcmp', left: { node: 'X', feat: 'lemma' }, op: '=', right: { node: 'Y', feat: 'lemma' }, line: 1 });
  assert.deepEqual(items('with { X.lemma <> Y.lemma }')[0].op, '<>');
  const nf = items('with { X.lemma = "be" }')[0];
  assert.equal(nf.kind, 'nodefeat');
  assert.deepEqual(nf.value, { type: 'lit', value: 'be' });
});

test('delta / length with comparisons and negative numbers', () => {
  assert.deepEqual(items('pattern { delta(X,Y) = 3 }')[0],
    { kind: 'dist', fn: 'delta', a: 'X', b: 'Y', op: '=', n: 3 });
  assert.deepEqual(items('pattern { length(X,Y) <= 4 }')[0].op, '<=');
  assert.equal(items('pattern { delta(X,Y) = -3 }')[0].n, -3);
});

test('global flags and metadata', () => {
  assert.deepEqual(parse('global { is_projective }').blocks[0].items[0], { kind: 'globalflag', name: 'is_projective', line: 1 });
  assert.equal(parse('global { is_not_cyclic }').blocks[0].items[0].name, 'is_not_cyclic');
  const meta = parse('global { text = re"\\baux\\b" }').blocks[0].items[0];
  assert.equal(meta.kind, 'globalmeta');
  assert.equal(meta.key, 'text');
});

test('non-injective $ recorded at request level', () => {
  const r = parse('pattern { X -[ARG0]-> A; X -[ARG1]-> B$ }');
  assert.deepEqual(r.nonInjective, ['B']);
});

test('multiple blocks', () => {
  const r = parse('pattern { X [upos=VERB] } without { X -[obj]-> Y } global { is_tree }');
  assert.deepEqual(r.blocks.map(b => b.type), ['pattern', 'without', 'global']);
});

test('parse errors carry location', () => {
  assert.throws(() => parse('pattern { X [upos=] }'), (e) => e.name === 'GrewParseError' && e.line === 1);
  assert.throws(() => parse('foo { X }'), (e) => /block keyword/.test(e.message));
});
