// provProb is the probability of the value a span holds. A pick of one of the
// alternatives a producer weighed carries that alternative's, and a typed
// value carries none (PICKER-REAL ruling, 2026-10-21).
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
const patches = (client) =>
  client.calls.filter((c) => c.kind === 'spans.patchMetadata').map((c) => c.args?.[1] ?? c.ops);

beforeEach(() => resetIds());

describe('provProb follows the value', () => {
  it('a typed value drops it', async () => {
    const { doc } = machineGloss();
    await doc.updateMorphemeSpan('m-1', 'Gloss', '1sg-ERG');
    await settle(4);
    expect(glossMeta(doc).provProb).toBeUndefined();
    expect(glossMeta(doc).provConfirmed).toBe(true);
    expect(glossMeta(doc).provDetail.valueProbs.was).toBe(0.62);
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
