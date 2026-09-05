import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import {
  buildAnchorIndex,
  buildEntryAnchorIndex,
  describeAnchor,
  anchorCaption,
} from './commentAnchors.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';

const makeDoc = (opts = {}) =>
  new IgtDocument({
    raw: buildRawDoc(opts),
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client: makeFakeClient(),
    projectId: 'proj-1',
  });

beforeEach(() => resetIds());

describe('buildAnchorIndex', () => {
  it('describes the document itself', () => {
    const doc = makeDoc();
    const index = buildAnchorIndex(doc);
    expect(index.get(doc.id)).toMatchObject({ kind: 'document' });
  });

  it('numbers sentences the way the grid does, and carries their text', () => {
    const doc = makeDoc({ body: 'the cat' });
    const index = buildAnchorIndex(doc);
    const sentence = doc.sentences[0];

    expect(index.get(sentence.id)).toMatchObject({
      kind: 'sentence',
      label: 'Sentence 1',
      sentenceIndex: 0,
      sentenceId: sentence.id,
    });
    expect(index.get(sentence.id).detail).toContain('the cat');
  });

  it('names a word by its form and places it in its sentence', () => {
    const doc = makeDoc({ body: 'the cat' });
    const index = buildAnchorIndex(doc);
    const word = doc.sentences[0].tokens[1];

    expect(index.get(word.id)).toMatchObject({
      kind: 'word',
      label: 'cat',
      detail: 'sentence 1',
      sentenceIndex: 0,
    });
  });

  it('names a morpheme and says which word it is in', () => {
    const doc = makeDoc({ body: 'the cat' });
    const index = buildAnchorIndex(doc);
    const morph = doc.sentences[0].tokens[1].morphemes[0];

    expect(index.get(morph.id)).toMatchObject({ kind: 'morpheme' });
    expect(index.get(morph.id).detail).toContain('cat');
    expect(index.get(morph.id).detail).toContain('sentence 1');
  });

  it('resolves an annotation span at every scope', async () => {
    const doc = makeDoc({ body: 'the cat' });
    const sentence = doc.sentences[0];
    const word = sentence.tokens[0];
    const morph = word.morphemes[0];

    await doc.updateSentenceSpan(sentence.id, 'Translation', 'The cat.');
    await doc.updateTokenSpan(word.id, 'POS', 'DET');
    await doc.updateMorphemeSpan(morph.id, 'Gloss', 'DEF');

    const index = buildAnchorIndex(doc);
    const after = doc.sentences[0];
    const sentSpan = after.annotations.Translation;
    const wordSpan = after.tokens[0].annotations.POS;
    const morphSpan = after.tokens[0].morphemes[0].annotations.Gloss;

    expect(index.get(sentSpan.id)).toMatchObject({
      kind: 'annotation',
      label: 'Translation of sentence 1',
    });
    expect(index.get(wordSpan.id)).toMatchObject({
      kind: 'annotation',
      label: 'POS of the',
    });
    expect(index.get(morphSpan.id)).toMatchObject({ kind: 'annotation' });
    expect(index.get(morphSpan.id).label).toContain('Gloss of');
  });

  it('trims a long form rather than letting a heading run away', () => {
    const long = 'x'.repeat(80);
    const doc = makeDoc({ body: long, words: [{ id: 'w-1', begin: 0, end: 80 }] });
    const index = buildAnchorIndex(doc);

    const label = index.get('w-1').label;
    expect(label.length).toBeLessThanOrEqual(32);
    expect(label.endsWith('…')).toBe(true);
  });

  it('survives a null document', () => {
    expect(buildAnchorIndex(null).size).toBe(0);
  });
});

describe('describeAnchor for an anchor that is gone', () => {
  it('marks the thread outdated, headed by the caption the comment was posted with', () => {
    const index = buildAnchorIndex(makeDoc({ body: 'the cat' }));
    expect(describeAnchor(index, 'token', 'gone', 'cat, sentence 1')).toMatchObject({
      kind: 'outdated',
      outdated: true,
      label: 'cat, sentence 1',
      jumpId: null,
    });
  });

  it('says what kind of thing it was when there is no caption', () => {
    const index = new Map();
    expect(describeAnchor(index, 'span', 'gone').label).toBe('An annotation that was edited away');
    expect(describeAnchor(index, 'vocab-item', 'gone', '   ').label).toBe(
      'An entry that was deleted',
    );
    expect(describeAnchor(index, 'document', 'gone').label).toBe('This document');
  });

  it('never marks a live anchor outdated', () => {
    const doc = makeDoc({ body: 'the cat' });
    const index = buildAnchorIndex(doc);
    const word = doc.sentences[0].tokens[0];
    expect(describeAnchor(index, 'token', word.id, 'stale caption').outdated).toBeUndefined();
    expect(describeAnchor(index, 'token', word.id).jumpId).toBe(doc.sentences[0].id);
  });
});

describe('anchorCaption', () => {
  it('says where a thing inside a sentence sat, and leaves a sentence as its own label', () => {
    const doc = makeDoc({ body: 'the cat' });
    const index = buildAnchorIndex(doc);
    const sentence = doc.sentences[0];
    expect(anchorCaption(index.get(sentence.tokens[0].id))).toBe('the, sentence 1');
    expect(anchorCaption(index.get(sentence.id))).toBe('Sentence 1');
    expect(anchorCaption(index.get(doc.id))).toBe(index.get(doc.id).label);
    expect(anchorCaption(null)).toBeNull();
  });
});

describe('buildEntryAnchorIndex', () => {
  it('labels an entry by its form with its gloss beside it, and jumps to the entry', () => {
    const index = buildEntryAnchorIndex([
      { id: 'i1', form: 'gam', metadata: { gloss: 'house' } },
      { id: 'i2', form: 'ar' },
      { form: 'no id' },
    ]);
    expect(index.size).toBe(2);
    expect(index.get('i1')).toMatchObject({
      kind: 'entry',
      label: 'gam',
      detail: 'house',
      jumpId: 'i1',
    });
    expect(anchorCaption(index.get('i1'))).toBe('gam, house');
    expect(anchorCaption(index.get('i2'))).toBe('ar');
  });
});
