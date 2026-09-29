import { describe, it, expect } from 'vitest';
import { applyField, applyReanalyze, applyRespell } from './bulkRunner.js';
import { extractAnalysis, analysisSignature } from '@/domain/analysisMemory.js';

// Bulk Edit previews, then applies what the preview showed. Between the two,
// someone else can change a document. Every document's writes carry the
// version the preview read, so the server refuses a changed document whole,
// and the run reads it again and writes only what still reads as the preview
// showed it. Before this, a replace wrote over a value typed after the
// preview, and a respell wrote its offsets into text that had moved.

// A server holding each document's version, and a client in front of it with
// the real client's strict mode. A batch goes out stamped with the strict
// document's version, and is refused (409) unless that is the version stored.
// A write with no version is refused as a bug, never as a conflict.
function serverAndClient(versions, vocabs = {}) {
  const server = { versions: { ...versions }, vocabs, batches: [], entryUpdates: [], fail: null };
  const client = {
    documentVersions: {},
    strictModeDocumentId: null,
    enterStrictMode(docId) {
      this.strictModeDocumentId = docId;
    },
    exitStrictMode() {
      this.strictModeDocumentId = null;
    },
    withOperation: async (_label, fn) => fn(),
    async batched(fn) {
      const ops = [];
      const op = (kind) => (arg0, arg1) => ops.push({ kind, arg0, arg1 });
      await fn({
        texts: { update: op('texts.update') },
        spans: { bulkUpdate: op('spans.bulkUpdate') },
        tokens: { bulkUpdate: op('tokens.bulkUpdate') },
      });
      const doc = client.strictModeDocumentId;
      const version = doc ? client.documentVersions[doc] : undefined;
      server.batches.push({ doc, version, ops });
      if (server.fail) throw server.fail;
      if (doc == null || version == null) throw new Error('A write went out with no version');
      if (version !== server.versions[doc]) {
        throw Object.assign(new Error('HTTP 409'), { status: 409, method: 'POST' });
      }
      server.versions[doc] += 1;
      return ops.map(() => ({ status: 200 }));
    },
    documents: { get: async (id) => ({ id, version: server.versions[id] }) },
    vocabLayers: { get: async (id) => server.vocabs[id] },
    vocabItems: {
      bulkUpdate: async (body) => {
        server.entryUpdates.push(...body);
      },
    },
  };
  return { server, client };
}

const spanRow = (docId, id, old, next) => ({ docId, id, kind: 'span', old, new: next });

describe('Replace in a field checks the version the preview read', () => {
  it('writes each unchanged document in one batch at its preview version', async () => {
    const { server, client } = serverAndClient({ a: 3, b: 5 });
    let replans = 0;
    const out = await applyField(
      client,
      {
        rows: [spanRow('a', 's1', 'CAT', 'FELINE'), spanRow('b', 's2', 'CAT', 'FELINE')],
        versions: { a: 3, b: 5 },
        replan: async () => (replans += 1),
      },
      { label: 'Replace' },
    );
    expect(out).toEqual({ changed: 2, skipped: 0 });
    expect(replans).toBe(0);
    expect(server.batches.map((b) => [b.doc, b.version])).toEqual([
      ['a', 3],
      ['b', 5],
    ]);
    expect(server.batches[0].ops[0]).toMatchObject({
      kind: 'spans.bulkUpdate',
      arg0: [{ id: 's1', value: 'FELINE' }],
    });
  });

  it('a changed document is read again and only the values still as previewed are replaced', async () => {
    // Someone retyped s1 (CAT to KITTY) after the preview: version 3 became 4.
    const { server, client } = serverAndClient({ a: 4 });
    const out = await applyField(
      client,
      {
        rows: [spanRow('a', 's1', 'CAT', 'FELINE'), spanRow('a', 's2', 'CAT', 'FELINE')],
        versions: { a: 3 },
        replan: async () => ({ version: 4, rows: [spanRow('a', 's2', 'CAT', 'FELINE')] }),
      },
      { label: 'Replace' },
    );
    expect(out).toEqual({ changed: 1, skipped: 1 });
    expect(server.batches.map((b) => [b.doc, b.version])).toEqual([
      ['a', 3],
      ['a', 4],
    ]);
    expect(server.batches[1].ops.map((o) => o.arg0)).toEqual([[{ id: 's2', value: 'FELINE' }]]);
  });

  it('a value that reads differently when read again is skipped', async () => {
    const { server, client } = serverAndClient({ a: 4 });
    const out = await applyField(
      client,
      {
        rows: [spanRow('a', 's1', 'CAT', 'FELINE')],
        versions: { a: 3 },
        replan: async () => ({ version: 4, rows: [spanRow('a', 's1', 'CATS', 'FELINES')] }),
      },
      { label: 'Replace' },
    );
    expect(out).toEqual({ changed: 0, skipped: 1 });
    expect(server.batches).toHaveLength(1);
  });

  it('a document refused again is skipped whole', async () => {
    const { server, client } = serverAndClient({ a: 4 });
    const out = await applyField(
      client,
      {
        rows: [spanRow('a', 's1', 'CAT', 'FELINE')],
        versions: { a: 3 },
        // It changes again while being read.
        replan: async () => {
          server.versions.a += 1;
          return { version: 4, rows: [spanRow('a', 's1', 'CAT', 'FELINE')] };
        },
      },
      { label: 'Replace' },
    );
    expect(out).toEqual({ changed: 0, skipped: 1 });
    expect(server.versions.a).toBe(5);
  });

  it('morpheme forms go in the same versioned batch', async () => {
    const { server, client } = serverAndClient({ a: 1 });
    await applyField(
      client,
      {
        rows: [
          spanRow('a', 's1', 'CAT', 'FELINE'),
          { ...spanRow('a', 'm1', 'ka', 'kaa'), kind: 'morphForm' },
        ],
        versions: { a: 1 },
      },
      { label: 'Replace' },
    );
    expect(server.batches).toHaveLength(1);
    expect(server.batches[0].ops.map((o) => o.kind)).toEqual([
      'spans.bulkUpdate',
      'tokens.bulkUpdate',
    ]);
  });

  it('a refusal that is not a conflict stops the run', async () => {
    const { server, client } = serverAndClient({ a: 1 });
    server.fail = Object.assign(new Error('HTTP 500'), { status: 500 });
    await expect(
      applyField(
        client,
        { rows: [spanRow('a', 's1', 'CAT', 'FELINE')], versions: { a: 1 } },
        { label: 'Replace' },
      ),
    ).rejects.toThrow('HTTP 500');
  });
});

describe('Respell checks the version the preview read', () => {
  const word = (docId, id, begin, old = 'garden', next = 'yard') => ({
    docId,
    id,
    textId: `t-${docId}`,
    begin,
    end: begin + old.length,
    old,
    new: next,
    morphemes: [],
  });
  const opts = { includeMorphemes: true, includeLexicon: false, label: 'Respell' };

  it('a document whose text moved is respelled at the offsets read again', async () => {
    // "black " was typed before the word after the preview.
    const { server, client } = serverAndClient({ a: 8 });
    const out = await applyRespell(
      client,
      {
        rows: [word('a', 'w1', 20)],
        lexiconRows: [],
        versions: { a: 7 },
        replan: async () => ({ version: 8, rows: [word('a', 'w1', 26)] }),
      },
      opts,
    );
    expect(out).toMatchObject({ docsChanged: 1, wordsChanged: 1, wordsSkipped: 0 });
    expect(server.batches.map((b) => [b.version, b.ops[0].arg1])).toEqual([
      [7, [{ type: 'replace', index: 20, length: 6, value: 'yard' }]],
      [8, [{ type: 'replace', index: 26, length: 6, value: 'yard' }]],
    ]);
  });

  it('a word respelled by someone else since the preview is skipped', async () => {
    const { client } = serverAndClient({ a: 8 });
    const out = await applyRespell(
      client,
      {
        rows: [word('a', 'w1', 20), word('a', 'w2', 40)],
        lexiconRows: [],
        versions: { a: 7 },
        replan: async () => ({
          version: 8,
          rows: [word('a', 'w1', 20, 'gardens', 'yards'), word('a', 'w2', 40)],
        }),
      },
      opts,
    );
    expect(out).toMatchObject({ wordsChanged: 1, wordsSkipped: 1 });
  });

  it('a word whose morpheme forms changed since the preview is skipped', async () => {
    const { client } = serverAndClient({ a: 8 });
    const withForm = (form) => ({
      ...word('a', 'w1', 20),
      morphemes: [{ id: 'm1', old: form, new: 'yard' }],
    });
    const out = await applyRespell(
      client,
      {
        rows: [withForm('garden')],
        lexiconRows: [],
        versions: { a: 7 },
        replan: async () => ({ version: 8, rows: [withForm('gardn')] }),
      },
      opts,
    );
    expect(out).toMatchObject({ wordsChanged: 0, wordsSkipped: 1 });
  });

  it('a lexicon entry renamed since the preview is left alone', async () => {
    const { server, client } = serverAndClient(
      {},
      {
        v1: {
          id: 'v1',
          items: [
            { id: 'i1', form: 'garden' },
            { id: 'i2', form: 'gardenia' },
          ],
        },
      },
    );
    const out = await applyRespell(
      client,
      {
        rows: [],
        lexiconRows: [
          { id: 'i1', kind: 'lexicon', vocabId: 'v1', old: 'garden', new: 'yard' },
          { id: 'i2', kind: 'lexicon', vocabId: 'v1', old: 'gardenn', new: 'yardn' },
          { id: 'i3', kind: 'lexicon', vocabId: 'v1', old: 'gardens', new: 'yards' },
        ],
        versions: {},
      },
      { ...opts, includeLexicon: true },
    );
    expect(out).toMatchObject({ entriesChanged: 1, entriesSkipped: 2 });
    expect(server.entryUpdates).toEqual([{ id: 'i1', form: 'yard' }]);
  });
});

describe('Re-analyze checks the version the preview read', () => {
  const token = (id, gloss) => ({
    id,
    content: 'cat',
    annotations: gloss ? { Gloss: { id: `g-${id}`, value: gloss, metadata: {} } } : {},
    morphemes: [{ id: `m-${id}`, content: 'cat', annotations: {}, metadata: {} }],
  });
  const signature = (t) => {
    const a = extractAnalysis(t);
    return a ? analysisSignature(a) : null;
  };
  const target = { word: { vocabItemId: null, fields: { Gloss: 'FELINE' } }, morphemes: [] };

  // A document as the runner sees one: its words, its version, and the
  // re-analyze, which reports a conflict the way DocumentModel does (onError,
  // then the document is read again, then false).
  function fakeDoc(client, server, id, tokens, { conflictOnce = false, onRead = [] } = {}) {
    const doc = {
      id,
      raw: { version: server.versions[id] },
      tokenLookup: new Map(tokens.map((t) => [t.id, t])),
      document: { name: id },
      onError: null,
      sends: [],
      async reload() {
        this.raw = { version: server.versions[id] };
        this.tokenLookup = new Map(onRead.map((t) => [t.id, t]));
      },
      async bulkReplaceAnalyses(proposals) {
        const version = client.documentVersions[id];
        this.sends.push({
          strict: client.strictModeDocumentId,
          version,
          words: proposals.map((p) => p.wordTokenId),
        });
        if (conflictOnce || version !== server.versions[id]) {
          conflictOnce = false;
          server.versions[id] += 1;
          this.onError?.(
            'Failed to re-analyze words: HTTP 409',
            Object.assign(new Error('HTTP 409'), { status: 409, method: 'POST' }),
            'Failed to re-analyze words',
          );
          await this.reload();
          return false;
        }
        server.versions[id] += 1;
        return proposals.length;
      },
    };
    return doc;
  }

  it('an unchanged document is re-analyzed at its preview version', async () => {
    const { server, client } = serverAndClient({ a: 2 });
    const t1 = token('w1', 'KITTY');
    const doc = fakeDoc(client, server, 'a', [t1]);
    const out = await applyReanalyze(
      client,
      { rows: [{ docId: 'a', id: 'w1', signature: signature(t1) }], docs: [doc] },
      { analysis: target, label: 'Re-analyze' },
    );
    expect(out).toEqual({ changed: 1, skipped: 0, failedDoc: null });
    expect(doc.sends).toEqual([{ strict: 'a', version: 2, words: ['w1'] }]);
  });

  it('a document changed before Apply skips the words whose analysis changed', async () => {
    const { server, client } = serverAndClient({ a: 3 });
    const before = [token('w1', 'KITTY'), token('w2', null)];
    // w1 was reglossed TOMCAT after the preview. w2 is as it was.
    const now = [token('w1', 'TOMCAT'), token('w2', null)];
    const doc = fakeDoc(client, server, 'a', before, { onRead: now });
    doc.raw = { version: 2 };
    const errors = [];
    const out = await applyReanalyze(
      client,
      {
        rows: before.map((t) => ({ docId: 'a', id: t.id, signature: signature(t) })),
        docs: [doc],
      },
      { analysis: target, label: 'Re-analyze', onError: (m) => errors.push(m) },
    );
    expect(out).toEqual({ changed: 1, skipped: 1, failedDoc: null });
    expect(doc.sends).toEqual([{ strict: 'a', version: 3, words: ['w2'] }]);
    expect(errors).toEqual([]);
  });

  it('a conflict while writing reads the document again and retries once, unannounced', async () => {
    const { server, client } = serverAndClient({ a: 2 });
    const t1 = token('w1', 'KITTY');
    const doc = fakeDoc(client, server, 'a', [t1], { conflictOnce: true, onRead: [t1] });
    const errors = [];
    const out = await applyReanalyze(
      client,
      { rows: [{ docId: 'a', id: 'w1', signature: signature(t1) }], docs: [doc] },
      { analysis: target, label: 'Re-analyze', onError: (m) => errors.push(m) },
    );
    expect(out).toEqual({ changed: 1, skipped: 0, failedDoc: null });
    expect(doc.sends.map((s) => s.version)).toEqual([2, 3]);
    expect(errors).toEqual([]);
  });

  it('a document refused twice is skipped', async () => {
    const { server, client } = serverAndClient({ a: 2 });
    const t1 = token('w1', 'KITTY');
    const doc = fakeDoc(client, server, 'a', [t1], { onRead: [t1] });
    // Every write finds it changed again.
    const replace = doc.bulkReplaceAnalyses.bind(doc);
    doc.bulkReplaceAnalyses = async (p) => {
      server.versions.a += 1;
      return replace(p);
    };
    const out = await applyReanalyze(
      client,
      { rows: [{ docId: 'a', id: 'w1', signature: signature(t1) }], docs: [doc] },
      { analysis: target, label: 'Re-analyze' },
    );
    expect(out).toEqual({ changed: 0, skipped: 1, failedDoc: null });
  });

  it('another failure still stops the run and is shown', async () => {
    const { server, client } = serverAndClient({ a: 2, b: 2 });
    const t1 = token('w1', 'KITTY');
    const a = fakeDoc(client, server, 'a', [t1]);
    a.bulkReplaceAnalyses = async function () {
      this.onError?.('Failed to re-analyze words: HTTP 500', { status: 500 }, 'x');
      return false;
    };
    const b = fakeDoc(client, server, 'b', [t1]);
    const errors = [];
    const out = await applyReanalyze(
      client,
      {
        rows: [
          { docId: 'a', id: 'w1', signature: signature(t1) },
          { docId: 'b', id: 'w1', signature: signature(t1) },
        ],
        docs: [a, b],
      },
      { analysis: target, label: 'Re-analyze', onError: (m) => errors.push(m) },
    );
    expect(out).toEqual({ changed: 0, skipped: 0, failedDoc: 'a' });
    expect(errors).toEqual(['Failed to re-analyze words: HTTP 500']);
    expect(b.sends).toEqual([]);
  });
});
