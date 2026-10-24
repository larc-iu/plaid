import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyMergeRules,
  fieldConstraints,
  igtFields,
  queueFieldDeclarations,
  refusedBySave,
  tagsetRefusal,
  valueSetsAllow,
  wantedConstraints,
} from './igtConstraints.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { buildRawDoc, makeFakeClient, resetIds, makeIgtDoc } from './test-helpers.js';

beforeEach(() => resetIds());

const tagsets = (mode, values = ['N', 'V', '1SG', 'NOM'], delimiters = '.') => ({
  igt: { tagsets: { Leipzig: { mode, delimiters, values: values.map((value) => ({ value })) } } },
});
const governed = { igt: { tagset: 'Leipzig', scope: 'Word' } };

describe('the rules IGT wants', () => {
  it('declares one span per token on a field, and a value set only for a closed tagset', () => {
    expect(fieldConstraints({ igt: {} }, {})).toEqual([{ type: 'single-span' }]);
    expect(fieldConstraints(governed, tagsets('suggest'))).toEqual([{ type: 'single-span' }]);
    expect(fieldConstraints(governed, tagsets('mixed'))).toEqual([{ type: 'single-span' }]);
    expect(fieldConstraints(governed, tagsets('closed'))).toEqual([
      { type: 'single-span' },
      { type: 'value-set', values: ['N', 'V', '1SG', 'NOM'], delimiters: '.', parts: 'all' },
    ]);
    // A dangling tagset name governs nothing.
    expect(fieldConstraints({ igt: { tagset: 'Gone' } }, tagsets('closed'))).toEqual([
      { type: 'single-span' },
    ]);
  });

  it('covers the morpheme and word layers and every field, reading what each holds', () => {
    const info = getIgtLayerInfo(buildRawDoc());
    info.primaryTokenLayer.constraints = { igt: [{ type: 'single-link' }], ud: [] };
    const wanted = wantedConstraints(info, {});
    const byLayer = Object.fromEntries(wanted.map((w) => [w.layerId, w]));
    expect(byLayer[info.morphemeTokenLayer.id]).toMatchObject({
      kind: 'token',
      namespace: 'igt',
      constraints: [{ type: 'coextensive' }, { type: 'single-link' }],
      stored: null,
    });
    expect(byLayer[info.primaryTokenLayer.id]).toMatchObject({
      constraints: [{ type: 'single-link' }],
      stored: [{ type: 'single-link' }],
    });
    const fields = Object.values(info.spanLayers).flat();
    expect(fields.length).toBeGreaterThan(0);
    for (const sl of fields) expect(byLayer[sl.id]).toMatchObject({ kind: 'span', stored: null });
    expect(wantedConstraints({}, {})).toEqual([]);
  });

  it('wants no list on a field naming a tagset the project does not have, and names it (REV6-WIRE-2)', () => {
    const info = getIgtLayerInfo(buildRawDoc());
    const [sl, other] = Object.values(info.spanLayers).flat();
    sl.config = { igt: { ...sl.config?.igt, tagset: 'Gone' } };
    sl.constraints = {
      igt: [{ type: 'single-span' }, { type: 'value-set', values: ['N'], delimiters: '.' }],
    };
    const wanted = wantedConstraints(info, tagsets('closed'));
    expect(wanted.find((w) => w.layerId === sl.id).constraints).toEqual([{ type: 'single-span' }]);
    expect(wanted.map((w) => w.layerId)).toContain(other.id);
  });

  it('queues a declaration only for a field whose rules a settings save changes', () => {
    const info = getIgtLayerInfo(buildRawDoc());
    const [gloss, ...rest] = Object.values(info.spanLayers).flat();
    for (const sl of [gloss, ...rest]) sl.constraints = { igt: [{ type: 'single-span' }] };
    gloss.config = { ...gloss.config, igt: { ...gloss.config?.igt, tagset: 'Leipzig' } };
    const queued = [];
    const b = { spanLayers: { setConstraints: (...args) => queued.push(args) } };
    expect(queueFieldDeclarations(b, igtFields(info), tagsets('closed', ['N']), {})).toBe(1);
    expect(queued[0]).toEqual([
      gloss.id,
      'igt',
      [
        { type: 'single-span' },
        { type: 'value-set', values: ['N'], delimiters: '.', parts: 'all' },
      ],
      undefined,
      { expected: [{ type: 'single-span' }] },
    ]);
    // The same save once the layer holds it queues nothing, whatever order
    // the server hands its keys back in.
    queued.length = 0;
    gloss.constraints = {
      igt: [
        { type: 'single-span' },
        { parts: 'all', delimiters: '.', values: ['N'], type: 'value-set' },
      ],
    };
    expect(queueFieldDeclarations(b, [gloss], tagsets('closed', ['N']), {})).toBe(0);
    gloss.constraints = { igt: [{ type: 'single-span' }] };
    expect(queueFieldDeclarations(b, igtFields(info), tagsets('suggest'), {})).toBe(0);
  });

  // Ruling on FX-UI's question (2026-10-02): a settings save on a layer that
  // holds no rules yet repairs what core can repair first, in the same batch,
  // so only a violation with no remedy refuses it. A new field's layer
  // (`constraints: null`) has nothing to repair.
  // REV4-WIRE-1 and -2: a save declares in its batch only on a field that
  // was in force, and never repairs. A field out of force before the save
  // (here one whose layer holds no rules) is left to the heal after it.
  it('declares only on a field in force before the save, and repairs nothing', () => {
    const info = getIgtLayerInfo(buildRawDoc());
    const [gloss] = Object.values(info.spanLayers).flat();
    const queued = [];
    const b = {
      spanLayers: {
        repairConstraints: (...args) => queued.push(['repair', ...args]),
        setConstraints: (...args) => queued.push(['set', ...args]),
      },
    };
    const config = { ...gloss.config, igt: { ...gloss.config?.igt, tagset: 'Leipzig' } };
    const bare = { ...gloss, config, constraints: {} };
    expect(queueFieldDeclarations(b, [bare], tagsets('closed', ['N']), {})).toBe(0);
    expect(queued).toEqual([]);
    const inForce = { ...bare, constraints: { igt: [{ type: 'single-span' }] } };
    expect(queueFieldDeclarations(b, [inForce], tagsets('closed', ['N']), {})).toBe(1);
    expect(queued.map((q) => q[0])).toEqual(['set']);
    queued.length = 0;
    queueFieldDeclarations(b, [{ ...gloss, constraints: null }], tagsets('closed', ['N']), {});
    expect(queued.map((q) => q[0])).toEqual(['set']);
    // A list held out of date is out of force too: no declaration.
    queued.length = 0;
    const old = {
      ...bare,
      constraints: {
        igt: [
          { type: 'single-span' },
          { type: 'value-set', values: ['N'], delimiters: '.', parts: 'all' },
        ],
      },
    };
    expect(
      queueFieldDeclarations(
        b,
        [old],
        tagsets('closed', ['N', 'V']),
        tagsets('closed', ['N', 'X']),
      ),
    ).toBe(0);
    expect(queued).toEqual([]);
  });
});

describe('a value set read as the server reads it', () => {
  const layer = (c) => ({ constraints: { igt: [c] } });
  it('takes every part, trimmed and non-empty, and lets blank values through', () => {
    const l = layer({ type: 'value-set', values: ['1SG', 'NOM'], delimiters: '.', parts: 'all' });
    expect(valueSetsAllow(l, '1SG.NOM')).toBe(true);
    expect(valueSetsAllow(l, '1SG..NOM')).toBe(false);
    expect(valueSetsAllow(l, '1SG.ACC')).toBe(false);
    expect(valueSetsAllow(l, '')).toBe(true);
    expect(valueSetsAllow(l, null)).toBe(true);
    expect(valueSetsAllow(l, 'NOM | 1SG')).toBe(false);
    expect(valueSetsAllow({}, 'anything')).toBe(true);
  });

  it('takes only the first part with parts first', () => {
    const l = layer({ type: 'value-set', values: ['nsubj'], delimiters: ':', parts: 'first' });
    expect(valueSetsAllow(l, 'nsubj:pass')).toBe(true);
    expect(valueSetsAllow(l, 'obj')).toBe(false);
  });
});

describe('the screen after a word merge', () => {
  const info = (spans, constraints) => ({
    spanLayers: { word: [{ id: 'POS', spans, constraints }] },
  });

  it("keeps the survivor's own annotation and joins the others' values in text order", () => {
    const next = info([
      { id: 'b', tokens: ['w-1'], value: 'x' },
      { id: 'a', tokens: ['w-1'], value: 'z' },
      { id: 'c', tokens: ['w-1'], value: 'y' },
    ]);
    const beginOf = new Map([
      ['a', 8],
      ['c', 4],
    ]);
    applyMergeRules(next, {}, 'w-1', beginOf, { spans: new Set(['b']), links: new Set() });
    expect(next.spanLayers.word[0].spans).toEqual([
      { id: 'b', tokens: ['w-1'], value: 'x | y | z' },
    ]);
  });

  it('stamps the joined value from what it holds, as the server does (HUNT-model M1)', () => {
    const machine = (prob) => ({
      prov: 'inferred',
      provSource: 'service:m',
      provProb: prob,
      provDetail: { valueProbs: { x: prob } },
    });
    const own = { spans: new Set(['b']), links: new Set() };
    const join = (keepMd, otherMd) => {
      const next = info([
        { id: 'b', tokens: ['w-1'], value: 'x', metadata: keepMd },
        { id: 'c', tokens: ['w-1'], value: 'y', metadata: otherMd },
      ]);
      applyMergeRules(next, {}, 'w-1', new Map([['c', 4]]), own);
      return next.spanLayers.word[0].spans[0];
    };
    // A person's value in it makes it the person's, the other keys kept.
    expect(join({ ...machine(0.4), note: 'kept' }, {})).toMatchObject({
      value: 'x | y',
      metadata: { note: 'kept' },
    });
    expect(join({ ...machine(0.4), note: 'kept' }, {}).metadata.prov).toBeUndefined();
    expect(join({}, machine(0.4)).metadata).toEqual({});
    expect(join(machine(0.4), { prov: 'contributed', provSource: 'user:b' }).metadata).toEqual({
      prov: 'contributed',
      provSource: 'user:b',
    });
    // Machine and machine stay machine, with no provProb for the joined value.
    const { provProb: _p, ...rest } = machine(0.4);
    expect(join(machine(0.4), machine(0.9)).metadata).toEqual(rest);
    // A blank kept span and a machine value: the machine's, as it gave it
    // (REV-R4-TOKENS T2), not the blank span's empty stamp.
    const blank = info([
      { id: 'b', tokens: ['w-1'], value: '', metadata: {} },
      { id: 'c', tokens: ['w-1'], value: 'y', metadata: machine(0.4) },
    ]);
    applyMergeRules(blank, {}, 'w-1', new Map([['c', 4]]), own);
    expect(blank.spanLayers.word[0].spans[0]).toMatchObject({ value: 'y', metadata: machine(0.4) });
  });

  it('keeps the smallest id when the survivor had none, and a value its closed tagset refuses stays unjoined', () => {
    const next = info(
      [
        { id: 'q', tokens: ['w-1'], value: 'V' },
        { id: 'p', tokens: ['w-1'], value: 'N' },
      ],
      { igt: [{ type: 'value-set', values: ['N', 'V'], delimiters: '.', parts: 'all' }] },
    );
    applyMergeRules(next, {}, 'w-1', new Map(), { spans: new Set(), links: new Set() });
    expect(next.spanLayers.word[0].spans).toEqual([{ id: 'p', tokens: ['w-1'], value: 'N' }]);
  });

  it("keeps the survivor's own link and drops the rest, across vocabularies", () => {
    const vocabs = {
      v1: {
        vocabLinks: [
          { id: 'l2', tokens: ['w-1'] },
          { id: 'mwe', tokens: ['w-1', 'w-3'] },
        ],
      },
      v2: { vocabLinks: [{ id: 'l1', tokens: ['w-1'] }] },
    };
    applyMergeRules({ spanLayers: {} }, vocabs, 'w-1', new Map(), {
      spans: new Set(),
      links: new Set(['l2']),
    });
    expect(vocabs.v1.vocabLinks.map((l) => l.id)).toEqual(['l2', 'mwe']);
    expect(vocabs.v2.vocabLinks).toEqual([]);
  });

  it('is what IgtDocument.mergeTokens shows, sent as one batch', async () => {
    const raw = buildRawDoc({
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
      ],
      morphemes: [],
      body: 'the cat',
    });
    raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
      { id: 'sp-1', tokens: ['w-1'], value: 'DET' },
      { id: 'sp-2', tokens: ['w-2'], value: 'N' },
    ];
    const client = makeFakeClient();
    const doc = makeIgtDoc({
      raw,
      project: { id: 'proj-1', vocabs: [], config: {} },
      client,
    });
    await doc.mergeTokens(['w-1', 'w-2']);
    const spans = doc.layerInfo.spanLayers.word[0].spans;
    expect(spans).toEqual([expect.objectContaining({ id: 'sp-1', value: 'DET | N' })]);
    expect(client.calls.filter((c) => c.kind === 'batch.submit')).toHaveLength(1);
    expect(client.calls.some((c) => c.kind.startsWith('spans.'))).toBe(false);
  });
});

describe('a tagset save the stored values refuse', () => {
  it('says how many values, in which fields, and which', () => {
    const e = Object.assign(new Error('HTTP 422'), {
      status: 422,
      responseData: {
        violations: [
          { constraint: 'value-set', 'layer-name': 'POS', value: 'XYZ' },
          { constraint: 'value-set', 'layer-name': 'POS', value: 'ABC' },
        ],
        'violation-count': 3,
      },
    });
    expect(tagsetRefusal(e)).toBe('3 values in POS are not in the tagset: XYZ, ABC.');
    expect(tagsetRefusal(new Error('x'))).toBeNull();
  });
});

describe('what a settings save would have the server refuse', () => {
  const closedRule = {
    type: 'value-set',
    values: ['N', 'V', '1SG', 'NOM'],
    delimiters: '.',
    parts: 'all',
  };
  const field = (id, constraints) => ({ id, name: id, config: governed, constraints });
  const client = (answers) => {
    const asked = [];
    return {
      asked,
      spanLayers: {
        refusedValues: async (id, rule, options) => {
          asked.push([id, rule, options]);
          return answers[id];
        },
      },
    };
  };

  it('asks only of a field whose rules change to a closed list, and keeps the ones it refuses', async () => {
    const c = client({
      A: { count: 2, valueCount: 1, values: [{ value: 'dog', parts: ['dog'], count: 2 }] },
      B: { count: 0, valueCount: 0, values: [] },
    });
    const fields = [
      field('A', { igt: [{ type: 'single-span' }] }),
      field('B', null),
      // Already holds the list: its stored values keep to it.
      field('C', { igt: [{ type: 'single-span' }, closedRule] }),
    ];
    expect(await refusedBySave(c, fields, tagsets('closed'), tagsets('suggest'))).toEqual([
      {
        layerId: 'A',
        field: 'A',
        count: 2,
        valueCount: 1,
        values: [{ value: 'dog', parts: ['dog'], count: 2 }],
      },
    ]);
    expect(c.asked.map((a) => a[0])).toEqual(['A', 'B']);
    expect(c.asked[0].slice(1)).toEqual([closedRule, { limit: 5 }]);
  });

  // REV-WIRE-1: a field whose layer lost its list (or never held it) is not
  // the save's business unless the save changes that field's rules.
  it('asks nothing of a field the save leaves alone, a bare one included', async () => {
    const c = client({ A: { count: 2, valueCount: 1, values: [{ value: 'QQ', count: 2 }] } });
    const closed = tagsets('closed');
    const other = {
      igt: { tagsets: { ...closed.igt.tagsets, POS: { mode: 'closed', values: [] } } },
    };
    expect(await refusedBySave(c, [field('A', {})], other, closed)).toEqual([]);
    expect(c.asked).toEqual([]);
    const queued = [];
    const b = {
      spanLayers: {
        repairConstraints: (...args) => queued.push(args),
        setConstraints: (...args) => queued.push(args),
      },
    };
    expect(queueFieldDeclarations(b, [field('A', {})], other, closed)).toBe(0);
    expect(queued).toEqual([]);
    // Its own tagset closing is its business, when it was in force.
    const span = { igt: [{ type: 'single-span' }] };
    expect(await refusedBySave(c, [field('A', span)], closed, tagsets('mixed'))).toHaveLength(1);
    // So is pointing it at a closed list, read from its config before.
    const repointed = { ...field('A', span), configBefore: { igt: { scope: 'Word' } } };
    expect(await refusedBySave(c, [repointed], closed, closed)).toHaveLength(1);
    // Not when it was out of force before the save (REV4-WIRE-1).
    c.asked.length = 0;
    expect(await refusedBySave(c, [field('A', {})], closed, tagsets('mixed'))).toEqual([]);
    expect(c.asked).toEqual([]);
  });

  it('needs the config as stored', async () => {
    await expect(
      refusedBySave(client({}), [field('A', null)], tagsets('closed')),
    ).rejects.toThrow();
    expect(() => queueFieldDeclarations({}, [field('A', null)], tagsets('closed'))).toThrow();
  });

  it('asks nothing when no list is closed', async () => {
    const c = client({});
    expect(await refusedBySave(c, [field('A', null)], tagsets('mixed'), {})).toEqual([]);
    expect(c.asked).toEqual([]);
  });
});

// REV5-WIRE-4: a double written between the heal's check and its declaration
// is refused by core, and the field is named for the annotation to leave,
// as one the check found.
describe('a heal whose declaration a new double refuses', () => {
  it('names the field for one annotation a unit, with the count core gives', async () => {
    const { declareIgtRules } = await import('./igtConstraints.js');
    const proj = {
      id: 'p',
      config: { igt: {} },
      textLayers: [
        {
          id: 'tl',
          config: { plaid: { role: 'baseline' } },
          tokenLayers: [
            {
              id: 'w',
              config: { plaid: { role: 'word' } },
              constraints: { igt: [{ type: 'single-link' }] },
              spanLayers: [
                {
                  id: 'raw',
                  name: 'Raw note',
                  config: { igt: { scope: 'Word' } },
                  constraints: {},
                },
              ],
            },
          ],
        },
      ],
    };
    const refusal = Object.assign(new Error('HTTP 422'), {
      status: 422,
      responseData: {
        violations: [{ constraint: 'single-span' }],
        'violation-count': 1,
      },
    });
    const client = {
      projects: { get: async () => structuredClone(proj) },
      spanLayers: {
        checkConstraints: async () => ({ violations: [], violationCount: 0 }),
        refusedValues: async () => ({ count: 0, valueCount: 0, values: [] }),
        setConstraints: async () => {
          throw refusal;
        },
      },
      withOperation: async (_m, fn) => fn(),
    };
    const out = await declareIgtRules(client, 'p', { fieldsOnly: true, repair: false });
    expect(out.notInForce).toEqual([
      expect.objectContaining({
        field: 'Raw note',
        repair: ['single-span'],
        repairCount: 1,
        scope: 'Word',
      }),
    ]);
  });
});
