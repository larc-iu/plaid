import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildAnchorIndex, describeAnchor } from './commentAnchors.js';
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

describe('describeAnchor', () => {
  it('falls back honestly when the anchor is gone', () => {
    const index = buildAnchorIndex(makeDoc());
    // A stale client between a delete and a reload: better than a raw uuid.
    expect(describeAnchor(index, 'span', 'no-such-id')).toMatchObject({
      kind: 'unknown',
      label: 'Deleted',
    });
    expect(describeAnchor(index, 'document', 'no-such-id').label).toBe('This document');
  });
});
