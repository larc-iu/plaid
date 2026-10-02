import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';
import { planMorphTypeSync, planPreserveOnSplit, describeReconcile } from './igtReconcile.js';

const makeDoc = (raw, client) =>
  new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [], config: {} },
    vocabularies: {},
    client,
    projectId: 'proj-1',
  });

const twoWords = [
  { id: 'w-1', begin: 0, end: 3 },
  { id: 'w-2', begin: 4, end: 7 },
];
const m = (id, begin, end) => ({ id, text: 'text-1', begin, end, precedence: 1, metadata: {} });

beforeEach(() => resetIds());

describe('planMorphTypeSync', () => {
  // derive resolves an entry's type through its headword and hands it over
  // as `entryMorphType`; a sense with none of its own still syncs the cache.
  it("writes the entry's resolved type onto a morpheme whose cache differs", () => {
    const sense = { id: 's1', form: 'ler', metadata: { parent: 'h1' } };
    const sentences = [
      {
        tokens: [
          {
            morphemes: [
              {
                id: 'm1',
                metadata: { morphType: null },
                vocabItem: sense,
                entryMorphType: 'suffix',
              },
              {
                id: 'm2',
                metadata: { morphType: 'suffix' },
                vocabItem: sense,
                entryMorphType: 'suffix',
              },
              { id: 'm3', metadata: { morphType: 'stem' }, vocabItem: sense, entryMorphType: null },
            ],
          },
        ],
      },
    ];
    expect(planMorphTypeSync(sentences)).toEqual([{ morphemeId: 'm1', morphType: 'suffix' }]);
  });
});

describe('describeReconcile', () => {
  it('names each repair, and says nothing when nothing was written', () => {
    expect(describeReconcile({})).toBeNull();
    expect(describeReconcile({ syncedMorphTypes: 2 })).toBe(
      'Repaired: synced 2 morpheme types from lexicon entries',
    );
    expect(describeReconcile({ rulesDeclared: true })).toBe(
      'Repaired: applied the annotation rules',
    );
    expect(describeReconcile({ rulesRepaired: true, rulesDeclared: true })).toBe(
      'Repaired: fixed annotations the annotation rules forbid, applied the annotation rules',
    );
  });

  it('ignores what is not a repair', () => {
    expect(describeReconcile({ findings: [{}] })).toBeNull();
  });
});

describe('IgtDocument.reconcileOnOpen', () => {
  it('writes nothing for a bare word, which derives a morpheme of its own', async () => {
    const raw = buildRawDoc({ words: twoWords, morphemes: [m('m-1', 0, 3)] });
    const client = makeFakeClient();
    const doc = makeDoc(raw, client);

    const res = await doc.reconcileOnOpen();

    expect(res).toMatchObject({ syncedMorphTypes: 0, rulesDeclared: false });
    expect(client.calls.filter((c) => c.kind.startsWith('tokens.')).length).toBe(0);
    // Still one stored morpheme, and w-2 shows one anyway.
    expect(doc.layerInfo.morphemeTokenLayer.tokens.length).toBe(1);
    const [first, second] = doc.sentences[0].tokens;
    expect(first.morphemes[0].id).toBe('m-1');
    expect(first.morphemes[0].virtual).toBeUndefined();
    expect(second.morphemes[0]).toMatchObject({ id: 'virtual:w-2', virtual: true });
  });

  it('no-ops on a well-formed doc (convergent — no batch submitted)', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc(), client);

    const res = await doc.reconcileOnOpen();

    expect(res).toMatchObject({ syncedMorphTypes: 0, findings: [] });
    expect(client.calls.filter((c) => c.kind === 'batch.submit').length).toBe(0);
  });

  // The prod case of 2026-09-12: an entry was linked, THEN given a morph type
  // from the entry editor, which is not a document context and so patches no
  // cache. Opening the document synced it, and the audit entry said only
  // "Reconcile layers on open" over ops reading "Patch metadata on token
  // 01a08827-... with 1 keys". It names the repair now.
  it('syncs a morph type the entry gained after the link, and says so in the audit label', async () => {
    const raw = buildRawDoc();
    const client = makeFakeClient();
    const doc = new IgtDocument({
      raw,
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: {} },
      vocabularies: {
        v1: {
          id: 'v1',
          items: [{ id: 'i1', form: 'the', metadata: { morphType: 'stem' } }],
          // Linked while the entry had no type; the type came later.
          vocabLinks: [{ id: 'lk-1', tokens: ['m-1'], vocabItem: { id: 'i1', form: 'the' } }],
        },
      },
      client,
      projectId: 'proj-1',
    });

    const res = await doc.reconcileOnOpen();

    expect(res.syncedMorphTypes).toBe(1);
    const patches = client.calls.filter((c) => c.kind === 'tokens.patchMetadata');
    expect(patches).toHaveLength(1);
    expect(patches[0].args).toEqual(['m-1', [{ op: 'set', path: ['morphType'], value: 'stem' }]]);
    // The entry the History drawer shows.
    const relabel = client.calls.filter((c) => c.kind === 'operationGroups.update');
    expect(relabel).toHaveLength(1);
    expect(relabel[0].args[1]).toBe('Repaired: synced 1 morpheme type from lexicon entries');
    // And a second open has nothing left to do, so no entry at all.
    const again = await doc.reconcileOnOpen();
    expect(again.syncedMorphTypes).toBe(0);
  });

  it('leaves the plain label on a pass that writes nothing', async () => {
    const client = makeFakeClient();
    const doc = makeDoc(buildRawDoc(), client);
    await doc.reconcileOnOpen();
    expect(client.calls.some((c) => c.kind === 'operationGroups.update')).toBe(false);
    expect(client.calls.filter((c) => c.kind === 'beginOperation')[0].args[0]).toBe(
      'Repair on open',
    );
  });
});

describe('reconcileOnOpen and the layer rules', () => {
  const maintainerDoc = (client, raw = buildRawDoc()) =>
    new IgtDocument({
      raw,
      project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['me'] },
      user: { id: 'me' },
      vocabularies: {},
      client,
      projectId: 'proj-1',
    });

  it('declares nothing for a user who does not maintain the project', async () => {
    const client = makeFakeClient();
    await makeDoc(buildRawDoc(), client).reconcileOnOpen();
    expect(client.calls.some((c) => c.kind.endsWith('Constraints'))).toBe(false);
  });

  it('repairs only the document a writer opens, and declares nothing, while no rules are declared', async () => {
    const client = makeFakeClient();
    const doc = new IgtDocument({
      raw: buildRawDoc(),
      project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['m'], writers: ['me'] },
      user: { id: 'me' },
      vocabularies: {},
      client,
      projectId: 'proj-1',
    });
    await doc.reconcileOnOpen();
    const rules = client.calls.filter((c) => c.kind.endsWith('Constraints'));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((c) => c.kind.endsWith('.repairConstraints'))).toBe(true);
    expect(rules.every((c) => c.args[3]?.document === doc.id)).toBe(true);
  });

  // H9-FIRST-OPEN-3: clean data is declared with no repair, which held the
  // write lock over every layer of the project.
  it('declares the rules a maintainer opens without and repairs nothing on clean data', async () => {
    const client = makeFakeClient();
    const doc = maintainerDoc(client);
    const res = await doc.reconcileOnOpen();
    const k = client.calls.map((c) => c.kind);
    expect(k.some((x) => x.endsWith('.checkConstraints'))).toBe(true);
    expect(k.some((x) => x.endsWith('.repairConstraints'))).toBe(false);
    expect(k).toContain('tokenLayers.setConstraints');
    expect(res.rulesDeclared).toBe(true);
  });

  it('repairs, then declares the rules a maintainer opens without', async () => {
    const client = makeFakeClient({ broken: { tokenLayers: true, spanLayers: true } });
    const doc = maintainerDoc(client);
    const res = await doc.reconcileOnOpen();
    const k = client.calls.map((c) => c.kind);
    expect(k.indexOf('tokenLayers.repairConstraints')).toBeGreaterThan(-1);
    expect(k.indexOf('tokenLayers.setConstraints')).toBeGreaterThan(
      k.lastIndexOf('spanLayers.repairConstraints'),
    );
    const morphemes = client.calls.find(
      (c) =>
        c.kind === 'tokenLayers.setConstraints' &&
        c.args[0] === doc.layerInfo.morphemeTokenLayer.id,
    );
    expect(morphemes.args.slice(1, 3)).toEqual([
      'igt',
      [{ type: 'coextensive' }, { type: 'single-link' }],
    ]);
    expect(morphemes.args[4]).toEqual({ expected: null });
    expect(res.rulesDeclared).toBe(true);
    expect(res.rulesRepaired).toBe(false);
    const relabel = client.calls.find((c) => c.kind === 'operationGroups.update');
    expect(relabel.args[1]).toBe('Repaired: applied the annotation rules');
  });

  it('reads the document again when the repair changed it', async () => {
    const client = makeFakeClient({
      broken: { spanLayers: true },
      repaired: { spanLayers: [{ document: 'd', deleted: 1 }] },
    });
    const doc = maintainerDoc(client);
    let reloads = 0;
    doc._reload = async () => {
      reloads += 1;
    };
    const res = await doc.reconcileOnOpen();
    expect(res.rulesRepaired).toBe(true);
    expect(reloads).toBe(1);
  });

  it('writes nothing once the layers hold the rules', async () => {
    const raw = buildRawDoc();
    const layers = raw.textLayers[0].tokenLayers;
    for (const tl of layers) {
      tl.constraints = {
        igt:
          tl.config?.plaid?.role === 'morpheme' || tl.name === 'Morphemes'
            ? [{ type: 'coextensive' }, { type: 'single-link' }]
            : [{ type: 'single-link' }],
      };
      for (const sl of tl.spanLayers || []) sl.constraints = { igt: [{ type: 'single-span' }] };
    }
    const client = makeFakeClient();
    const doc = maintainerDoc(client, raw);
    const info = doc.layerInfo;
    info.morphemeTokenLayer.constraints = {
      igt: [{ type: 'coextensive' }, { type: 'single-link' }],
    };
    info.primaryTokenLayer.constraints = { igt: [{ type: 'single-link' }] };
    await doc.reconcileOnOpen();
    expect(client.calls.some((c) => c.kind.endsWith('Constraints'))).toBe(false);
  });

  it('reports a layer whose rules the stored data breaks', async () => {
    const client = makeFakeClient();
    const doc = maintainerDoc(client);
    const glossId = doc.layerInfo.spanLayers.morpheme[0].id;
    const refused = Object.assign(new Error('HTTP 422'), {
      status: 422,
      responseData: {
        error: 'The value "XYZ" is not allowed',
        violations: [{ constraint: 'value-set' }],
        'violation-count': 3,
      },
    });
    const batched = client.batched.bind(client);
    client.batched = async (fn) => {
      const out = await batched(fn);
      if (client.calls.some((c) => c.kind === 'spanLayers.setConstraints' && c.args[0] === glossId))
        throw refused;
      return out;
    };
    const set = client.spanLayers.setConstraints;
    client.spanLayers.setConstraints = (id, ...rest) => {
      if (id === glossId) throw refused;
      return set(id, ...rest);
    };
    const res = await doc.reconcileOnOpen();
    const finding = res.findings.find((f) => f.code === 'layer-rules-not-in-force');
    expect(finding).toMatchObject({
      severity: 'warning',
      context: { layerId: glossId, violationCount: 3 },
    });
  });
});

describe('planPreserveOnSplit', () => {
  const NS = 'plaid';
  const KEY = 'preserveOnSplit';
  const WANT = ['prov', 'provSource'];
  const layer = (id, declared) => ({
    id,
    ...(declared ? { config: { [NS]: { [KEY]: declared } } } : {}),
  });

  it('names every substrate layer that has not declared it yet', () => {
    const info = {
      sentenceTokenLayer: layer('s'),
      primaryTokenLayer: layer('w'),
      morphemeTokenLayer: layer('m'),
      alignmentTokenLayer: layer('a'),
    };
    expect(planPreserveOnSplit(info, NS, KEY, WANT)).toEqual(['s', 'w', 'm', 'a']);
  });

  it('is empty once they all declare it, so a second open writes nothing', () => {
    const info = {
      sentenceTokenLayer: layer('s', WANT),
      primaryTokenLayer: layer('w', WANT),
      morphemeTokenLayer: layer('m', WANT),
      alignmentTokenLayer: layer('a', WANT),
    };
    expect(planPreserveOnSplit(info, NS, KEY, WANT)).toEqual([]);
  });

  it('names a layer whose declaration is short of what is wanted', () => {
    const info = { primaryTokenLayer: layer('w', ['prov']) };
    expect(planPreserveOnSplit(info, NS, KEY, WANT)).toEqual(['w']);
  });

  it('names a layer whose declaration is the wrong shape entirely', () => {
    const info = { primaryTokenLayer: layer('w', 'prov') };
    expect(planPreserveOnSplit(info, NS, KEY, WANT)).toEqual(['w']);
  });

  it('skips a layer the project does not have', () => {
    expect(planPreserveOnSplit({ primaryTokenLayer: layer('w', WANT) }, NS, KEY, WANT)).toEqual([]);
    expect(planPreserveOnSplit({}, NS, KEY, WANT)).toEqual([]);
  });
});
