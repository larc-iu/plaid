import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from '../IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '../test-helpers.js';

// A document where "kat" (w-2) is analyzed as ka-t / cat-PL with a link on
// the first morpheme, and "the" (w-1) is an untouched default word.
const analyzedRaw = () => {
  const raw = buildRawDoc({
    body: 'the kat',
    morphemes: [
      { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} },
      { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: { form: 'ka' } },
      { id: 'm-3', text: 'text-1', begin: 4, end: 7, precedence: 2, metadata: { form: 't' } },
    ],
    morphVocabs: [
      {
        id: 'v1',
        name: 'Lex',
        vocabLinks: [{ id: 'l-1', tokens: ['m-2'], vocabItem: { id: 'i-ka', form: 'ka' } }],
      },
    ],
  });
  raw.textLayers[0].tokenLayers[2].spanLayers[0].spans = [
    { id: 'g-2', tokens: ['m-2'], value: 'cat' },
    { id: 'g-3', tokens: ['m-3'], value: 'PL' },
  ];
  raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
    { id: 'p-2', tokens: ['w-2'], value: 'N' },
  ];
  return raw;
};

// The same document after the strip phase: one bare morpheme, nothing attached.
const strippedRaw = () =>
  buildRawDoc({
    body: 'the kat',
    morphemes: [
      { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} },
      { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: {} },
    ],
  });

// Fresh tables per call: IgtDocument folds document links INTO the vocab table
// it is handed (mergeRawVocabLinks), so a shared fixture would leak links
// between tests. The client mirrors the real one, whose vocabLayers.get
// returns a new object per request (with items, without links).
const project = { id: 'proj-1', vocabs: [{ id: 'v1' }] };
const vocabsOf = () => ({ v1: { id: 'v1', name: 'Lex', items: [{ id: 'i-kat', form: 'kat' }] } });
const clientFor = (opts) => {
  const client = makeFakeClient({ ...opts, project });
  client.vocabLayers.get = async (id) => vocabsOf()[id];
  return client;
};
const docFor = (raw, client) =>
  new IgtDocument({ raw, client, project, projectId: project.id, vocabularies: vocabsOf() });

const targetAnalysis = {
  word: { vocabItemId: null, fields: { POS: 'N' } },
  morphemes: [{ form: 'kat', morphType: null, vocabItemId: 'i-kat', fields: { Gloss: 'cat' } }],
};

describe('bulkReplaceAnalyses', () => {
  beforeEach(() => resetIds());

  it('strips the current analysis and applies the target as human work, in one batch', async () => {
    const client = clientFor({ reloadDoc: strippedRaw() });
    const doc = docFor(analyzedRaw(), client);

    const n = await doc.bulkReplaceAnalyses([{ wordTokenId: 'w-2', analysis: targetAnalysis }]);
    expect(n).toBe(1);

    const kinds = client.calls.map((c) => c.kind);
    // One labeled operation for the whole thing.
    expect(client.calls[0]).toEqual({ kind: 'beginOperation', args: ['Re-analyze words'] });
    expect(kinds.filter((k) => k === 'beginOperation')).toHaveLength(1);

    // One batch, so the word is never left stripped and not re-analyzed.
    expect(kinds.filter((k) => k === 'batch.submit')).toHaveLength(1);
    // Strip: the word's span, the first morpheme's link + span, the second
    // morpheme deleted outright (its span cascades), first reset, all through
    // the bulk endpoints, one op per kind however many words.
    const strip = client.calls.slice(0, 5);
    expect(strip.map((c) => c.kind)).toEqual([
      'beginOperation',
      'vocabLinks.bulkDelete',
      'spans.bulkDelete',
      'tokens.bulkDelete',
      'tokens.bulkUpdate',
    ]);
    expect(strip[1].args[0]).toEqual(['l-1']); // on m-2
    expect(strip[2].args[0]).toEqual(['p-2', 'g-2']); // the word's, then m-2's
    expect(strip[3].args[0]).toEqual(['m-3']);
    expect(strip[4].args[0]).toHaveLength(1);
    expect(strip[4].args[0][0].id).toBe('m-2'); // reset m-2
    expect(strip[4].args[0][0].metadata).toEqual(
      expect.arrayContaining([
        { op: 'delete', path: ['form'] },
        { op: 'delete', path: ['morphType'] },
        { op: 'delete', path: ['prov'] },
      ]),
    );
    // g-3 (on the deleted morpheme) is NOT sent: a double delete fails the batch.
    expect(strip[2].args[0]).not.toContain('g-3');

    // Then, in the same batch, the link, the gloss and the POS, with NO
    // provenance stamp. Spans go one bulk create per LAYER.
    const apply = client.calls.slice(5, kinds.indexOf('batch.submit'));
    const applyKinds = apply.map((c) => c.kind);
    expect(applyKinds).toEqual(['vocabLinks.bulkCreate', 'spans.bulkCreate', 'spans.bulkCreate']);
    expect(apply.find((c) => c.kind === 'vocabLinks.bulkCreate').args[0]).toEqual([
      { id: expect.any(String), vocabItem: 'i-kat', tokens: ['m-2'], metadata: {} },
    ]);
    const spanSpecs = apply.filter((c) => c.kind === 'spans.bulkCreate').flatMap((c) => c.args[0]);
    expect(spanSpecs).toEqual([
      { id: expect.any(String), spanLayerId: 'msl-0', tokens: ['m-2'], value: 'cat', metadata: {} },
      { id: expect.any(String), spanLayerId: 'wsl-0', tokens: ['w-2'], value: 'N', metadata: {} },
    ]);
    // The first morpheme's form equals the word surface, so no metadata patch,
    // and the analysis has one slot, so no morpheme is created.
    expect(applyKinds).not.toContain('tokens.bulkUpdate');
    expect(applyKinds).not.toContain('tokens.bulkCreate');
  });

  it('never leaves a word stripped and not re-analyzed: a refusal takes neither', async () => {
    // The server takes the first `accept` batches and refuses the rest as a
    // conflict. What it took must hold a word's strip and its new analysis
    // together.
    for (const accept of [0, 1]) {
      resetIds();
      const client = clientFor({ reloadDoc: analyzedRaw() });
      const batched = client.batched.bind(client);
      const taken = [];
      let n = 0;
      client.batched = async (fn) => {
        const start = client.calls.length;
        const results = await batched(fn);
        if (n++ >= accept) throw Object.assign(new Error('HTTP 409 changed'), { status: 409 });
        taken.push(...client.calls.slice(start).map((c) => c.kind));
        return results;
      };
      const doc = docFor(analyzedRaw(), client);
      const out = await doc.bulkReplaceAnalyses([{ wordTokenId: 'w-2', analysis: targetAnalysis }]);
      const stripped = taken.includes('tokens.bulkDelete');
      const reanalyzed = taken.includes('spans.bulkCreate');
      expect(stripped).toBe(reanalyzed);
      expect(out).toBe(accept ? 1 : false);
    }
  });

  it('skips words that already carry exactly the target analysis', async () => {
    const client = clientFor();
    const doc = docFor(analyzedRaw(), client);
    const current = {
      word: { vocabItemId: null, fields: { POS: 'N' } },
      morphemes: [
        { form: 'ka', morphType: null, vocabItemId: 'i-ka', fields: { Gloss: 'cat' } },
        { form: 't', morphType: null, vocabItemId: null, fields: { Gloss: 'PL' } },
      ],
    };
    const n = await doc.bulkReplaceAnalyses([{ wordTokenId: 'w-2', analysis: current }]);
    expect(n).toBe(0);
    expect(client.calls).toEqual([]);
  });

  // "Analyze every ‹kat› in this text like this": a person asked for it, so
  // it is their work, and a word somebody has since analyzed is left alone.
  it('applyAnalysisToWords writes human work, and only onto unanalyzed words', async () => {
    const client = clientFor({ reloadDoc: strippedRaw() });
    const doc = docFor(strippedRaw(), client);
    expect(await doc.applyAnalysisToWords(['w-2'], targetAnalysis)).toBe(1);
    expect(client.calls[0]).toEqual({ kind: 'beginOperation', args: ['Analyze words'] });
    expect(client.calls.find((c) => c.kind === 'vocabLinks.bulkCreate').args[0]).toEqual([
      { id: expect.any(String), vocabItem: 'i-kat', tokens: ['m-2'], metadata: {} },
    ]);

    const busy = clientFor();
    const analyzed = docFor(analyzedRaw(), busy);
    expect(await analyzed.applyAnalysisToWords(['w-2'], targetAnalysis)).toBe(0);
    expect(busy.calls).toEqual([]);
  });

  // Spreading an analysis is endorsing it, so the word it came from stops
  // reading as somebody else's guess while its copies read as this person's
  // work (Luke's ruling, 2026-09-19).
  it('applyAnalysisToWords confirms the word the analysis came from', async () => {
    // The source word's gloss and part of speech are a machine's, unconfirmed.
    const machineRaw = () => {
      const raw = analyzedRaw();
      const machine = { prov: 'inferred', provSource: 'service:test' };
      raw.textLayers[0].tokenLayers[2].spanLayers[0].spans[0].metadata = { ...machine };
      raw.textLayers[0].tokenLayers[1].spanLayers[0].spans[0].metadata = { ...machine };
      return raw;
    };
    const client = clientFor({ reloadDoc: machineRaw() });
    const doc = docFor(machineRaw(), client);
    await doc.applyAnalysisToWords(['w-1'], targetAnalysis, { confirm: ['w-2'] });
    const confirmed = client.calls
      .filter((c) => c.kind === 'spans.patchMetadata')
      .map((c) => c.args[0]);
    expect(confirmed).toEqual(expect.arrayContaining(['g-2', 'p-2']));
  });

  it('bulkApplyAnalyses still stamps copies as inferred', async () => {
    const client = clientFor({ reloadDoc: strippedRaw() });
    const doc = docFor(strippedRaw(), client);
    const n = await doc.bulkApplyAnalyses(
      [{ wordTokenId: 'w-2', analysis: targetAnalysis }],
      'rule:test',
    );
    expect(n).toBe(1);
    const link = client.calls.find((c) => c.kind === 'vocabLinks.bulkCreate');
    expect(link.args[0][0].metadata).toMatchObject({
      prov: 'inferred',
      provSource: 'rule:test',
    });
    expect(client.calls[0]).toEqual({
      kind: 'beginOperation',
      args: ['Copy previous analyses'],
    });
  });
});

// A study reads the audit log and the provenance: a copy made by the built-in
// rule is one service run naming it, and every piece it writes names the rule
// and its version beside what it predicted.
describe('a copy by a built-in rule', () => {
  it('is one service run, and each piece names the rule and its version', async () => {
    const client = clientFor({ reloadDoc: strippedRaw() });
    const doc = docFor(strippedRaw(), client);
    const detail = { model: 'builtin:analysis-copy', version: '0.0.0+0123abcd' };
    const n = await doc.bulkApplyAnalyses(
      [{ wordTokenId: 'w-2', analysis: targetAnalysis }],
      'rule:test',
      { detail, kind: 'service-run', ref: 'builtin:analysis-copy' },
    );
    expect(n).toBe(1);
    expect(client.calls[0]).toEqual({
      kind: 'beginOperation',
      args: ['Copy previous analyses', { kind: 'service-run', ref: 'builtin:analysis-copy' }],
    });
    const spans = client.calls
      .filter((c) => c.kind === 'spans.bulkCreate')
      .flatMap((c) => c.args[0]);
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) expect(s.metadata.provDetail).toEqual({ ...detail, value: s.value });
    const link = client.calls.find((c) => c.kind === 'vocabLinks.bulkCreate').args[0][0];
    expect(link.metadata).toMatchObject({ prov: 'inferred', provSource: 'rule:test' });
    expect(link.metadata.provDetail).toEqual(detail);
  });
});

// Prediction extras: a machine copy records what it wrote (provDetail.value on
// spans, provDetail.form on morphemes) so a later consumer can tell an
// accepted-as-is copy from a corrected one; a human replace records nothing.
describe('analysis prediction extras', () => {
  const twoMorphs = {
    word: { vocabItemId: null, fields: { POS: 'N' } },
    morphemes: [
      { form: 'ka', morphType: null, vocabItemId: null, fields: { Gloss: 'cat' } },
      { form: 't', morphType: 'suffix', vocabItemId: null, fields: { Gloss: 'PL' } },
    ],
  };

  it('bulkApplyAnalyses stamps provDetail.value on spans and provDetail.form on morphemes', async () => {
    const client = clientFor({ reloadDoc: strippedRaw() });
    const doc = docFor(strippedRaw(), client);
    expect(
      await doc.bulkApplyAnalyses([{ wordTokenId: 'w-2', analysis: twoMorphs }], 'rule:test'),
    ).toBe(1);
    const spans = client.calls
      .filter((c) => c.kind === 'spans.bulkCreate')
      .flatMap((c) => c.args[0]);
    // In whatever order the batches carry them.
    const byValue = (a, b) => a[0].localeCompare(b[0]);
    expect(spans.map((s) => [s.value, s.metadata.provDetail]).sort(byValue)).toEqual(
      [
        ['cat', { value: 'cat' }],
        ['N', { value: 'N' }],
        ['PL', { value: 'PL' }],
      ].sort(byValue),
    );
    for (const s of spans)
      expect(s.metadata).toMatchObject({ prov: 'inferred', provSource: 'rule:test' });
    const m0 = client.calls.find((c) => c.kind === 'tokens.bulkUpdate').args[0][0];
    expect(m0.metadata).toEqual(
      expect.arrayContaining([
        { op: 'set', path: ['form'], value: 'ka' },
        { op: 'set', path: ['prov'], value: 'inferred' },
        { op: 'set', path: ['provDetail'], value: { form: 'ka' } },
      ]),
    );
    const m1 = client.calls.find((c) => c.kind === 'tokens.bulkCreate').args[0][0];
    expect(m1.metadata).toMatchObject({
      form: 't',
      morphType: 'suffix',
      provDetail: { form: 't' },
    });
  });

  it('bulkReplaceAnalyses (a human choice) records no provenance at all', async () => {
    const client = clientFor({ reloadDoc: strippedRaw() });
    const doc = docFor(strippedRaw(), client);
    expect(await doc.bulkReplaceAnalyses([{ wordTokenId: 'w-2', analysis: twoMorphs }])).toBe(1);
    // (the strip phase resets prov keys to null, which is not a stamp)
    // Walks INTO the bulk bodies: every write here hands the client an array of
    // entries, so a check that only looked at top-level args would pass by
    // seeing nothing at all.
    const stamped = (v) => {
      if (Array.isArray(v)) return v.some(stamped);
      if (!v || typeof v !== 'object') return false;
      if (v.prov || v.provDetail) return true;
      return Object.values(v).some(stamped);
    };
    expect(client.calls.filter((c) => stamped(c.args))).toEqual([]);
  });
});

// A precedent whose first morpheme carries nothing (its analysis is all on the
// word) puts nothing on the copy's first morpheme either, and an unanalyzed
// word's morpheme is not stored until something is (H2-IGT-ANALYZE-5).
describe('a copy onto a word with no stored morpheme', () => {
  beforeEach(() => resetIds());
  const bareRaw = () =>
    buildRawDoc({
      body: 'the kat',
      morphemes: [{ id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} }],
    });
  // As { begin, end, precedence }, whichever call made them.
  const morphemeCreates = (client) =>
    client.calls.flatMap((c) => {
      if (c.kind === 'tokens.bulkCreate') return c.args[0];
      if (c.kind !== 'tokens.create') return [];
      const [, , begin, end, precedence] = c.args;
      return [{ begin, end, precedence }];
    });

  it('makes no morpheme when the first slot carries nothing', async () => {
    const client = clientFor({ reloadDoc: bareRaw() });
    const doc = docFor(bareRaw(), client);
    const wordOnly = {
      word: { vocabItemId: null, fields: { POS: 'N' } },
      morphemes: [{ form: 'kat', morphType: null, vocabItemId: null, fields: {} }],
    };
    expect(
      await doc.bulkApplyAnalyses([{ wordTokenId: 'w-2', analysis: wordOnly }], 'rule:test'),
    ).toBe(1);
    expect(morphemeCreates(client)).toEqual([]);
    expect(client.calls.find((c) => c.kind === 'tokens.bulkUpdate')).toBeUndefined();
    const spans = client.calls
      .filter((c) => c.kind === 'spans.bulkCreate')
      .flatMap((c) => c.args[0]);
    expect(spans.map((s) => [s.value, s.tokens])).toEqual([['N', ['w-2']]]);
  });

  it('makes it with what the first slot carries', async () => {
    const client = clientFor({ reloadDoc: bareRaw() });
    const doc = docFor(bareRaw(), client);
    expect(
      await doc.bulkApplyAnalyses([{ wordTokenId: 'w-2', analysis: targetAnalysis }], 'rule:test'),
    ).toBe(1);
    const created = morphemeCreates(client);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ begin: 4, end: 7, precedence: 1 });
  });
});
