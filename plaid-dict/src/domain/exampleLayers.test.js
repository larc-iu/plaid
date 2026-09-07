import { describe, it, expect } from 'vitest';
import { discoverExampleLayers, exampleDocumentIds, sentenceLayerNames } from './exampleLayers.js';

const item = (examples) => ({ id: 'x', form: 'f', metadata: examples ? { examples } : {} });

// A project as the server returns one: the sentence token layer's span layers
// are the ones a dictionary can show under an example.
const project = (names) => ({
  id: 'p1',
  textLayers: [
    {
      config: { plaid: { role: 'baseline' } },
      tokenLayers: [
        {
          config: { plaid: { role: 'sentence' } },
          spanLayers: names.map((name) => ({ name, config: { igt: { scope: 'Sentence' } } })),
        },
        {
          config: { plaid: { role: 'word' } },
          spanLayers: [{ name: 'Gloss', config: { igt: { scope: 'Word' } } }],
        },
      ],
    },
  ],
});

describe('exampleDocumentIds', () => {
  it('gathers each document once, ignoring imported examples', () => {
    expect(
      exampleDocumentIds([
        item([{ document: 'd1', token: 't1' }, { text: 'imported' }]),
        item([
          { document: 'd1', token: 't2' },
          { document: 'd2', token: 't3' },
        ]),
        item(null),
      ]),
    ).toEqual(['d1', 'd2']);
  });

  it('is empty when nothing points into a document', () => {
    expect(exampleDocumentIds([item([{ text: 'imported' }]), item(null)])).toEqual([]);
    expect(exampleDocumentIds(null)).toEqual([]);
  });
});

describe('sentenceLayerNames', () => {
  it('takes the sentence layers and leaves the word ones', () => {
    expect(sentenceLayerNames(project(['Translation', 'Note']))).toEqual(['Translation', 'Note']);
  });
});

describe('discoverExampleLayers', () => {
  const client = (docs, projects) => ({
    reads: [],
    documents: {
      get(id) {
        const found = docs[id];
        return found ? Promise.resolve(found) : Promise.reject(new Error('404'));
      },
    },
    projects: {
      get(id) {
        const found = projects[id];
        return found ? Promise.resolve(found) : Promise.reject(new Error('403'));
      },
    },
  });

  it('unions the layers of every project the examples reach, in order', async () => {
    const c = client(
      { d1: { project: 'p1' }, d2: { project: 'p2' } },
      { p1: project(['Translation', 'Note']), p2: project(['Note', 'Free translation']) },
    );
    const names = await discoverExampleLayers(c, [
      item([{ document: 'd1', token: 't1' }]),
      item([{ document: 'd2', token: 't2' }]),
    ]);
    expect(names).toEqual(['Translation', 'Note', 'Free translation']);
  });

  it('skips a document or project it cannot read rather than failing the lot', async () => {
    const c = client({ d2: { project: 'p2' } }, { p2: project(['Translation']) });
    const names = await discoverExampleLayers(c, [
      item([{ document: 'gone', token: 't1' }]),
      item([{ document: 'd2', token: 't2' }]),
    ]);
    expect(names).toEqual(['Translation']);
  });

  it('asks for nothing when no example points into a document', async () => {
    const c = client({}, {});
    expect(await discoverExampleLayers(c, [item([{ text: 'imported' }])])).toEqual([]);
  });
});
