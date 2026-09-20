// A morpheme's own form, on the canvas and in an exported file.
//
// A morpheme token covers the WHOLE of its word, by the shared token
// hierarchy: the extent says which word the morpheme belongs to and the
// segmentation is in `metadata.form`. Reading the baseline between the
// offsets gave every morpheme of a word the same text, the word itself, so a
// four-morpheme word drew as that word four times over with the right glosses
// underneath.
//
// Through `buildDocumentGraph` on purpose. `ilg.test.js` hands `ilgLinesFor`
// a sentence whose morphemes already carry their text, so it agreed with
// itself while the builder that fills them in was wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentGraph } from '../src/domain/sentenceGraph.js';
import { ilgLinesFor, morphemeJoinersFor, proposeIlg } from '../src/domain/ilg.js';

// "mə́maŋŋəydə wala ." with the first word cut into four morphemes, each of
// them over the whole word, as IGT leaves them.
const BODY = 'mə́maŋŋəydə wala .\n';
const WORD_1 = { begin: 0, end: 11 };
const FORMS = ['mə́-', 'maŋ', '-ŋəy', '-də'];
const GLOSS_LAYER = 'g1';

const layerInfo = () => ({
  textLayer: { id: 'tl', text: { id: 'tx', body: BODY } },
  sentenceTokenLayer: { id: 'sl', tokens: [{ id: 's-1', begin: 0, end: 19, metadata: {} }] },
  wordTokenLayer: {
    id: 'wl',
    tokens: [
      { id: 'w-1', ...WORD_1 },
      { id: 'w-2', begin: 12, end: 16 },
      { id: 'w-3', begin: 17, end: 18 },
    ],
  },
  morphemeTokenLayer: {
    id: 'ml',
    tokens: FORMS.map((form, i) => ({
      id: `m-${i}`,
      ...WORD_1,
      precedence: i + 1,
      metadata: { form },
    })),
  },
  nodeTokenLayer: { id: 'nl', tokens: [] },
  conceptLayer: { id: 'cl', spans: [] },
  relationLayer: { id: 'rl', relations: [] },
  documentGraphLayer: { id: 'dl', relations: [] },
  glossLayers: [{ layer: { id: GLOSS_LAYER, name: 'Gloss' }, scope: 'morpheme', lang: 'en' }],
});

const morphemeLine = (info) => {
  const graph = buildDocumentGraph(info);
  const lines = ilgLinesFor(graph.sentences[0], info, proposeIlg(info));
  return lines.find((l) => l.key === 'morphemes');
};

test('a morpheme reads as its own form, not as the word it spans', () => {
  const graph = buildDocumentGraph(layerInfo());
  assert.deepEqual(
    graph.sentences[0].morphemes.map((m) => m.text),
    FORMS,
  );
});

test('the Morphemes line writes one item per morpheme', () => {
  const line = morphemeLine(layerInfo());
  assert.deepEqual(line.perWord[0], FORMS);
  // Four distinct forms, not the word four times over.
  assert.equal(new Set(line.perWord[0]).size, 4);
  // A word nobody segmented keeps its place on the line.
  assert.deepEqual(line.perWord[1], ['_']);
  assert.deepEqual(line.perWord[2], ['_']);
});

test('a morpheme recording no form falls back to the word it covers', () => {
  const info = layerInfo();
  info.morphemeTokenLayer.tokens = [{ id: 'm-only', ...WORD_1, precedence: 1, metadata: {} }];
  assert.equal(buildDocumentGraph(info).sentences[0].morphemes[0].text, 'mə́maŋŋəydə');
});

test('an emptied form stays empty rather than becoming its word', () => {
  // `form: ''` is IGT's "emptied by hand". Falling back to the word would put
  // back text that a person took away.
  const info = layerInfo();
  info.morphemeTokenLayer.tokens = [
    { id: 'm-blank', ...WORD_1, precedence: 1, metadata: { form: '' } },
    { id: 'm-kept', ...WORD_1, precedence: 2, metadata: { form: '-də' } },
  ];
  assert.deepEqual(
    buildDocumentGraph(info).sentences[0].morphemes.map((m) => m.text),
    ['', '-də'],
  );
  assert.deepEqual(morphemeLine(info).perWord[0], ['_', '-də']);
});

test('a line with nothing on it is not written, which is the existing rule', () => {
  // Every morpheme emptied: `_ _ _` says less than no line at all, and a
  // stored Morphemes line from an import would be pushed out by it.
  const info = layerInfo();
  info.morphemeTokenLayer.tokens = [
    { id: 'm-blank', ...WORD_1, precedence: 1, metadata: { form: '' } },
  ];
  assert.equal(morphemeLine(info), undefined);
});

test('the joint before each morpheme comes from the morph types', () => {
  const info = layerInfo();
  info.morphemeTokenLayer.tokens = [
    { id: 'm-0', ...WORD_1, precedence: 1, metadata: { form: 'mə́', morphType: 'prefix' } },
    { id: 'm-1', ...WORD_1, precedence: 2, metadata: { form: 'maŋ', morphType: 'stem' } },
    { id: 'm-2', ...WORD_1, precedence: 3, metadata: { form: 'ŋəy', morphType: 'enclitic' } },
    { id: 'm-3', ...WORD_1, precedence: 4, metadata: { form: 'də', morphType: 'suffix' } },
  ];
  const graph = buildDocumentGraph(info);
  // Nothing before the first, '=' on either side of the clitic, '-' elsewhere.
  assert.deepEqual(morphemeJoinersFor(graph.sentences[0])[0], ['', '-', '=', '=']);
  // A word nobody segmented has no joints at all.
  assert.deepEqual(morphemeJoinersFor(graph.sentences[0])[1], []);
});

test('a morpheme with no type joins with the default', () => {
  // Every hand-entered morpheme, which carries no morphType at all.
  const graph = buildDocumentGraph(layerInfo());
  assert.deepEqual(morphemeJoinersFor(graph.sentences[0])[0], ['', '-', '-', '-']);
});
