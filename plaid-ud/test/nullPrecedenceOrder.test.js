// A UD word that stores no precedence reads after the words of its token that
// store one, as plaid-core orders a token's children and the ud assistant
// reads them (R4-1-2, REV-R4-AGENT F5), so a word's index inside a
// multi-word token names the same word in both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { byPosition } from '../src/domain/sentenceRows.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const INPUT = [
  '# text = del mar',
  '1-2\tdel\t_\t_\t_\t_\t_\t_\t_\t_',
  '1\tde\tde\tADP\t_\t_\t3\tcase\t_\t_',
  '2\tel\tel\tDET\t_\t_\t3\tdet\t_\t_',
  '3\tmar\tmar\tNOUN\t_\t_\t0\troot\t_\t_',
].join('\n');

test('a UD word storing no precedence comes after the stored ones', () => {
  const raw = rawDocFromConllu(INPUT, 'd1');
  const layer = raw.textLayers[0].tokenLayers.find(
    (l) => l.config?.plaid?.role === 'syntactic-word',
  );
  const mwt = layer.tokens.filter((t) => t.begin === 0);
  assert.equal(mwt.length, 2);
  const de = mwt.find((t) => (t.precedence ?? 0) === Math.min(...mwt.map((m) => m.precedence)));
  de.precedence = null;
  const doc = new ConlluDocument({ raw });
  const rows = doc
    .toConllu()
    .split('\n')
    .filter((l) => /^\d+\t/.test(l))
    .map((l) => l.split('\t')[1]);
  assert.deepEqual(rows, ['el', 'de', 'mar']);
});

test('byPosition puts a null precedence last, then orders by id', () => {
  const t = (id, precedence) => ({ id, begin: 0, end: 3, precedence });
  const sorted = [t('c', null), t('b', 2), t('a', null), t('d', 1)].sort(byPosition);
  assert.deepEqual(
    sorted.map((x) => x.id),
    ['d', 'b', 'a', 'c'],
  );
});
