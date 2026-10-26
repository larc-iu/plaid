import { describe, it, expect, beforeEach, vi } from 'vitest';
import { refusal } from '../../../plaid-client-js/src/testing.js';
import {
  RESPELL_EMPTY,
  RESPELL_MARK,
  RESPELL_SPACE,
  RESPELL_UNCHANGED,
  respellOps,
  respellRefusal,
} from './respell.js';
import { buildRawDoc, makeFakeClient, makeIgtDoc, resetIds, settle } from './test-helpers.js';
import { applyReplaceToTokens } from './textEdits.js';

// R51: respell one word in the Analyze grid, as Bulk Edit's Respell words
// writes it, for one word.

describe('respellRefusal', () => {
  it('takes a new spelling of at least one character', () => {
    expect(respellRefusal('kat', 'cat')).toBeNull();
    expect(respellRefusal('kat', 'c')).toBeNull();
  });

  it('refuses nothing typed', () => {
    expect(respellRefusal('kat', '')).toBe(RESPELL_EMPTY);
  });

  it('refuses a space, a tab, a line break, NEL and a no-break space, naming Tokenize', () => {
    for (const typed of ['c t', 'c\tt', 'c\nt', 'c\u0085t', 'c t', 'c t', ' cat']) {
      expect(respellRefusal('kat', typed)).toBe(RESPELL_SPACE);
    }
    expect(RESPELL_SPACE).toMatch(/Tokenize/);
  });

  it('refuses a spelling that starts with a combining mark', () => {
    expect(respellRefusal('kat', '́cat')).toBe(RESPELL_MARK);
    expect(respellRefusal('kat', 'cát')).toBeNull();
  });

  it('reads the word as spelled, canonically equivalent text included, as unchanged', () => {
    expect(respellRefusal('kat', 'kat')).toBe(RESPELL_UNCHANGED);
    expect(respellRefusal('café', 'café')).toBe(RESPELL_UNCHANGED);
  });

  it('counts astral letters as letters', () => {
    expect(respellRefusal('𐌰𐌱', '𐌰𐌲𐌱')).toBeNull();
    expect(respellRefusal('𐌰𐌱', '𐌰𐌱')).toBe(RESPELL_UNCHANGED);
  });
});

describe('respellOps', () => {
  it('is one whole-word replace per row, in code points, the last first', () => {
    expect(
      respellOps([
        { begin: 0, end: 3, new: 'a' },
        { begin: 4, end: 6, new: '𐌰𐌲𐌱' },
      ]),
    ).toEqual([
      { type: 'replace', index: 4, length: 2, value: '𐌰𐌲𐌱' },
      { type: 'replace', index: 0, length: 3, value: 'a' },
    ]);
  });
});

describe('applyReplaceToTokens (the core token-edit replace, mirrored)', () => {
  const t = (id, begin, end) => ({ id, begin, end });
  it('keeps every token covering the range, resized, and shifts the rest', () => {
    const { tokens, deletedIds } = applyReplaceToTokens(
      [t('word', 4, 7), t('morph', 4, 7), t('sent', 0, 11), t('next', 8, 11), t('before', 0, 3)],
      4,
      3,
      'kitten',
    );
    expect(deletedIds).toEqual([]);
    expect(tokens).toEqual([
      t('word', 4, 10),
      t('morph', 4, 10),
      t('sent', 0, 14),
      t('next', 11, 14),
      t('before', 0, 3),
    ]);
  });

  it('deletes a token strictly inside the range, as core does', () => {
    const { deletedIds } = applyReplaceToTokens([t('part', 5, 6)], 4, 3, 'cat');
    expect(deletedIds).toEqual(['part']);
  });
});

// ---- the mutation ----------------------------------------------------------

const DIGEST = 'digest-1';
const rawWith = (opts = {}) => {
  const raw = buildRawDoc({ body: 'the kat', ...opts });
  raw.textLayers[0].text.digest = DIGEST;
  return raw;
};
const wordL = (raw) => raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL');
const morphL = (raw) => raw.textLayers[0].tokenLayers.find((l) => l.id === 'morphL');

const textAnswer = (body) => ({
  id: 'text-1',
  body,
  digest: 'digest-2',
  reshape: { tokens: [], spans: [], vocabLinks: [], deleted: {} },
});

// The server's answer to the text write: the body the page shows once the
// edit is made (the replace is applied as sent) and a new digest.
const answersText = (client, docOf) => {
  const answer = client._postBatch;
  client._postBatch = async (...args) => {
    const res = await answer(...args);
    if (res[0]) res[0].body = textAnswer(docOf().body);
    return res;
  };
  return client;
};

const writeCalls = (client) =>
  client.calls.filter((c) => c.kind !== 'beginOperation' && c.kind !== 'batch.submit');

describe('respellWord', () => {
  beforeEach(() => resetIds());

  it('sends one whole-word replace with the digest of the text, labelled "Respell kat → cat"', async () => {
    const client = makeFakeClient();
    const doc = makeIgtDoc({ raw: rawWith(), client });
    const ok = await doc.respellWord('w-2', 'cat');
    expect(ok).toBe(true);
    const writes = writeCalls(client);
    expect(writes.map((c) => c.kind)).toEqual(['texts.update']);
    const [textId, ops, , options] = writes[0].args;
    expect(textId).toBe('text-1');
    expect(ops).toEqual([{ type: 'replace', index: 4, length: 3, value: 'cat' }]);
    expect(options.base).toBe(DIGEST);
    expect(client.operations.map((o) => o.message)).toEqual(['Respell kat → cat']);
  });

  it('shows the new spelling before the server answers, on the same token', async () => {
    let release;
    const held = new Promise((r) => (release = r));
    const client = makeFakeClient();
    const answer = client._postBatch;
    client._postBatch = async (...args) => {
      await held;
      return answer(...args);
    };
    const doc = makeIgtDoc({ raw: rawWith(), client });
    const done = doc.respellWord('w-2', 'kitten');
    expect(doc.body).toBe('the kitten');
    const word = wordL(doc.raw).tokens.find((t) => t.id === 'w-2');
    expect([word.begin, word.end]).toEqual([4, 10]);
    const morpheme = morphL(doc.raw).tokens.find((t) => t.id === 'm-2');
    expect([morpheme.begin, morpheme.end]).toEqual([4, 10]);
    release();
    expect(await done).toBe(true);
  });

  it('sends nothing for the spelling the word has', async () => {
    const client = makeFakeClient();
    const doc = makeIgtDoc({ raw: rawWith(), client });
    expect(await doc.respellWord('w-2', 'kat')).toBe(true);
    expect(writeCalls(client)).toEqual([]);
  });

  it('refuses nothing typed, a space and a line break, sending nothing', async () => {
    const client = makeFakeClient();
    const doc = makeIgtDoc({ raw: rawWith(), client });
    const onError = vi.fn();
    doc.onError = onError;
    for (const typed of ['', 'c at', 'c\nat']) {
      expect(await doc.respellWord('w-2', typed)).toBe(false);
    }
    expect(writeCalls(client)).toEqual([]);
    expect(doc.body).toBe('the kat');
    expect(onError).toHaveBeenCalledWith(RESPELL_SPACE);
  });

  it('writes nothing through a past state of the document', async () => {
    const client = makeFakeClient();
    const doc = makeIgtDoc({ raw: rawWith(), client, asOf: '2026-10-01T00:00:00Z' });
    expect(await doc.respellWord('w-2', 'cat')).toBe(false);
    expect(writeCalls(client)).toEqual([]);
    expect(doc.body).toBe('the kat');
  });

  it('never writes a split word’s morpheme forms', async () => {
    const raw = rawWith({
      morphemes: [
        { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} },
        { id: 'm-a', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: { form: 'ka' } },
        { id: 'm-b', text: 'text-1', begin: 4, end: 7, precedence: 2, metadata: { form: 't' } },
      ],
    });
    const client = makeFakeClient();
    const doc = makeIgtDoc({ raw, client });
    answersText(client, () => doc);
    await doc.respellWord('w-2', 'cat');
    expect(writeCalls(client).map((c) => c.kind)).toEqual(['texts.update']);
    const forms = morphL(doc.raw).tokens.map((m) => m.metadata.form);
    expect(forms).toEqual([undefined, 'ka', 't']);
  });

  it('writes nothing for a sole morpheme with no form of its own: it reads the word', async () => {
    const client = makeFakeClient();
    const doc = makeIgtDoc({ raw: rawWith(), client });
    answersText(client, () => doc);
    await doc.respellWord('w-2', 'cat');
    expect(writeCalls(client).map((c) => c.kind)).toEqual(['texts.update']);
    const word = doc.sentences[0].tokens[1];
    expect(word.morphemes.map((m) => m.form ?? m.content)).toEqual(['cat']);
  });

  it('respells a sole morpheme’s stored form that spells the word, in the same batch (H17)', async () => {
    const raw = rawWith({
      morphemes: [
        { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} },
        { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: { form: 'kat' } },
      ],
    });
    const client = makeFakeClient();
    const doc = makeIgtDoc({ raw, client });
    answersText(client, () => doc);
    await doc.respellWord('w-2', 'cat');
    const writes = writeCalls(client);
    expect(writes.map((c) => c.kind)).toEqual(['texts.update', 'tokens.bulkUpdate']);
    expect(client.calls.filter((c) => c.kind === 'batch.submit')).toHaveLength(1);
    const [[patch]] = writes[1].args;
    expect(patch.id).toBe('m-2');
    expect(patch.metadata[0]).toEqual({ op: 'set', path: ['form'], value: 'cat' });
    expect(morphL(doc.raw).tokens.find((m) => m.id === 'm-2').metadata.form).toBe('cat');
  });

  it('leaves a sole morpheme with a form of its own as it is', async () => {
    const raw = rawWith({
      morphemes: [
        { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} },
        { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: { form: 'kæt' } },
      ],
    });
    const client = makeFakeClient();
    const doc = makeIgtDoc({ raw, client });
    answersText(client, () => doc);
    await doc.respellWord('w-2', 'cat');
    expect(writeCalls(client).map((c) => c.kind)).toEqual(['texts.update']);
    expect(morphL(doc.raw).tokens.find((m) => m.id === 'm-2').metadata.form).toBe('kæt');
  });

  it('counts offsets and lengths in code points for astral letters', async () => {
    const client = makeFakeClient();
    const doc = makeIgtDoc({
      raw: rawWith({
        body: '𐌰𐌱 kat',
        words: [
          { id: 'w-1', begin: 0, end: 2 },
          { id: 'w-2', begin: 3, end: 6 },
        ],
      }),
      client,
    });
    answersText(client, () => doc);
    await doc.respellWord('w-1', '𐌰𐌲𐌱');
    const [, ops] = writeCalls(client)[0].args;
    expect(ops).toEqual([{ type: 'replace', index: 0, length: 2, value: '𐌰𐌲𐌱' }]);
    const words = wordL(doc.raw).tokens.map((t) => [t.begin, t.end]);
    expect(words).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it('respells a right-to-left word by the same offsets', async () => {
    const client = makeFakeClient();
    const doc = makeIgtDoc({
      raw: rawWith({
        body: 'كتب ولد',
        words: [
          { id: 'w-1', begin: 0, end: 3 },
          { id: 'w-2', begin: 4, end: 7 },
        ],
      }),
      client,
    });
    answersText(client, () => doc);
    await doc.respellWord('w-2', 'أولاد');
    const [, ops] = writeCalls(client)[0].args;
    expect(ops).toEqual([{ type: 'replace', index: 4, length: 3, value: 'أولاد' }]);
    expect(doc.body).toBe('كتب أولاد');
  });

  it('sends again at the new digest when the text changed elsewhere and the word reads as it did', async () => {
    const reloaded = rawWith({
      body: 'oh the kat',
      words: [
        { id: 'w-0', begin: 0, end: 2 },
        { id: 'w-1', begin: 3, end: 6 },
        { id: 'w-2', begin: 7, end: 10 },
      ],
    });
    reloaded.textLayers[0].text.digest = 'digest-elsewhere';
    const client = makeFakeClient({ reloadDoc: reloaded });
    const answer = client._postBatch;
    let refused = false;
    client._postBatch = async (...args) => {
      if (!refused) {
        refused = true;
        throw refusal(409, { error: 'text-changed' });
      }
      return answer(...args);
    };
    const doc = makeIgtDoc({ raw: rawWith(), client });
    answersText(client, () => doc);
    expect(await doc.respellWord('w-2', 'cat')).toBe(true);
    const sends = writeCalls(client).filter((c) => c.kind === 'texts.update');
    expect(sends).toHaveLength(2);
    expect(sends[1].args[1]).toEqual([{ type: 'replace', index: 7, length: 3, value: 'cat' }]);
    expect(sends[1].args[3].base).toBe('digest-elsewhere');
    await settle(3);
    expect(doc.body).toBe('oh the cat');
  });

  it('refuses, sending nothing more, when the word was changed elsewhere', async () => {
    const reloaded = rawWith({ body: 'the dog' });
    reloaded.textLayers[0].text.digest = 'digest-elsewhere';
    const client = makeFakeClient({ reloadDoc: reloaded });
    client._postBatch = async () => {
      throw refusal(409, { error: 'text-changed' });
    };
    const doc = makeIgtDoc({ raw: rawWith(), client });
    const onError = vi.fn();
    doc.onError = onError;
    expect(await doc.respellWord('w-2', 'cat')).toBe(false);
    expect(writeCalls(client).filter((c) => c.kind === 'texts.update')).toHaveLength(1);
    await settle(3);
    expect(doc.body).toBe('the dog');
    expect(onError.mock.calls.some(([m]) => /“kat” was changed elsewhere/.test(m))).toBe(true);
  });

  it('takes the server’s answer: the body and the digest it stored', async () => {
    const client = makeFakeClient();
    const answer = client._postBatch;
    client._postBatch = async (...args) => {
      const res = await answer(...args);
      res[0].body = textAnswer('the cat');
      return res;
    };
    const doc = makeIgtDoc({ raw: rawWith(), client });
    await doc.respellWord('w-2', 'cat');
    expect(doc.layerInfo.primaryTextLayer.text.digest).toBe('digest-2');
  });
});
