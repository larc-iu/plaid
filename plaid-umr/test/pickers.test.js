// What the canvas's pickers offer from the project's vocabularies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLexicon } from '../src/domain/vocabLexicon.js';
import { conceptProblem } from '../src/domain/format/penman.js';
import { conceptOptions, roleOptions } from '../src/components/editor/annotation/pickers.js';
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
