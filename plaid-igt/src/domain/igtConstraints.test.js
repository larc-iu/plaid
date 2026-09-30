import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyMergeRules,
  fieldConstraints,
  igtFields,
  queueFieldDeclarations,
  tagsetRefusal,
  rulesNotInForce,
  valueSetsAllow,
  wantedConstraints,
} from './igtConstraints.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';
import { IgtDocument } from './IgtDocument.js';

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

  it('queues a declaration only for a field whose rules a settings save changes', () => {
    const info = getIgtLayerInfo(buildRawDoc());
    const [gloss, ...rest] = Object.values(info.spanLayers).flat();
    for (const sl of [gloss, ...rest]) sl.constraints = { igt: [{ type: 'single-span' }] };
    gloss.config = { ...gloss.config, igt: { ...gloss.config?.igt, tagset: 'Leipzig' } };
    const queued = [];
    const b = { spanLayers: { setConstraints: (...args) => queued.push(args) } };
    expect(queueFieldDeclarations(b, igtFields(info), tagsets('closed', ['N']))).toBe(1);
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
    // The same save once the layer holds it queues nothing.
    queued.length = 0;
    expect(queueFieldDeclarations(b, igtFields(info), tagsets('suggest'))).toBe(0);
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
    const doc = new IgtDocument({
      raw,
      project: { id: 'proj-1', vocabs: [], config: {} },
      vocabularies: {},
      client,
      projectId: 'proj-1',
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

describe('rules not in force', () => {
  it('names the layer and how many stored values break them', () => {
    const findings = rulesNotInForce(
      [
        {
          layerId: 'g',
          kind: 'span',
          namespace: 'igt',
          constraints: ['value-set'],
          violationCount: 3,
        },
      ],
      { spanLayers: { morpheme: [{ id: 'g', name: 'Gloss' }] } },
    );
    expect(findings).toEqual([
      {
        severity: 'warning',
        code: 'layer-rules-not-in-force',
        message: 'The value-set rules of "Gloss" are not in force: 3 stored values break them.',
        context: expect.objectContaining({ layerId: 'g' }),
      },
    ]);
    expect(rulesNotInForce([], {})).toEqual([]);
  });
});
