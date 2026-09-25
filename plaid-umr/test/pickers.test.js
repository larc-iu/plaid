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
  assert.equal(readAttrLine(':colour red').problem, "Unknown relation ':colour'.");
  assert.equal(readAttrLine(':aspect state').problem, null);
  // One the node already has (an imported file's) is not refused again.
  assert.equal(readAttrLine(':colour red', [':colour']).problem, null);
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
