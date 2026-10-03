import { describe, it, expect } from 'vitest';
import { IgtDocument } from '../../../domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient } from '../../../domain/test-helpers.js';
import {
  buildReplacer,
  collectFieldRows,
  collectLexiconRows,
  collectRespellRows,
  respellBarred,
} from './bulkPlan.js';
import { applyField, applyRespell } from './bulkRunner.js';

// A replacement that leaves nothing. Respell and a morpheme form refuse it, as
// the vocabulary's Replace and the assistant do: a word replaced by nothing is
// deleted with its analysis, and a form or an entry always has one. A field
// value it empties is cleared, which deletes the span (an annotation is never
// stored as '').

const docOf = (opts) => new IgtDocument({ raw: buildRawDoc(opts), client: makeFakeClient() });

const strictMode = () => ({
  documentVersions: {},
  enterStrictMode() {},
  exitStrictMode() {},
});

const writes = (client) =>
  client.calls.filter(
    (c) =>
      !['documents.get', 'vocabLayers.get', 'query', 'beginOperation', 'endOperation'].includes(
        c.kind,
      ),
  );

describe('Respell to nothing', () => {
  const doc = docOf({
    body: 'uh dog uh',
    words: [
      { id: 'w-1', begin: 0, end: 2 },
      { id: 'w-2', begin: 3, end: 6 },
      { id: 'w-3', begin: 7, end: 9 },
    ],
  });

  it('marks every word it would empty, and a word left as spaces', () => {
    for (const repl of ['', '  ']) {
      const rows = collectRespellRows(doc, buildReplacer('uh', 'exact', repl).apply);
      expect(rows.map((r) => [r.id, r.invalid])).toEqual([
        ['w-1', 'empty'],
        ['w-3', 'empty'],
      ]);
      expect(rows.every((r) => respellBarred(r, false))).toBe(true);
    }
  });

  it('a word that keeps a letter is not marked', () => {
    const rows = collectRespellRows(doc, buildReplacer('u', 'contains', '').apply);
    expect(rows.map((r) => [r.new, r.invalid ?? null])).toEqual([
      ['h', null],
      ['h', null],
    ]);
  });

  it('an own morpheme form it empties bars the row only while forms are respelled', () => {
    const d = docOf({
      body: 'kaxa',
      words: [{ id: 'w-1', begin: 0, end: 4 }],
      morphemes: [
        { id: 'm-1', text: 'text-1', begin: 0, end: 4, precedence: 1, metadata: { form: 'ka' } },
        { id: 'm-2', text: 'text-1', begin: 0, end: 4, precedence: 2, metadata: { form: 'x' } },
      ],
    });
    const [row] = collectRespellRows(d, buildReplacer('x', 'contains', '').apply);
    expect(row.invalid).toBeUndefined();
    expect(row.emptiesForm).toBe(true);
    expect(respellBarred(row, true)).toBe(true);
    expect(respellBarred(row, false)).toBe(false);
  });

  it('marks a lexicon entry it would empty', () => {
    const vocabs = {
      v1: {
        id: 'v1',
        items: [
          { id: 'i1', form: 'uh' },
          { id: 'i2', form: 'uhm' },
        ],
      },
    };
    const rows = collectLexiconRows(vocabs, buildReplacer('uh', 'exact', '').apply);
    expect(rows.map((r) => [r.id, r.invalid])).toEqual([['i1', 'empty']]);
  });

  it('Apply writes none of them, even when they are passed in ticked', async () => {
    const client = Object.assign(makeFakeClient(), strictMode());
    client.vocabLayers.get = async (id) => ({ id, items: [{ id: 'i1', form: 'uh' }] });
    const rows = collectRespellRows(doc, buildReplacer('uh', 'exact', '').apply);
    const lexiconRows = [
      { id: 'i1', kind: 'lexicon', vocabId: 'v1', old: 'uh', new: '', invalid: 'empty' },
    ];
    const out = await applyRespell(
      client,
      { rows, lexiconRows, versions: { [doc.id]: 1 } },
      { includeMorphemes: true, includeLexicon: true, label: 'Respell' },
    );
    expect(writes(client)).toEqual([]);
    expect(out.wordsChanged).toBe(0);
    expect(out.entriesChanged).toBe(0);
  });

  it('with forms respelled, a row that would empty one is not sent, and its neighbours are', async () => {
    const d = docOf({
      body: 'kax xa',
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 6 },
      ],
      morphemes: [
        { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'ka' } },
        { id: 'm-2', text: 'text-1', begin: 0, end: 3, precedence: 2, metadata: { form: 'x' } },
        { id: 'm-3', text: 'text-1', begin: 4, end: 6, precedence: 1, metadata: {} },
      ],
    });
    const client = Object.assign(makeFakeClient(), strictMode());
    const rows = collectRespellRows(d, buildReplacer('x', 'contains', '').apply);
    const out = await applyRespell(
      client,
      { rows, lexiconRows: [], versions: { [d.id]: 1 } },
      { includeMorphemes: true, includeLexicon: false, label: 'Respell' },
    );
    expect(out.wordsChanged).toBe(1);
    const edits = client.calls.filter((c) => c.kind === 'texts.update').map((c) => c.args[1]);
    expect(edits).toEqual([[{ type: 'replace', index: 4, length: 2, value: 'a' }]]);
    expect(client.calls.filter((c) => c.kind === 'tokens.bulkUpdate')).toEqual([]);
  });
});

describe('Replace in a field to nothing', () => {
  const raw = buildRawDoc({ body: 'the cats' });
  raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
    { id: 'sp-1', tokens: ['w-1'], value: 'PL' },
    { id: 'sp-2', tokens: ['w-2'], value: 'N.PL' },
  ];
  raw.textLayers[0].tokenLayers[2].tokens[1].metadata = { form: 'PL' };
  const doc = new IgtDocument({ raw, client: makeFakeClient() });
  const wordTarget = { kind: 'span', scope: 'word', field: 'POS', layerId: 'wsl-0' };

  it('a cleared value is deleted, never stored as an empty string', async () => {
    const rows = collectFieldRows(doc, wordTarget, buildReplacer('PL', 'exact', '').apply);
    expect(rows.map((r) => [r.id, r.new, r.invalid ?? null])).toEqual([['sp-1', '', null]]);
    const rows2 = collectFieldRows(doc, wordTarget, buildReplacer('N.PL', 'exact', '  ').apply);
    const client = Object.assign(makeFakeClient(), strictMode());
    const out = await applyField(
      client,
      { rows: [...rows, ...rows2], versions: { [doc.id]: 1 } },
      { label: 'Replace' },
    );
    expect(out.changed).toBe(2);
    expect(out.cleared).toBe(2);
    const updates = client.calls.filter((c) => c.kind === 'spans.bulkUpdate');
    expect(updates).toEqual([]);
    const deletes = client.calls.filter((c) => c.kind === 'spans.bulkDelete');
    expect(deletes.map((c) => c.args[0])).toEqual([['sp-1', 'sp-2']]);
  });

  it('a value with something left is still replaced', async () => {
    const rows = collectFieldRows(doc, wordTarget, buildReplacer('.PL', 'contains', '').apply);
    const client = Object.assign(makeFakeClient(), strictMode());
    await applyField(client, { rows, versions: { [doc.id]: 1 } }, { label: 'Replace' });
    const updates = client.calls.filter((c) => c.kind === 'spans.bulkUpdate');
    expect(updates.map((c) => c.args[0])).toEqual([[{ id: 'sp-2', value: 'N' }]]);
    expect(client.calls.filter((c) => c.kind === 'spans.bulkDelete')).toEqual([]);
  });

  it('a morpheme form it empties is marked and never written', async () => {
    const rows = collectFieldRows(
      doc,
      { kind: 'morpheme' },
      buildReplacer('PL', 'exact', '').apply,
    );
    expect(rows.map((r) => [r.id, r.invalid])).toEqual([['m-2', 'empty']]);
    const client = Object.assign(makeFakeClient(), strictMode());
    const out = await applyField(client, { rows, versions: { [doc.id]: 1 } }, { label: 'Replace' });
    expect(out.changed).toBe(0);
    expect(writes(client)).toEqual([]);
  });
});
