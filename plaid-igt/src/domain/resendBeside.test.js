// An edit to what igt keeps beside the document (its vocabulary links and
// entries) is never sent again by itself after a refusal (REV-F-NET D-3b,
// decision D21): the document read does not show another user's link, and a
// link sent again over one left a morpheme with two. A gloss is not beside
// the document, and still goes again when another user wrote elsewhere.
import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';

const makeDoc = () => {
  const raw = buildRawDoc();
  const doc = new IgtDocument({
    raw: structuredClone(raw),
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
    vocabularies: {
      v1: {
        id: 'v1',
        name: 'Lexicon',
        items: [{ id: 'vi-1', form: 'CAT', metadata: {} }],
        vocabLinks: [],
      },
    },
    client: makeFakeClient({ reloadDoc: structuredClone(raw) }),
    projectId: 'proj-1',
  });
  // Whether each write, as it is queued, changed what is kept beside.
  const beside = [];
  const queue = doc._queueWrite.bind(doc);
  doc._queueWrite = (...args) => {
    beside.push(doc._patchesBeside);
    return queue(...args);
  };
  return { doc, beside };
};

const word = (doc, i) => doc.sentences[0].tokens[i];

beforeEach(() => resetIds());

describe('what igt keeps beside the document', () => {
  it('is changed by a link and by a new entry', async () => {
    const { doc, beside } = makeDoc();
    await doc.linkVocab('w-2', 'vi-1');
    await doc.createAndLinkVocabItem('w-1', 'v1', 'THE');
    expect(beside).toEqual([true, true]);
  });

  it('is not changed by a gloss', async () => {
    const { doc, beside } = makeDoc();
    await doc.updateMorphemeSpan(word(doc, 0).morphemes[0].id, 'Gloss', 'DEF');
    expect(beside).toEqual([false]);
  });
});
