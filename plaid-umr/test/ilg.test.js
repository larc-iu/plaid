import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeIlg, resolveIlg, ilgLinesFor } from '../src/domain/ilg.js';

// An IGT-shaped project: morphemes under words, a morpheme gloss field, a
// word-level part of speech, and a translation on the sentence.
const layerInfo = () => ({
  morphemeTokenLayer: { id: 'ml' },
  glossLayers: [
    {
      layer: {
        id: 'g1',
        name: 'Gloss',
        spans: [
          { tokens: ['m1'], value: 'dog' },
          { tokens: ['m2'], value: 'PL' },
          { tokens: ['m3'], value: 'bark' },
        ],
      },
      scope: 'morpheme',
      lang: 'en',
    },
    {
      layer: { id: 'p1', name: 'Part of speech', spans: [{ tokens: ['w1'], value: 'N' }] },
      scope: 'word',
      lang: null,
    },
    {
      layer: { id: 't1', name: 'Translation', spans: [{ tokens: ['s1'], value: 'Dogs bark.' }] },
      scope: 'sentence',
      lang: 'en',
    },
  ],
});

const sentence = () => ({
  tokenId: 's1',
  words: [
    { id: 'w1', index: 1, begin: 0, end: 4, text: 'dogs' },
    { id: 'w2', index: 2, begin: 5, end: 9, text: 'bark' },
  ],
  morphemes: [
    { id: 'm1', begin: 0, end: 3, text: 'dog' },
    { id: 'm2', begin: 3, end: 4, text: '-s' },
    { id: 'm3', begin: 5, end: 9, text: 'bark' },
  ],
  storedIlg: [
    { header: 'Word Gloss (es)', key: 'word-gloss', lang: 'es', items: ['perros', 'ladran'] },
  ],
});

test('a mapping is proposed from what the layers are named and scoped', () => {
  const proposal = proposeIlg(layerInfo());
  assert.deepEqual(
    proposal.map((e) => [e.header, e.lang, e.source]),
    [
      ['morphemes', null, 'morphemes'],
      ['morpheme-gloss', 'en', 'layer:g1'],
      ['pos', null, 'layer:p1'],
      ['sentence-gloss', 'en', 'layer:t1'],
      [null, null, 'stored'],
    ],
  );
  assert.equal(resolveIlg(null, layerInfo()).length, 5);
  assert.deepEqual(resolveIlg([{ header: 'pos', lang: null, source: 'layer:p1' }], layerInfo()), [
    { header: 'pos', lang: null, source: 'layer:p1' },
  ]);
});

test('lines come from the layers, grouped under the words, stored lines after', () => {
  const info = layerInfo();
  const lines = ilgLinesFor(sentence(), info, resolveIlg(null, info));
  assert.deepEqual(
    lines.map((l) => [l.header, l.lang, l.items.join(' ')]),
    [
      ['Morphemes', null, 'dog -s bark'],
      ['Morpheme Gloss', 'en', 'dog PL bark'],
      ['Part of Speech', null, 'N _'],
      ['Sentence Gloss', 'en', 'Dogs bark.'],
      ['Word Gloss (es)', 'es', 'perros ladran'],
    ],
  );
  assert.deepEqual(lines[0].perWord, [['dog', '-s'], ['bark']]);
  assert.deepEqual(lines[1].perWord, [['dog', 'PL'], ['bark']]);
  assert.equal(lines[3].perWord, null);
  assert.deepEqual(lines[4].perWord, [['perros'], ['ladran']]);
});

test('a stored line the layers also produce is not written twice', () => {
  const info = layerInfo();
  const s = sentence();
  s.storedIlg.push({ header: 'Morphemes', key: 'morphemes', lang: null, items: ['old', 'lines'] });
  const lines = ilgLinesFor(s, info, resolveIlg(null, info));
  assert.equal(lines.filter((l) => l.key === 'morphemes').length, 1);
  assert.equal(lines.find((l) => l.key === 'morphemes').items.join(' '), 'dog -s bark');
});
