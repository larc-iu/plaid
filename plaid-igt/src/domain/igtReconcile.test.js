import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';
import { planMorphemeReconcile } from './igtReconcile.js';
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

  it('keeps an annotated orphan morpheme instead of deleting it', () => {
    // An orphan morpheme that carries a gloss must NOT be auto-deleted (a token
    // delete would cascade its annotation spans away).
    const layerInfo = {
      primaryTokenLayer: { tokens: [{ id: 'w-1', begin: 0, end: 3 }] },
      morphemeTokenLayer: { tokens: [
        { id: 'm-1', begin: 0, end: 3 },      // full-width over the word — fine
        { id: 'm-orphan', begin: 5, end: 8 }, // orphan, but annotated below
      ] },
      spanLayers: { morpheme: [
        { id: 'gloss', spans: [{ id: 's1', tokens: ['m-orphan'], value: 'PST' }] },
      ] },
    };
    const plan = planMorphemeReconcile(layerInfo);
    expect(plan.orphanMorphemeIds).toEqual([]);  // annotated orphan is kept
    expect(plan.keptAnnotatedOrphans).toBe(1);
  });

  it('is empty for a well-formed doc', () => {
    const plan = planMorphemeReconcile(getIgtLayerInfo(buildRawDoc()));
    expect(plan.wordsNeedingMorpheme).toEqual([]);
    expect(plan.orphanMorphemeIds).toEqual([]);
  });

  it('is empty when there is no morpheme layer (foreign project not yet adopted)', () => {
    expect(planMorphemeReconcile({ primaryTokenLayer: { tokens: twoWords } }))
      .toEqual({ wordsNeedingMorpheme: [], orphanMorphemeIds: [], keptAnnotatedOrphans: 0 });
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

    expect(res).toMatchObject({ created: 0, deleted: 0 });
    expect(client.calls.filter(c => c.kind === 'submitBatch').length).toBe(0);
  });
});
