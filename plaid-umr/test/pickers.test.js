// What the canvas's pickers offer from the project's vocabularies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLexicon } from '../src/domain/vocabLexicon.js';
import {
  unknownRelationProblem,
  unknownDocRelationProblem,
} from '../src/domain/format/validate.js';
import { conceptProblem } from '../src/domain/format/penman.js';
import {
  conceptOptions,
  roleOptions,
  docRelationOptions,
  readAttrLine,
} from '../src/components/editor/annotation/pickers.js';
import { rolesetProblem } from '../../plaid-igt/src/domain/vocabUmr.js';

const lex = buildLexicon([
  {
    name: 'Lex',
    items: [
      { id: 'h1', form: 'tapa', metadata: {} },
      { id: 's1', form: 'tapa', metadata: { parent: 'h1', umr: { args: { ARG0: 'cutter' } } } },
      { id: 's2', form: 'tapa', metadata: { parent: 'h1', umr: { args: { ARG0: 'caller' } } } },
      { id: 'm1', form: 'look after', metadata: { umr: { roleset: 'look after-01' } } },
      { id: 'm2', form: 'look out', metadata: {} },
      { id: 'l1', form: 'look', metadata: {} },
    ],
  },
]);

test('the role picker lists the arguments of the entry the parent was made from', () => {
  const first = (entry) => roleOptions(null, 'tapa', lex, entry)[0];
  assert.deepEqual(
    first('s2').items.map((i) => i.label),
    [':ARG0 caller'],
  );
  assert.deepEqual(
    first('s1').items.map((i) => i.label),
    [':ARG0 cutter'],
  );
  // Not knowing which sense, it offers no sense's arguments.
  assert.equal(first(null).group, 'Core');
});

test('the concept picker offers no entry whose concept a graph cannot hold', () => {
  const vocab = { lexicon: lex, linked: [lex.byId.get('m1')] };
  const group = conceptOptions([], null, 'look', vocab).find((g) => g.group === 'Vocabulary');
  assert.deepEqual(
    group.items.map((i) => i.value),
    ['look'],
  );
});

// igt, where a roleset is written, refuses what a UMR graph cannot hold. It
// cannot import this app's rule, so it keeps its own, held to this one here.
test("igt's roleset rule is UMR's concept rule", () => {
  const samples = [
    'leave-02',
    'look after-01',
    'look\tafter',
    'a(b)',
    'x:y',
    'say"',
    'kai#1',
    'mɨŋ-01',
    '生活-01',
    ' leave-02 ',
    'have-91',
  ];
  for (const s of samples) {
    assert.equal(!!rolesetProblem(s), !!conceptProblem(s.trim()), s);
  }
});

// A temporal label says how the child (the target) stands to its reference
// time (the source), which reads backwards in the triple's own order, so
// each relation is offered with what it says about the two.
test('a temporal relation is offered with what it says, child first', () => {
  const [{ items }] = docRelationOptions('temporal', 'validator', {
    source: 'document-creation-time',
    target: 's9p',
  });
  const before = items.find((o) => o.value === ':before');
  assert.equal(before.label, ':before s9p before document-creation-time');
  assert.equal(
    items.find((o) => o.value === ':contained').label,
    ':contained s9p within document-creation-time',
  );
  // With no ends, and for other groups, the bare relations.
  assert.ok(docRelationOptions('temporal')[0].items.includes(':before'));
  assert.ok(
    docRelationOptions('modal', 'validator', { source: 'author', target: 's9p' })[0].items.includes(
      ':full-affirmative',
    ),
  );
});

// Roles are a closed set, a concept is not: the role editor, the attribute
// line and text mode refuse a relation the validator calls unknown.
test('a relation UMR does not have is refused', () => {
  assert.equal(unknownRelationProblem(':poss'), "Unknown relation ':poss'.");
  assert.equal(unknownRelationProblem('poss'), "Unknown relation ':poss'.");
  assert.equal(unknownRelationProblem(':possessor'), null);
  assert.equal(unknownRelationProblem(':ARG1-of'), null);
  assert.equal(unknownRelationProblem(':op12'), null);
  // The line asks the document about each relation, which keeps one the node
  // already stores (UmrDocument.relationProblem, in mutations.test.js).
  assert.equal(
    readAttrLine(':colour red', unknownRelationProblem).problem,
    "Unknown relation ':colour'.",
  );
  assert.equal(readAttrLine(':aspect state', unknownRelationProblem).problem, null);
  assert.equal(readAttrLine(':colour red', () => null).problem, null);
  assert.deepEqual(readAttrLine(':colour red :quant 2', () => null).attrs, [
    { rel: ':colour', value: 'red' },
    { rel: ':quant', value: '2' },
  ]);
});

// The line asks the document about each value too, which keeps one the node
// already stores under that relation though no editor would take it typed.
test('the attribute line keeps a stored value its check keeps', () => {
  assert.match(readAttrLine(':mod re"d', () => null).problem, /quote/);
  const kept = (rel, value) =>
    rel === ':mod' && value === 're"d' ? null : value.includes('"') ? 'quote' : null;
  assert.equal(readAttrLine(':mod re"d :quant 2', () => null, kept).problem, null);
  assert.deepEqual(readAttrLine(':mod re"d :quant 2', () => null, kept).attrs, [
    { rel: ':mod', value: 're"d' },
    { rel: ':quant', value: '2' },
  ]);
  assert.equal(readAttrLine(':quant re"d', () => null, kept).problem, 'quote');
});

// Left to itself the line refuses a value validate.py cannot read
// (umr-export-value-grammar), as the document's own check does.
test('the attribute line refuses a value the official validator cannot read', () => {
  assert.equal(
    readAttrLine(':mode Imperative', () => null).problem,
    "The value 'Imperative' of ':mode' holds a capital letter or an underscore.",
  );
  assert.match(readAttrLine(':mod ""', () => null).problem, /empty/);
  assert.equal(readAttrLine(':mode imperative :quant 3.5', () => null).problem, null);
});

// A document-level relation is a closed set too, per group: the relation
// editor refuses what `unknown-document-relation` reports, `:FullAff` as the
// guidelines' examples write it among them.
test('a document-level relation outside its group is refused', () => {
  assert.equal(unknownDocRelationProblem('modal', ':full-affirmative'), null);
  assert.equal(
    unknownDocRelationProblem('modal', ':FullAff'),
    "Unknown document-level modal relation ':FullAff'.",
  );
  assert.equal(unknownDocRelationProblem('temporal', ':before'), null);
  assert.ok(unknownDocRelationProblem('temporal', ':same-entity'));
  assert.equal(unknownDocRelationProblem('coref', ':same-entity'), null);
});

// umr-igt-inflected-forms: typing searches the frame file on a node with a
// word too, after the word's own senses. "bought" has no `buy-01` of its own.
test('typing searches the frame file on a node anchored to a word', () => {
  const frames = { 'buy-01': { ARG0: 'buyer' }, 'buy-05': { ARG0: 'believer' }, 'bought-01': {} };
  // The typed rolesets are the first group of that name: the inventory's
  // -91 rolesets are another, at the end.
  const typedGroup = (groups) => groups.find((g) => g.group === 'Rolesets');
  const groups = conceptOptions([{ text: 'bought' }], frames, 'bu');
  assert.deepEqual(
    groups.slice(0, 2).map((g) => g.group),
    ['Senses', 'Rolesets'],
  );
  assert.deepEqual(
    typedGroup(groups).items.map((i) => i.value),
    ['buy-01', 'buy-05'],
  );
  // A sense the word already offers is not listed twice.
  const again = conceptOptions([{ text: 'bought' }], frames, 'bou');
  assert.deepEqual(
    again.find((g) => g.group === 'Senses').items.map((i) => i.value),
    ['bought-01'],
  );
  assert.ok(!typedGroup(again).items.some((i) => i === 'bought-01' || i.value === 'bought-01'));
});

// Review of T-ARABIC, 2026-09-28: a word's Senses hold its `lemma--NN`
// rolesets after the plain ones, and the lemma it writes before a fold's.
test('an Arabic word lists its own senses, then lemma--NN, then a folded lemma', () => {
  const frames = { 'أثر-01': {}, 'أثر--01': {}, 'ألام-01': {}, 'أم-01': {} };
  const senses = (text) =>
    conceptOptions([{ text }], frames)
      .find((g) => g.group === 'Senses')
      .items.map((i) => i.value);
  assert.deepEqual(senses('أثرت'), ['أثر-01', 'أثر--01']);
  assert.deepEqual(senses('الأم'), ['أم-01', 'ألام-01']);
});
