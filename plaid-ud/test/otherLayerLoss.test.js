// What a delete, a clear or a sentence split in the Text Editor takes on the
// text's OTHER layers, whoever made them, counted by layer and naming no app
// (N1-CASCADE-2 to -4). The document is a UD import with a second annotation
// layer under the words, as any other app sharing the project would add:
// morphemes with glosses and vocabulary links, a gloss on a word, and a
// relation layer that keeps its relations inside one sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

const INPUT = [
  '# text = she came home',
  '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t_\t_',
  '2\tcame\tcome\tVERB\t_\t_\t0\troot\t_\t_',
  '3\thome\thome\tNOUN\t_\t_\t2\tobj\t_\t_',
].join('\n');

const open = () => {
  const raw = rawDocFromConllu(INPUT, 'loss');
  const layers = raw.textLayers[0].tokenLayers;
  const [sentences, words, synWords] = layers;
  words.parentTokenLayer = sentences.id;
  synWords.parentTokenLayer = words.id;
  const body = raw.textLayers[0].text.body;
  const word = (form) => words.tokens.find((t) => body.slice(t.begin, t.end) === form);
  const she = word('she');
  const came = word('came');
  // Another layer under the words: "came" in two morphemes, each glossed and
  // linked, and a relation from "she" to "came" that stays in one sentence.
  layers.push({
    id: 'other-morphs',
    parentTokenLayer: words.id,
    tokens: [
      { id: 'om1', begin: came.begin, end: came.begin + 2 },
      { id: 'om2', begin: came.begin + 2, end: came.end },
      { id: 'om3', begin: she.begin, end: she.end },
    ],
    spanLayers: [
      {
        id: 'other-gloss',
        spans: [
          { id: 'og1', tokens: ['om1'], value: 'CO' },
          { id: 'og2', tokens: ['om2'], value: 'ME' },
          { id: 'og3', tokens: ['om3'], value: '3SG' },
        ],
        relationLayers: [
          {
            id: 'other-rel',
            constraints: { other: [{ type: 'same-ancestor', tokenLayer: sentences.id }] },
            relations: [{ id: 'or1', source: 'og3', target: 'og1', value: 'x' }],
          },
        ],
      },
    ],
    vocabs: [
      {
        id: 'v',
        vocabLinks: [
          { id: 'k1', tokens: ['om1'] },
          { id: 'k2', tokens: ['om2'] },
        ],
      },
    ],
  });
  words.spanLayers = [{ id: 'word-gloss', spans: [{ id: 'wg', tokens: [came.id], value: 'G' }] }];
  const doc = new ConlluDocument({ raw, client: {} });
  return { doc, she, came, word, body };
};

test("deleting a token counts what the other layers hold on it, and none of UD's own", () => {
  const { doc, came, word } = open();
  // The word gloss, two morpheme glosses and the relation on one, two links.
  assert.deepEqual(doc.otherLossForWord(came), {
    annotations: 4,
    links: 2,
    shortened: { annotations: 0, links: 0 },
  });
  // "home" has UD annotations only, which annotationLossForWord counts.
  assert.deepEqual(doc.otherLossForWord(word('home')), {
    annotations: 0,
    links: 0,
    shortened: { annotations: 0, links: 0 },
  });
  assert.ok(doc.annotationLossForWord(word('home')).annotations > 0);
});

test('Clear tokens counts every layer, with the tokens it deletes', () => {
  const { doc } = open();
  const loss = doc.clearLoss();
  assert.equal(loss.sentences, 1);
  assert.equal(loss.tokens, 3);
  assert.equal(loss.words, 3);
  assert.equal(loss.links, 2);
  // UD: 3 lemmas, 3 UPOS, 3 relations. Other layers: 1 word gloss, 3 morpheme
  // glosses, 1 relation. The sentence's `text` metadata is its own content.
  assert.equal(loss.annotations, 9 + 5 + 1);
});

test('a sentence split counts the relations another layer would lose, not the tree', () => {
  const { doc, came, body } = open();
  // Between "she" and "came": the other layer's relation crosses.
  assert.deepEqual(doc.otherLossForSentenceSplit(came.begin), { annotations: 1, links: 0 });
  // Before "home": nothing of the other layer crosses. The tree's obj does,
  // which this editor deletes on its own.
  const home = body.indexOf('home');
  assert.deepEqual(doc.otherLossForSentenceSplit(home), { annotations: 0, links: 0 });
  assert.deepEqual(doc.otherLossForSentenceSplit(0), { annotations: 0, links: 0 });
});

// REV-N5-CORE F3: once the sentences are cleared, the sentences Tokenize makes
// can cut the other layer's relation.
test("Tokenize counts the relations its new sentences cut, and none of UD's own", () => {
  const { doc } = open();
  doc.layerInfo.sentenceTokenLayer.tokens = [];
  // One line, one sentence: nothing is cut.
  assert.deepEqual(doc.tokenizeLoss('she came home'), { annotations: 0, links: 0 });
  // A break between "she" and "came" cuts the other layer's relation. The
  // tree's nsubj crosses it as well, and is UD's own.
  assert.deepEqual(doc.tokenizeLoss('she\ncame home'), { annotations: 1, links: 0 });
  // A service's breaks are not known: the most they can take.
  assert.deepEqual(doc.tokenizeLoss(null), { annotations: 1, links: 0 });
});

// A parse keeps the sentences and words a document has, and makes its own
// only when it lacks them. Then it counts like a tokenizer service.
test('Parse counts only when it makes the sentences', () => {
  const { doc } = open();
  assert.deepEqual(doc.parseLoss(), { annotations: 0, links: 0 });
  doc.layerInfo.sentenceTokenLayer.tokens = [];
  doc.layerInfo.wordTokenLayer.tokens = [];
  assert.deepEqual(doc.parseLoss(), { annotations: 1, links: 0 });
});

// REV-N5-APPS R5: a segmentation with nothing on it is someone's work, counted
// as Clear tokens counts it. R8: a link that keeps another token is shortened,
// not deleted. A multiword token's own form is this editor's, not counted here.
test('Delete token counts a bare segmentation, and names a shortened link apart', () => {
  const { doc, came, she } = open();
  const layers = doc.layerInfo.textLayer.tokenLayers;
  const other = layers.find((tl) => tl.id === 'other-morphs');
  other.spanLayers[0].spans = [];
  other.spanLayers[0].relationLayers[0].relations = [];
  other.vocabs[0].vocabLinks = [{ id: 'mwe', tokens: [she.id, came.id] }];
  doc.layerInfo.wordTokenLayer.spanLayers = [];
  other.tokens[0].metadata = { form: 'ca', boundaries: '-' };
  other.tokens[1].metadata = { form: 'me' };
  came.metadata = { form: 'came' };
  assert.deepEqual(doc.otherLossForWord(came), {
    annotations: 2,
    links: 0,
    shortened: { annotations: 0, links: 1 },
  });
});

// REV-N5-APPS R3: the relations the server's rule deletes in the split's own
// transaction leave this copy with it, so splitting there again, after a merge
// back, counts nothing.
test('a split drops the relations it cuts on other layers, and counts none the second time', async () => {
  const { doc, came } = open();
  doc._client = withOps({
    tokens: { split: async () => ({ id: 'right' }), merge: async () => ({}) },
  });
  assert.equal(doc.otherLossForSentenceSplit(came.begin).annotations, 1);
  await doc.toggleSentenceBoundary(came.begin);
  const rel = doc.layerInfo.textLayer.tokenLayers.find((tl) => tl.id === 'other-morphs')
    .spanLayers[0].relationLayers[0].relations;
  assert.deepEqual(rel, []);
  await doc.toggleSentenceBoundary(came.begin);
  assert.equal(doc.layerInfo.sentenceTokenLayer.tokens.length, 1);
  assert.equal(doc.otherLossForSentenceSplit(came.begin).annotations, 0);
});
