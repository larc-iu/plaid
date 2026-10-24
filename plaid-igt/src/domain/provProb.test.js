// provProb is the producer's probability for the value a span holds, however
// it was entered (R5, Luke 2026-10-24, superseding PICKER-REAL's "a typed
// value carries none"): a value the producer weighed carries its probability,
// picked or typed, and a value it never weighed carries none.
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRawDoc, makeFakeClient, resetIds, makeIgtDoc, settle } from './test-helpers.js';

const machineGloss = () => {
  const raw = buildRawDoc();
  const gloss = raw.textLayers[0].tokenLayers[2].spanLayers[0];
  gloss.spans.push({
    id: 'sp-1',
    tokens: ['m-1'],
    value: 'was',
    metadata: {
      prov: 'inferred',
      provSource: 'service:m',
      provProb: 0.62,
      provDetail: { valueProbs: { was: 0.62, cop: 0.04 } },
    },
  });
  const client = makeFakeClient({ reloadDoc: structuredClone(raw) });
  const doc = makeIgtDoc({
    raw,
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client,
    user: { id: 'wren@example.com' },
  });
  return { doc, client };
};
const glossMeta = (doc) => doc.sentences[0].tokens[0].morphemes[0].annotations.Gloss.metadata;

beforeEach(() => resetIds());

describe('provProb follows the value', () => {
  it('a typed value the producer never weighed drops it', async () => {
    const { doc } = machineGloss();
    await doc.updateMorphemeSpan('m-1', 'Gloss', '1sg-ERG');
    await settle(4);
    expect(glossMeta(doc).provProb).toBeUndefined();
    expect(glossMeta(doc).provConfirmed).toBe(true);
    expect(glossMeta(doc).provDetail.valueProbs.was).toBe(0.62);
  });

  it('a typed value the producer weighed carries its probability', async () => {
    const { doc } = machineGloss();
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'cop');
    await settle(4);
    expect(glossMeta(doc).provProb).toBe(0.04);
    expect(glossMeta(doc).provConfirmed).toBe(true);
  });

  it('a pick sets the picked alternative’s', async () => {
    const { doc } = machineGloss();
    await doc.setMorphemePair('m-1', { field: 'Gloss', value: 'cop', prob: 0.04 });
    await settle(4);
    expect(glossMeta(doc).provProb).toBe(0.04);
    expect(glossMeta(doc).provConfirmed).toBe(true);
  });

  it('a pick from a value list carries its probability through the span updater', async () => {
    const { doc } = machineGloss();
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'cop', null, { adopted: true, prob: 0.04 });
    await settle(4);
    expect(glossMeta(doc).provProb).toBe(0.04);
  });
});

// A morpheme's provProb is the producer's probability for its form (CWoMP
// writes one per morpheme), so a form a person changes drops it too.
const machineMorpheme = () => {
  const raw = buildRawDoc();
  raw.textLayers[0].tokenLayers[2].tokens[0].metadata = {
    form: 'the',
    prov: 'inferred',
    provSource: 'service:m',
    provProb: 0.7,
    provDetail: { form: 'the', formProbs: { the: 0.7, thee: 0.2 } },
  };
  const client = makeFakeClient({ reloadDoc: structuredClone(raw) });
  const doc = makeIgtDoc({
    raw,
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client,
    user: { id: 'wren@example.com' },
  });
  return { doc, client };
};
const morphemeMeta = (doc) =>
  doc._raw.textLayers[0].tokenLayers[2].tokens.find((t) => t.id === 'm-1').metadata;

describe('provProb follows a morpheme form', () => {
  it('a typed form the producer never weighed drops it, provDetail stays', async () => {
    const { doc } = machineMorpheme();
    await doc.updateMorphemeForm('m-1', 'thy');
    await settle(4);
    expect(morphemeMeta(doc).provProb).toBeUndefined();
    expect(morphemeMeta(doc).provConfirmed).toBe(true);
    expect(morphemeMeta(doc).provDetail.form).toBe('the');
  });

  it('a typed form the producer weighed carries its probability', async () => {
    const { doc } = machineMorpheme();
    await doc.updateMorphemeForm('m-1', 'thee');
    await settle(4);
    expect(morphemeMeta(doc).provProb).toBe(0.2);
    expect(morphemeMeta(doc).provConfirmed).toBe(true);
  });

  it('a re-typed form that changes nothing keeps it', async () => {
    const { doc } = machineMorpheme();
    await doc.updateMorphemeForm('m-1', 'the');
    await settle(4);
    expect(morphemeMeta(doc).provProb).toBe(0.7);
    expect(morphemeMeta(doc).provConfirmed).toBe(true);
  });

  it('a split drops it from the piece whose form changed', async () => {
    const { doc } = machineMorpheme();
    await doc.splitMorpheme('m-1', 'th', 'e');
    await settle(4);
    expect(morphemeMeta(doc).form).toBe('th');
    expect(morphemeMeta(doc).provProb).toBeUndefined();
  });
});
