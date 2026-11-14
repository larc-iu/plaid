import { describe, it, expect } from 'vitest';
import { buildRawDoc, makeIgtDoc } from './test-helpers.js';
import { documentPlacer, jobPlacer, vocabularyPlacer } from './undoPlaces.js';
import { leftGroups } from './undoSummary.js';

// Where the Undo dialog points a row it lists as left.

const twoSentences = () => {
  const raw = buildRawDoc({
    body: 'the cat sat',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
    ],
    sentences: [
      { id: 's-1', begin: 0, end: 7 },
      { id: 's-2', begin: 8, end: 11 },
    ],
  });
  const gloss = raw.textLayers[0].tokenLayers
    .flatMap((t) => t.spanLayers || [])
    .find((s) => s.id === 'msl-0');
  gloss.spans = [{ id: 'g3', value: 'sit', tokens: ['m-3'], metadata: {} }];
  return makeIgtDoc({
    raw,
    vocabularies: {
      v1: { id: 'v1', name: 'Lexicon', items: [], vocabLinks: [{ id: 'l2', tokens: ['m-2'] }] },
    },
  });
};

describe('documentPlacer', () => {
  const place = documentPlacer(twoSentences(), { projectId: 'p1', documentId: 'd1' });
  const sentence = (n, id) => ({
    key: id,
    label: `Sentence ${n}`,
    to: `/projects/p1/documents/d1?tab=analyze&focusSentence=${id}`,
  });

  it('places a value, a link, a word and a sentence at the sentence they are in now', () => {
    expect(place({ kind: 'span', id: 'g3' })).toEqual(sentence(2, 's-2'));
    expect(place({ kind: 'vocab-link', id: 'l2' })).toEqual(sentence(1, 's-1'));
    expect(place({ kind: 'token', id: 'w-1' })).toEqual(sentence(1, 's-1'));
    expect(place({ kind: 'token', id: 's-2' })).toEqual(sentence(2, 's-2'));
  });

  it('places the text and the document at their tabs, and a row gone since nowhere', () => {
    expect(place({ kind: 'text', id: 'text-1' })).toEqual({
      key: 'text',
      label: 'Text',
      to: '/projects/p1/documents/d1?tab=baseline',
    });
    expect(place({ kind: 'document', id: 'd1' }).to).toBe('/projects/p1/documents/d1?tab=details');
    expect(place({ kind: 'span', id: 'gone' })).toBeNull();
    expect(place({ kind: 'token', id: 'gone' })).toBeNull();
  });
});

describe('vocabularyPlacer', () => {
  const place = vocabularyPlacer({
    vocabularyId: 'v1',
    vocabularyName: 'Lexicon',
    entryName: (id) => (id === 'i1' ? 'kai' : null),
    documentOf: (id) => (id === 'd1' ? { name: 'Story one', project: 'p1' } : null),
  });

  it('places an entry at itself, a link at its document, unnamed while unread', () => {
    expect(place({ kind: 'vocab-item', id: 'i1', vocabLayer: 'v1' })).toEqual({
      key: 'i1',
      label: 'kai',
      to: '/vocabularies/v1?item=i1',
    });
    expect(place({ kind: 'vocab-item', id: 'i2', vocabLayer: 'v1' }).label).toBe('Entry');
    expect(place({ kind: 'vocab-link', id: 'l1', document: 'd1' })).toEqual({
      key: 'd1',
      label: 'Story one',
      to: '/projects/p1/documents/d1',
    });
    expect(place({ kind: 'vocab-link', id: 'l2', document: 'd2' })).toEqual({
      key: 'd2',
      label: 'Document',
      to: null,
    });
    expect(place({ kind: 'vocab-layer', id: 'v1' }).label).toBe('Lexicon');
  });
});

describe('jobPlacer', () => {
  it('places rows at their documents in the job’s order, then the lexicon', () => {
    const place = jobPlacer({
      projectId: 'p1',
      documents: [
        { documentId: 'd1', name: 'Story one' },
        { documentId: 'd2', name: 'Story two' },
        { documentId: 'd3', name: null },
      ],
      vocabs: [{ id: 'v1', name: 'Story lexicon' }],
    });
    const summary = {
      skipped: [
        { kind: 'vocab-item', id: 'i1', vocabLayer: 'v1', reason: 'changed-since' },
        { kind: 'span', id: 's2', document: 'd2', reason: 'changed-since' },
        { kind: 'span', id: 's3', document: 'd2', reason: 'changed-since' },
        { kind: 'span', id: 's1', document: 'd1', reason: 'changed-since' },
        { kind: 'token', id: 't9', document: 'd3', reason: 'changed-since' },
      ],
    };
    expect(leftGroups(summary, place)[0].places.map((p) => [p.label, p.to, p.count])).toEqual([
      ['Story one', '/projects/p1/documents/d1', 1],
      ['Story two', '/projects/p1/documents/d2', 2],
      ['Deleted document', null, 1],
      ['Story lexicon', '/vocabularies/v1', 1],
    ]);
  });
});
