import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  layerGone,
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
      sentenceRole: 'translation',
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
    // Word lines, then morpheme lines, then sentence lines: the order an
    // interlinear text is read in, whatever order the layers come in.
    [
      ['pos', null, 'layer:p1'],
      ['morphemes', null, 'morphemes'],
      ['morpheme-gloss', 'en', 'layer:g1'],
      ['sentence-gloss', 'en', 'layer:t1'],
      [null, null, 'stored'],
    ],
  );
});

// The sentence line is the field IGT stored as the translation, whatever it
// and the other sentence fields are called.
test('the Sentence Gloss line is the sentence field whose role is the translation', () => {
  const info = {
    glossLayers: [
      { layer: { id: 'n1', name: 'Translation' }, scope: 'sentence', lang: 'en' },
      {
        layer: { id: 'f1', name: 'Libre' },
        scope: 'sentence',
        lang: 'es',
        sentenceRole: 'translation',
      },
    ],
  };
  assert.deepEqual(
    proposeIlg(info).map((e) => [e.header, e.source]),
    [
      ['sentence-gloss', 'layer:f1'],
      [null, 'stored'],
    ],
  );
});

// The mapping is read from the project, never proposed on a read: a project
// with none shows no lines, and one that lists a single line shows that line.
test('a mapping is read as stored, and a project without one has no lines', () => {
  assert.deepEqual(resolveIlg(null), []);
  assert.deepEqual(resolveIlg([]), []);
  assert.deepEqual(resolveIlg([{ header: 'pos', lang: null, source: 'layer:p1' }]), [
    { header: 'pos', lang: null, source: 'layer:p1' },
  ]);
});

// An archive import or a restore makes the layers afresh, and the mapping
// names them by id. A line whose layer is gone is kept as it is and draws
// nothing: no layer is picked for it by name (layerGone tells Settings).
test('a line whose layer is gone stays as it is and draws nothing', () => {
  const stored = [
    { header: 'morphemes', lang: null, source: 'morphemes' },
    { header: 'morpheme-gloss', lang: 'en', source: 'layer:GONE' },
    { header: 'pos', lang: null, source: 'layer:p1' },
    { header: null, lang: null, source: 'stored' },
  ];
  const mapping = resolveIlg(stored);
  assert.deepEqual(mapping, [
    { header: 'pos', lang: null, source: 'layer:p1' },
    { header: 'morphemes', lang: null, source: 'morphemes' },
    { header: 'morpheme-gloss', lang: 'en', source: 'layer:GONE' },
    { header: null, lang: null, source: 'stored' },
  ]);
  assert.deepEqual(
    mapping.map((e) => layerGone(e, layerInfo())),
    [false, false, true, false],
  );
  const s = { ...sentence(), storedIlg: [] };
  assert.deepEqual(
    ilgLinesFor(s, layerInfo(), mapping).map((l) => l.key),
    ['pos', 'morphemes'],
  );
});

test('lines come from the layers, grouped under the words, stored lines after', () => {
  const info = layerInfo();
  const lines = ilgLinesFor(sentence(), info, proposeIlg(info));
  assert.deepEqual(
    lines.map((l) => [l.header, l.lang, l.items.join(' ')]),
    // Word scope, then morpheme, then sentence. A STORED line obeys it too:
    // an imported word gloss belongs beside the other word lines, and within
    // one scope a stored line still follows the line the layers produced.
    [
      ['Part of Speech', null, 'N _'],
      ['Word Gloss (es)', 'es', 'perros ladran'],
      ['Morphemes', null, 'dog -s bark'],
      ['Morpheme Gloss', 'en', 'dog PL bark'],
      ['Sentence Gloss', 'en', 'Dogs bark.'],
    ],
  );
  assert.deepEqual(lines[1].perWord, [['perros'], ['ladran']]);
  assert.deepEqual(lines[2].perWord, [['dog', '-s'], ['bark']]);
  assert.deepEqual(lines[3].perWord, [['dog', 'PL'], ['bark']]);
  assert.equal(lines[4].perWord, null);
});

test('a value with spaces is shown with them, and written with underscores', () => {
  const info = layerInfo();
  info.glossLayers[0].layer.spans[2].value = 'its  blood';
  info.glossLayers[1].layer.spans[0].value = ' noun phrase ';
  const s = sentence();
  s.morphemes[2].text = 'har nuu';
  const lines = ilgLinesFor(s, info, proposeIlg(info));
  const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
  assert.deepEqual(byKey.pos.perWord, [['noun phrase'], ['_']]);
  assert.deepEqual(byKey.pos.items, ['noun_phrase', '_']);
  assert.deepEqual(byKey.morphemes.perWord, [['dog', '-s'], ['har nuu']]);
  assert.deepEqual(byKey.morphemes.items, ['dog', '-s', 'har_nuu']);
  assert.deepEqual(byKey['morpheme-gloss'].perWord, [['dog', 'PL'], ['its blood']]);
  assert.deepEqual(byKey['morpheme-gloss'].items, ['dog', 'PL', 'its_blood']);
});

test('a stored line the layers also produce is not written twice', () => {
  const info = layerInfo();
  const s = sentence();
  s.storedIlg.push({ header: 'Morphemes', key: 'morphemes', lang: null, items: ['old', 'lines'] });
  const lines = ilgLinesFor(s, info, proposeIlg(info));
  assert.equal(lines.filter((l) => l.key === 'morphemes').length, 1);
  assert.equal(lines.find((l) => l.key === 'morphemes').items.join(' '), 'dog -s bark');
});

test('a stored line in a two-letter code is the layer line in its three-letter code', () => {
  const info = layerInfo();
  info.glossLayers[0].lang = 'eng';
  const s = sentence();
  s.storedIlg.push({
    header: 'Morphemes(English)',
    key: 'morpheme-gloss',
    lang: 'en',
    items: ['old', 'PL', 'lines'],
  });
  const lines = ilgLinesFor(s, info, proposeIlg(info));
  const glosses = lines.filter((l) => l.key === 'morpheme-gloss');
  assert.equal(glosses.length, 1);
  assert.equal(glosses[0].items.join(' '), 'dog PL bark');
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
  const lines = ilgLinesFor(s, info, proposeIlg(info));
  assert.deepEqual(
    lines.map((l) => [l.key, l.lang, l.items.join(' ')]),
    [
      ['word-gloss', 'es', 'perros ladran'],
      ['morphemes', null, 'dog -s bark'],
    ],
  );
});

test('a word with no morphemes is its own morpheme, its gloss is _, a gloss with a space is one item', () => {
  const info = layerInfo();
  info.glossLayers[0].layer.spans.push({ tokens: ['m3'], value: 'bark loudly' });
  info.glossLayers[0].layer.spans = info.glossLayers[0].layer.spans.filter(
    (sp) => sp.tokens[0] !== 'm3' || sp.value === 'bark loudly',
  );
  const s = sentence();
  s.words.push({ id: 'w3', index: 3, begin: 10, end: 11, text: '.' });
  const lines = ilgLinesFor(s, info, proposeIlg(info));
  const morphemes = lines.find((l) => l.key === 'morphemes');
  assert.deepEqual(morphemes.items, ['dog', '-s', 'bark', '.']);
  assert.deepEqual(morphemes.perWord.at(-1), ['.']);
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

// A merge in IGT moves the dying sentence's translation onto the survivor, so
// one token carries two. IGT joins them with ` | ` when it next opens the
// document, and until then UMR showed only the last.
test('two values of one layer on one token are joined as IGT joins them', () => {
  const info = layerInfo();
  info.glossLayers[2].layer.spans.push(
    { tokens: ['s1'], value: 'The door opened.' },
    { tokens: ['s1'], value: 'Dogs bark.' },
  );
  info.glossLayers[1].layer.spans.push({ tokens: ['w1'], value: 'V' });
  const lines = ilgLinesFor(sentence(), info, proposeIlg(info));
  const line = (header) => lines.find((l) => l.header === header);
  assert.equal(line('Sentence Gloss').items.join(' '), 'Dogs bark. | The door opened.');
  assert.deepEqual(line('Part of Speech').perWord, [['N | V'], ['_']]);
});

// umr-igt-unanalyzed-word: `Çocuklar okula gidiyorlar` writes its Morphemes
// line as IGT's exporters do, `Çocuklar okula gid iyor lar`.
test('an unanalyzed word reads as itself on the Morphemes line, as in IGT', () => {
  const info = layerInfo();
  info.glossLayers.forEach((g) => (g.layer.spans = []));
  const s = {
    ...sentence(),
    words: [
      { id: 'w1', index: 1, begin: 0, end: 8, text: 'Çocuklar' },
      { id: 'w2', index: 2, begin: 9, end: 14, text: 'okula' },
      { id: 'w3', index: 3, begin: 15, end: 24, text: 'gidiyorlar' },
    ],
    morphemes: [
      { id: 'm1', begin: 15, end: 24, precedence: 0, text: 'gid' },
      { id: 'm2', begin: 15, end: 24, precedence: 1, text: 'iyor' },
      { id: 'm3', begin: 15, end: 24, precedence: 2, text: 'lar' },
    ],
  };
  const lines = ilgLinesFor(s, info, proposeIlg(info));
  const morphemes = lines.find((l) => l.key === 'morphemes');
  assert.deepEqual(morphemes.items, ['Çocuklar', 'okula', 'gid', '-iyor', '-lar']);
  // With no word segmented, the line would repeat the Words, and is left out.
  assert.ok(
    !ilgLinesFor({ ...s, morphemes: [] }, info, proposeIlg(info)).some(
      (l) => l.key === 'morphemes',
    ),
  );
});

// Ruled 2026-10-16: the Morphemes line carries IGT's joints, a prefix's or a
// proclitic's after it and any other before, so the file reads back word by
// word instead of as one flat row.
test('the Morphemes line writes the joints IGT draws, and reads back by word', () => {
  const info = layerInfo();
  info.glossLayers.forEach((g) => (g.layer.spans = []));
  const s = {
    ...sentence(),
    words: [
      { id: 'w1', index: 1, begin: 0, end: 13, text: 'tsɨmɨntsarara' },
      { id: 'w2', index: 2, begin: 14, end: 18, text: 'ajan' },
      { id: 'w3', index: 3, begin: 19, end: 24, text: 'mayra' },
    ],
    morphemes: [
      { id: 'm1', begin: 0, end: 13, precedence: 0, text: 'ts', morphType: 'prefix' },
      { id: 'm2', begin: 0, end: 13, precedence: 1, text: 'ɨmɨntsara', morphType: 'stem' },
      { id: 'm3', begin: 0, end: 13, precedence: 2, text: 'ra', morphType: 'suffix' },
      { id: 'm4', begin: 19, end: 24, precedence: 0, text: 'may', morphType: 'stem' },
      { id: 'm5', begin: 19, end: 24, precedence: 1, text: 'ra', morphType: 'enclitic' },
    ],
  };
  const lines = ilgLinesFor(s, info, proposeIlg(info));
  const morphemes = lines.find((l) => l.key === 'morphemes');
  assert.deepEqual(morphemes.items, ['ts-', 'ɨmɨntsara', '-ra', 'ajan', 'may', '=ra']);
  // The canvas keeps the bare forms and draws the joints itself.
  assert.deepEqual(morphemes.perWord, [['ts', 'ɨmɨntsara', 'ra'], ['ajan'], ['may', 'ra']]);
  const [back] = perWordStored([{ key: 'morphemes', items: morphemes.items }], 3);
  assert.deepEqual(back.perWord, [['ts-', 'ɨmɨntsara', '-ra'], ['ajan'], ['may', '=ra']]);
});
