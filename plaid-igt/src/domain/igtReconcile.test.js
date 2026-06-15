import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';
import { planMorphemeReconcile, planSpanDedup } from './igtReconcile.js';
import { getIgtLayerInfo } from './layerInfo.js';

const makeDoc = (raw, client) => new IgtDocument({
  raw,
  project: { id: 'proj-1', vocabs: [], config: {} },
  vocabularies: {},
  client,
  projectId: 'proj-1',
});

const twoWords = [{ id: 'w-1', begin: 0, end: 3 }, { id: 'w-2', begin: 4, end: 7 }];
const m = (id, begin, end) => ({ id, text: 'text-1', begin, end, precedence: 1, metadata: {} });

beforeEach(() => resetIds());

describe('planMorphemeReconcile', () => {
  it('flags a bare word (no full-width morpheme)', () => {
    const raw = buildRawDoc({ words: twoWords, morphemes: [m('m-1', 0, 3)] });
    const plan = planMorphemeReconcile(getIgtLayerInfo(raw));
    expect(plan.wordsNeedingMorpheme.map(w => w.id)).toEqual(['w-2']);
    expect(plan.orphanMorphemeIds).toEqual([]);
  });

  it('flags an orphan morpheme (extent matches no word)', () => {
    const raw = buildRawDoc({
      words: twoWords,
      morphemes: [m('m-1', 0, 3), m('m-2', 4, 7), m('m-orphan', 3, 4)],
    });
    const plan = planMorphemeReconcile(getIgtLayerInfo(raw));
    expect(plan.wordsNeedingMorpheme).toEqual([]);
    expect(plan.orphanMorphemeIds).toEqual(['m-orphan']);
  });

  it('deletes an annotated orphan too, reporting the count', () => {
    // Annotated orphans used to be kept; now we delete them as well (the gloss
    // loss is rare + recoverable via document history), and report how many
    // carried annotations so the caller can warn loudly.
    const layerInfo = {
      primaryTokenLayer: { tokens: [{ id: 'w-1', begin: 0, end: 3 }] },
      morphemeTokenLayer: { tokens: [
        { id: 'm-1', begin: 0, end: 3 },      // full-width over the word — fine
        { id: 'm-orphan', begin: 5, end: 8 }, // orphan, annotated below
      ] },
      spanLayers: { morpheme: [
        { id: 'gloss', spans: [{ id: 's1', tokens: ['m-orphan'], value: 'PST' }] },
      ] },
    };
    const plan = planMorphemeReconcile(layerInfo);
    expect(plan.orphanMorphemeIds).toEqual(['m-orphan']);  // deleted now
    expect(plan.deletedAnnotatedOrphans).toBe(1);
  });

  it('is empty for a well-formed doc', () => {
    const plan = planMorphemeReconcile(getIgtLayerInfo(buildRawDoc()));
    expect(plan.wordsNeedingMorpheme).toEqual([]);
    expect(plan.orphanMorphemeIds).toEqual([]);
  });

  it('is empty when there is no morpheme layer (foreign project not yet adopted)', () => {
    expect(planMorphemeReconcile({ primaryTokenLayer: { tokens: twoWords } }))
      .toEqual({ wordsNeedingMorpheme: [], orphanMorphemeIds: [], deletedAnnotatedOrphans: 0 });
  });
});

describe('planSpanDedup', () => {
  const layerInfoWith = (spans) => ({
    spanLayers: { sentence: [{ id: 'sl-trans', name: 'Translation', spans }] },
  });

  it('joins distinct duplicate values into the first span, deletes the rest', () => {
    const plans = planSpanDedup(layerInfoWith([
      { id: 's1', tokens: ['snt1'], value: 'left half' },
      { id: 's2', tokens: ['snt1'], value: 'right half' },
      { id: 's3', tokens: ['snt2'], value: 'unrelated' },
    ]));
    expect(plans).toEqual([{
      scope: 'sentence', layerId: 'sl-trans', layerName: 'Translation', tokenId: 'snt1',
      keepSpanId: 's1', mergedValue: 'left half | right half',
      needsUpdate: true, deleteSpanIds: ['s2'],
    }]);
  });

  it('collapses identical duplicates without joining', () => {
    const plans = planSpanDedup(layerInfoWith([
      { id: 's1', tokens: ['snt1'], value: 'same' },
      { id: 's2', tokens: ['snt1'], value: 'same' },
    ]));
    expect(plans[0].mergedValue).toBe('same');
    expect(plans[0].needsUpdate).toBe(false);
    expect(plans[0].deleteSpanIds).toEqual(['s2']);
  });

  it('skips empty values when joining', () => {
    const plans = planSpanDedup(layerInfoWith([
      { id: 's1', tokens: ['snt1'], value: '' },
      { id: 's2', tokens: ['snt1'], value: 'only real value' },
    ]));
    expect(plans[0].mergedValue).toBe('only real value');
    expect(plans[0].needsUpdate).toBe(true);
  });

  it('dedupes at word and morpheme scope too (derive renders first-wins at every scope)', () => {
    const plans = planSpanDedup({ spanLayers: {
      word: [{ id: 'wsl', name: 'POS', spans: [
        { id: 'a', tokens: ['w1'], value: 'NOUN' },
        { id: 'b', tokens: ['w1'], value: 'VERB' },
      ] }],
      morpheme: [{ id: 'msl', name: 'Gloss', spans: [
        { id: 'c', tokens: ['m1'], value: 'cat' },
        { id: 'd', tokens: ['m1'], value: 'CAT' },
      ] }],
    } });
    expect(plans.map(p => p.scope).sort()).toEqual(['morpheme', 'word']);
    expect(plans.find(p => p.scope === 'word')).toMatchObject({
      layerName: 'POS', tokenId: 'w1', keepSpanId: 'a', mergedValue: 'NOUN | VERB', deleteSpanIds: ['b'],
    });
    expect(plans.find(p => p.scope === 'morpheme')).toMatchObject({
      layerName: 'Gloss', tokenId: 'm1', keepSpanId: 'c', mergedValue: 'cat | CAT', deleteSpanIds: ['d'],
    });
  });

  it('leaves singletons and multi-token spans alone', () => {
    expect(planSpanDedup(layerInfoWith([
      { id: 's1', tokens: ['snt1'], value: 'fine' },
      { id: 's2', tokens: ['snt1', 'snt2'], value: 'exotic multi-token span' },
    ]))).toEqual([]);
    expect(planSpanDedup({})).toEqual([]);
  });
});

describe('IgtDocument.reconcileOnOpen', () => {
  it('creates a default morpheme for a bare word', async () => {
    const raw = buildRawDoc({ words: twoWords, morphemes: [m('m-1', 0, 3)] });
    const client = makeFakeClient();
    const doc = makeDoc(raw, client);

    const res = await doc.reconcileOnOpen();

    expect(res).toMatchObject({ created: 1, deleted: 0 });
    expect(client.calls.filter(c => c.kind === 'tokens.create').length).toBe(1);
    const morphemes = doc.layerInfo.morphemeTokenLayer.tokens;
    expect(morphemes.length).toBe(2);
    // the new morpheme is full-width over the bare word [4, 7]
    expect(morphemes.some(t => t.begin === 4 && t.end === 7)).toBe(true);
  });

  it('deletes an orphan morpheme', async () => {
    const raw = buildRawDoc({
      words: twoWords,
      morphemes: [m('m-1', 0, 3), m('m-2', 4, 7), m('m-orphan', 3, 4)],
    });
    const client = makeFakeClient();
    const doc = makeDoc(raw, client);

    const res = await doc.reconcileOnOpen();

    expect(res).toMatchObject({ created: 0, deleted: 1 });
    expect(client.calls.filter(c => c.kind === 'tokens.bulkDelete').length).toBe(1);
    const ids = doc.layerInfo.morphemeTokenLayer.tokens.map(t => t.id);
    expect(ids).not.toContain('m-orphan');
    expect(ids.length).toBe(2);
  });

  it('no-ops on a well-formed doc (convergent — no batch submitted)', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc(), client);

    const res = await doc.reconcileOnOpen();

    expect(res).toMatchObject({ created: 0, deleted: 0, findings: [] });
    expect(client.calls.filter(c => c.kind === 'submitBatch').length).toBe(0);
  });

  it('deletes an annotated orphan morpheme and reports deletedAnnotatedOrphans', async () => {
    const raw = buildRawDoc({
      words: twoWords,
      morphemes: [m('m-1', 0, 3), m('m-2', 4, 7), m('m-orphan', 3, 4)],
    });
    // Annotate the orphan; it should still be deleted, the gloss cascading away.
    raw.textLayers[0].tokenLayers[2].spanLayers[0].spans.push({ id: 'g1', tokens: ['m-orphan'], value: 'PST' });
    const client = makeFakeClient();
    const doc = makeDoc(raw, client);

    const res = await doc.reconcileOnOpen();

    expect(res).toMatchObject({ created: 0, deleted: 1, deletedAnnotatedOrphans: 1 });
    const ids = doc.layerInfo.morphemeTokenLayer.tokens.map(t => t.id);
    expect(ids).not.toContain('m-orphan');
  });

  it('dedupes duplicate morpheme spans (any scope), joining values', async () => {
    const raw = buildRawDoc();
    // Two Gloss spans on the same morpheme — invisible + immortal in the editor
    // (derive renders only the first), so reconcile joins them losslessly.
    raw.textLayers[0].tokenLayers[2].spanLayers[0].spans.push(
      { id: 'g-a', tokens: ['m-1'], value: 'the' },
      { id: 'g-b', tokens: ['m-1'], value: 'THE' },
    );
    const client = makeFakeClient();
    const doc = makeDoc(raw, client);

    const res = await doc.reconcileOnOpen();

    expect(res.dedupedSpans).toBe(1);
    expect(client.calls.some(c => c.kind === 'spans.update')).toBe(true);
    expect(client.calls.some(c => c.kind === 'spans.delete')).toBe(true);
    const glossSpans = doc.layerInfo.morphemeTokenLayer.spanLayers[0].spans;
    expect(glossSpans.length).toBe(1);
    expect(glossSpans[0].value).toBe('the | THE');
  });
});
