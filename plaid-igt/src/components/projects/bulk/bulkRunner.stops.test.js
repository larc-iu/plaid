import { describe, it, expect, vi } from 'vitest';

const feedback = vi.hoisted(() => ({
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  notifySuccess: vi.fn(),
  humanizeError: (e) => `said: ${e.message}`,
}));
vi.mock('@/utils/feedback', () => feedback);

const { applyField, applyRespell } = await import('./bulkRunner.js');
const { notifyStopped } = await import('./bulkShared.js');

// Two things a Bulk Edit apply says about itself (REV-F-BULK defects 7 and 8).
// A run that stops partway says what it wrote before the stop, as Re-analyze
// does. And a retry after an answer that never came does not count this
// user's own landed values as "changed since the preview".

// A server holding each document's version. A batch stamped with a stale
// version is refused 409. `lose` makes the next batch land and its answer
// never arrive (status 0), `fail` refuses the next batch on a document.
function serverAndClient(versions) {
  const server = { versions: { ...versions }, batches: [], lose: null, fail: null };
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
      const op = (kind) => (arg0) => ops.push({ kind, arg0 });
      await fn({
        texts: { update: op('texts.update') },
        spans: { bulkUpdate: op('spans.bulkUpdate') },
        tokens: { bulkUpdate: op('tokens.bulkUpdate') },
      });
      const doc = client.strictModeDocumentId;
      const version = client.documentVersions[doc];
      server.batches.push({ doc, version });
      if (server.fail?.doc === doc) throw server.fail.error;
      if (version !== server.versions[doc]) {
        throw Object.assign(new Error('HTTP 409'), { status: 409, method: 'POST' });
      }
      server.versions[doc] += 1;
      if (server.lose === doc) {
        server.lose = null;
        throw Object.assign(new Error('Network error'), { status: 0, method: 'POST' });
      }
      return ops.map(() => ({ status: 200 }));
    },
  };
  return { server, client };
}

const spanRow = (docId, id, old, next) => ({
  docId,
  docName: `Doc ${docId}`,
  id,
  kind: 'span',
  old,
  new: next,
});

describe('a retry after a lost answer', () => {
  it('counts a value that already reads as replaced as replaced, not skipped', async () => {
    const { server, client } = serverAndClient({ a: 1 });
    // What the document holds when read again: the replaced value.
    const replan = async () => ({
      version: server.versions.a,
      rows: [],
      now: new Map([['s1', spanRow('a', 's1', 'FELINE', 'FELINE')]]),
    });
    const plan = { rows: [spanRow('a', 's1', 'CAT', 'FELINE')], versions: { a: 1 }, replan };
    server.lose = 'a';
    await expect(applyField(client, plan, { label: 'Replace' })).rejects.toThrow('Network');
    const out = await applyField(client, plan, { label: 'Replace' });
    expect(out).toEqual({ changed: 1, skipped: 0 });
    // Refused at the old version, and nothing sent again.
    expect(server.batches.map((b) => [b.doc, b.version])).toEqual([
      ['a', 1],
      ['a', 1],
    ]);
  });

  it('still skips a value someone else changed to something else', async () => {
    const { server, client } = serverAndClient({ a: 2 });
    const replan = async () => ({
      version: server.versions.a,
      rows: [],
      now: new Map([['s1', spanRow('a', 's1', 'KITTY', 'KITTY')]]),
    });
    const plan = { rows: [spanRow('a', 's1', 'CAT', 'FELINE')], versions: { a: 1 }, replan };
    expect(await applyField(client, plan, { label: 'Replace' })).toEqual({
      changed: 0,
      skipped: 1,
    });
  });

  it('counts a word that already reads as respelled, morpheme forms included', async () => {
    const { server, client } = serverAndClient({ a: 1 });
    const word = {
      docId: 'a',
      id: 'w1',
      textId: 't-a',
      begin: 0,
      end: 6,
      old: 'garden',
      new: 'yard',
      morphemes: [{ id: 'm1', old: 'garden', new: 'yard' }],
    };
    let morphNow = 'yard';
    const replan = async () => ({
      version: server.versions.a,
      rows: [],
      now: new Map([
        ['w1', { id: 'w1', old: 'yard', morphemes: [{ id: 'm1', old: morphNow, new: morphNow }] }],
      ]),
    });
    const opts = { includeMorphemes: true, includeLexicon: false, label: 'Respell' };
    server.lose = 'a';
    await expect(
      applyRespell(client, { rows: [word], lexiconRows: [], versions: { a: 1 }, replan }, opts),
    ).rejects.toThrow('Network');
    const out = await applyRespell(
      client,
      { rows: [word], lexiconRows: [], versions: { a: 1 }, replan },
      opts,
    );
    expect(out).toMatchObject({
      docsChanged: 1,
      wordsChanged: 1,
      morphemesChanged: 1,
      wordsSkipped: 0,
    });
    // A morpheme form someone else set meanwhile: the word is not the preview's.
    const again = { ...word, applied: false };
    morphNow = 'garth';
    const { client: c2 } = serverAndClient({ a: 5 });
    const out2 = await applyRespell(
      c2,
      { rows: [again], lexiconRows: [], versions: { a: 1 }, replan },
      opts,
    );
    expect(out2).toMatchObject({ wordsChanged: 0, wordsSkipped: 1 });
  });
});

describe('a run that stops partway', () => {
  it('Replace in a field resolves with what it wrote and where it stopped', async () => {
    const { server, client } = serverAndClient({ a: 1, b: 1 });
    const error = Object.assign(new Error('HTTP 500'), { status: 500, method: 'POST' });
    server.fail = { doc: 'b', error };
    const out = await applyField(
      client,
      {
        rows: [spanRow('a', 's1', 'CAT', 'FELINE'), spanRow('b', 's2', 'CAT', 'FELINE')],
        versions: { a: 1, b: 1 },
      },
      { label: 'Replace' },
    );
    expect(out).toEqual({ changed: 1, skipped: 0, failed: { docName: 'Doc b', error } });
  });

  it('Respell resolves with what it wrote and where it stopped', async () => {
    const { server, client } = serverAndClient({ a: 1, b: 1 });
    const error = Object.assign(new Error('HTTP 500'), { status: 500, method: 'POST' });
    server.fail = { doc: 'b', error };
    const word = (docId) => ({
      docId,
      docName: `Doc ${docId}`,
      id: `w-${docId}`,
      textId: `t-${docId}`,
      begin: 0,
      end: 6,
      old: 'garden',
      new: 'yard',
      morphemes: [],
    });
    const out = await applyRespell(
      client,
      { rows: [word('a'), word('b')], lexiconRows: [], versions: { a: 1, b: 1 } },
      { includeMorphemes: false, includeLexicon: false, label: 'Respell' },
    );
    expect(out).toMatchObject({ docsChanged: 1, wordsChanged: 1, failed: { docName: 'Doc b' } });
  });

  it('a stop before anything landed fails as before', async () => {
    const { server, client } = serverAndClient({ a: 1 });
    server.fail = { doc: 'a', error: Object.assign(new Error('HTTP 500'), { status: 500 }) };
    await expect(
      applyField(
        client,
        { rows: [spanRow('a', 's1', 'CAT', 'FELINE')], versions: { a: 1 } },
        { label: 'Replace' },
      ),
    ).rejects.toThrow('HTTP 500');
  });

  it('the toasts give the error, then what was written before the stop', () => {
    const error = new Error('boom');
    notifyStopped(
      { docName: 'Doc b', error },
      '3 values replaced in Gloss',
      ' Skipped 1 value changed since the preview.',
    );
    expect(feedback.notifyError).toHaveBeenCalledWith('said: boom', 'Failed to apply');
    expect(feedback.notifyWarning).toHaveBeenCalledWith(
      '3 values replaced in Gloss before “Doc b” failed. The remaining documents were not changed. Skipped 1 value changed since the preview.',
      'Stopped early',
    );
    notifyStopped({ docName: null, error }, '2 words in 1 document respelled');
    expect(feedback.notifyWarning).toHaveBeenLastCalledWith(
      '2 words in 1 document respelled before the lexicon entries failed.',
      'Stopped early',
    );
  });
});

describe('an apply in progress', () => {
  it('says which document it is on, out of how many, and the lexicon step', async () => {
    const { client } = serverAndClient({ a: 1, b: 1 });
    const word = (docId) => ({
      docId,
      docName: `Doc ${docId}`,
      id: `w-${docId}`,
      textId: `t-${docId}`,
      begin: 0,
      end: 6,
      old: 'garden',
      new: 'yard',
      morphemes: [],
    });
    const said = [];
    await applyRespell(
      client,
      { rows: [word('a'), word('b')], lexiconRows: [], versions: { a: 1, b: 1 } },
      {
        includeMorphemes: false,
        includeLexicon: false,
        label: 'Respell',
        onProgress: (...args) => said.push(args),
      },
    );
    expect(said).toEqual([
      [1, 2],
      [2, 2],
    ]);
    const fieldSaid = [];
    const { client: c2 } = serverAndClient({ a: 1 });
    await applyField(
      c2,
      { rows: [spanRow('a', 's1', 'CAT', 'FELINE')], versions: { a: 1 } },
      { label: 'Replace', onProgress: (...args) => fieldSaid.push(args) },
    );
    expect(fieldSaid).toEqual([[1, 1]]);
  });

  it('does not count the rows a stopped apply sent or skipped a second time', async () => {
    const { server, client } = serverAndClient({ a: 1, b: 1 });
    server.fail = {
      doc: 'b',
      error: Object.assign(new Error('HTTP 500'), { status: 500, method: 'POST' }),
    };
    const rows = [spanRow('a', 's1', 'CAT', 'FELINE'), spanRow('b', 's2', 'CAT', 'FELINE')];
    await applyField(client, { rows, versions: { a: 1, b: 1 } }, { label: 'Replace' });
    // What the panels count for the Apply button and its confirm.
    expect(rows.filter((r) => !r.applied).map((r) => r.id)).toEqual(['s2']);
  });

  it('a document whose answer was lost is not called failed', () => {
    const error = Object.assign(new Error('Network error'), { status: 0, method: 'POST' });
    notifyStopped({ docName: 'Laa kthee', error }, '404 words in 1 document respelled');
    expect(feedback.notifyWarning).toHaveBeenLastCalledWith(
      '404 words in 1 document respelled. No answer for “Laa kthee”, which may or may not be changed. The documents after it were not changed.',
      'Stopped early',
    );
  });
});
