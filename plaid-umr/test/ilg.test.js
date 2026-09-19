import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  proposeIlg,
  resolveIlg,
  ilgLinesFor,
  languageCode,
  perWordStored,
  wordGroups,
} from '../src/domain/ilg.js';

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

// An archive import, a copy and a restore all make the layers afresh, and the
// mapping names them by id. The line used to be dropped, on the canvas and in
// the file, with nothing said.
test('a line whose layer is gone takes the layer of the same line in the proposal', () => {
  const stored = [
    { header: 'morphemes', lang: null, source: 'morphemes' },
    { header: 'morpheme-gloss', lang: 'en', source: 'layer:GONE' },
    { header: 'pos', lang: null, source: 'layer:p1' },
    { header: null, lang: null, source: 'stored' },
  ];
  assert.deepEqual(resolveIlg(stored, layerInfo()), [
    { header: 'morphemes', lang: null, source: 'morphemes' },
    { header: 'morpheme-gloss', lang: 'en', source: 'layer:g1' },
    { header: 'pos', lang: null, source: 'layer:p1' },
    { header: null, lang: null, source: 'stored' },
  ]);
  // Nothing to heal it with: the line is left as it was rather than guessed.
  assert.deepEqual(
    resolveIlg([{ header: 'sentence-gloss', lang: 'fr', source: 'layer:GONE' }], layerInfo()),
    [{ header: 'sentence-gloss', lang: 'fr', source: 'layer:GONE' }],
  );
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

test('an empty layer neither pushes out a stored line nor writes placeholders', () => {
  const info = layerInfo();
  info.glossLayers.forEach((g) => (g.layer.spans = []));
  const s = sentence();
  s.morphemes = [];
  s.storedIlg.push({
    header: 'Morphemes',
    key: 'morphemes',
    lang: null,
    items: ['dog', '-s', 'bark'],
  });
  const lines = ilgLinesFor(s, info, resolveIlg(null, info));
  assert.deepEqual(
    lines.map((l) => [l.key, l.lang, l.items.join(' ')]),
    [
      ['word-gloss', 'es', 'perros ladran'],
      ['morphemes', null, 'dog -s bark'],
    ],
  );
});

test('a word with no morphemes keeps its slot, a gloss with a space is one item', () => {
  const info = layerInfo();
  info.glossLayers[0].layer.spans.push({ tokens: ['m3'], value: 'bark loudly' });
  info.glossLayers[0].layer.spans = info.glossLayers[0].layer.spans.filter(
    (sp) => sp.tokens[0] !== 'm3' || sp.value === 'bark loudly',
  );
  const s = sentence();
  s.words.push({ id: 'w3', index: 3, begin: 10, end: 11, text: '.' });
  const lines = ilgLinesFor(s, info, resolveIlg(null, info));
  const morphemes = lines.find((l) => l.key === 'morphemes');
  assert.deepEqual(morphemes.items, ['dog', '-s', 'bark', '_']);
  const gloss = lines.find((l) => l.key === 'morpheme-gloss');
  assert.deepEqual(gloss.items, ['dog', 'PL', 'bark_loudly', '_']);
});

test('language codes are two or three lowercase letters, else und', () => {
  assert.equal(languageCode('pt-BR'), 'pt');
  assert.equal(languageCode('qaa-x-eng'), 'qaa');
  assert.equal(languageCode('English'), 'und');
  assert.equal(languageCode(''), 'und');
});

// The Leipzig convention: a prefix or proclitic ends in a joiner and takes
// the next item, a suffix or enclitic starts with one and joins the last.
test('morphemes group into words by their hyphens and equals signs', () => {
  const navajo = ['yah', '’a-', 'ní-', 'dz-', 'oo-', 'd-', 'záa', '=go', 'Ńléí'];
  assert.deepEqual(wordGroups(navajo), [[0], [1, 2, 3, 4, 5, 6, 7], [8]]);
  // A bare hyphen or equals sign is an item of its own.
  assert.deepEqual(wordGroups(['a', '-', 'b']), [[0], [1], [2]]);
});

test('stored lines go under the words wherever the file lets that be told', () => {
  // Arapaho: two words, the first of three morphemes.
  const lines = [
    { key: 'morphemes', header: 'Morphemes', items: ['neseihiin-', "iine'etii", "-3i'", '.'] },
    { key: 'morpheme-gloss', header: 'Morphemes(English)', items: ['wild-', 'live', '-3PL', '.'] },
    { key: 'pos', header: 'Part of Speech', items: ['prefix', 'vai', 'infl', '.'] },
    { key: 'sentence-gloss', header: 'Translation(English)', items: ['they', 'lived'] },
    { key: 'word-gloss', header: 'Word Gloss', items: ['a', 'b', 'c'] },
  ];
  const laid = perWordStored(lines, 2);
  // Its own joiners.
  assert.deepEqual(laid[0].perWord, [['neseihiin-', "iine'etii", "-3i'"], ['.']]);
  assert.deepEqual(laid[1].perWord, [['wild-', 'live', '-3PL'], ['.']]);
  // No joiners of its own, but item for item with the Morphemes line.
  assert.deepEqual(laid[2].perWord, [['prefix', 'vai', 'infl'], ['.']]);
  // A translation is a row even when its count matches the words.
  assert.equal(laid[3].perWord, null);
  // Nothing tells which word each of three items belongs to.
  assert.equal(laid[4].perWord, null);
});
