// The Baseline tab's save as edits at the caret (editBaselineText): sent with
// the digest of the body they were typed over, the document patched from the
// answer's reshape, moved onto a text saved elsewhere, and looked up when the
// answer is lost.
import { beforeEach, describe, expect, it } from 'vitest';
import { applyTextOps, gapsToOps } from '@larc-iu/plaid-client';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';
import { digestOf, segmentServer } from '../test/segmentServer.js';

function makeDoc({ raw, client }) {
  return new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client,
    projectId: 'proj-1',
  });
}

const withDigest = (raw, digest) => {
  raw.textLayers[0].text.digest = digest;
  return raw;
};

const httpError = (status, data) =>
  Object.assign(new Error(`HTTP ${status} at http://x/api/v1/texts/text-1`), {
    status,
    method: 'PATCH',
    responseData: data,
  });

const edits = (client) => client.calls.filter((c) => c.kind === 'texts.edit').map((c) => c.args);

beforeEach(() => resetIds());

describe('editBaselineText', () => {
  it('sends the edits with the digest they were typed over, and patches from the answer', async () => {
    const client = makeFakeClient();
    let reads = 0;
    const get = client.documents.get;
    client.documents.get = async (...a) => {
      reads += 1;
      return get(...a);
    };
    client.texts.edit = async (id, ops, auditMessage, options) => {
      client.calls.push({ kind: 'texts.edit', args: [id, ops, auditMessage, options] });
      return {
        id,
        body: 'the cats',
        digest: 'd1',
        reshape: {
          tokens: [{ id: 's-1', begin: 0, end: 8 }],
          spans: [],
          vocabLinks: [],
          deleted: { tokens: ['m-2'], spans: [], relations: [], vocabLinks: [] },
        },
      };
    };
    const doc = makeDoc({ raw: withDigest(buildRawDoc({ body: 'the cat' }), 'd0'), client });
    const gaps = [{ start: 7, end: 7, value: 's' }];
    expect(await doc.editBaselineText({ base: 'the cat', digest: 'd0', gaps })).toBe(true);
    expect(edits(client)).toEqual([
      ['text-1', [{ type: 'insert', index: 7, value: 's' }], undefined, { base: 'd0' }],
    ]);
    expect(reads).toBe(0);
    expect(doc.body).toBe('the cats');
    expect(doc.layerInfo.primaryTextLayer.text.digest).toBe('d1');
    expect(doc.layerInfo.sentenceTokenLayer.tokens.map((t) => [t.begin, t.end])).toEqual([[0, 8]]);
    expect(doc.layerInfo.morphemeTokenLayer.tokens.map((t) => t.id)).toEqual(['m-1']);
  });

  it('moves the edits onto a text saved elsewhere after the digest is refused, and sends them with its digest', async () => {
    const theirs = withDigest(
      buildRawDoc({
        body: 'a big cat. b',
        words: [],
        morphemes: [],
        sentences: [{ id: 's-1', begin: 0, end: 12 }],
      }),
      'd9',
    );
    const client = makeFakeClient({ reloadDoc: theirs });
    let sent = 0;
    client.texts.edit = async (id, ops, auditMessage, options) => {
      client.calls.push({ kind: 'texts.edit', args: [id, ops, auditMessage, options] });
      sent += 1;
      if (sent === 1) throw httpError(409, { 'text-changed': true, digest: 'd9' });
      return { id, body: 'a big cat. bx', digest: 'd10', reshape: { tokens: [], deleted: {} } };
    };
    const doc = makeDoc({
      raw: withDigest(
        buildRawDoc({
          body: 'a cat. b',
          words: [],
          morphemes: [],
          sentences: [{ id: 's-1', begin: 0, end: 8 }],
        }),
        'd0',
      ),
      client,
    });
    expect(
      await doc.editBaselineText({
        base: 'a cat. b',
        digest: 'd0',
        gaps: [{ start: 8, end: 8, value: 'x' }],
      }),
    ).toBe(true);
    expect(edits(client).map((a) => [a[1], a[3]])).toEqual([
      [[{ type: 'insert', index: 8, value: 'x' }], { base: 'd0' }],
      [[{ type: 'insert', index: 12, value: 'x' }], { base: 'd9' }],
    ]);
    expect(doc.body).toBe('a big cat. bx');
  });

  it('refuses an edit of a passage changed elsewhere, and sends nothing over it', async () => {
    const theirs = withDigest(buildRawDoc({ body: 'a dog', words: [], morphemes: [] }), 'd9');
    const client = makeFakeClient({ reloadDoc: theirs });
    client.texts.edit = async (id, ops, auditMessage, options) => {
      client.calls.push({ kind: 'texts.edit', args: [id, ops, auditMessage, options] });
      throw httpError(409, { 'text-changed': true, digest: 'd9' });
    };
    const errors = [];
    const doc = makeDoc({
      raw: withDigest(buildRawDoc({ body: 'a cat', words: [], morphemes: [] }), 'd0'),
      client,
    });
    doc.onError = (message, err) => errors.push(err?.message ?? message);
    expect(
      await doc.editBaselineText({
        base: 'a cat',
        digest: 'd0',
        gaps: [{ start: 2, end: 5, value: 'cow' }],
      }),
    ).toBe(false);
    expect(edits(client)).toHaveLength(1);
    expect(errors.join(' ')).toMatch(/same passage was changed elsewhere/);
  });

  it('sends the edit and the first sentences in one batch when the text has none, measured on the new body', async () => {
    const raw = withDigest(
      buildRawDoc({ body: 'one', sentences: [], words: [], morphemes: [] }),
      'd0',
    );
    const client = makeFakeClient({
      reloadDoc: buildRawDoc({
        body: 'one\ntwo',
        sentences: [
          { id: 's-1', begin: 0, end: 4 },
          { id: 's-2', begin: 4, end: 7 },
        ],
      }),
    });
    const doc = makeDoc({ raw, client });
    const gaps = [{ start: 3, end: 3, value: '\ntwo' }];
    expect(await doc.editBaselineText({ base: 'one', digest: 'd0', gaps })).toBe(true);
    const kinds = client.calls.map((c) => c.kind);
    expect(kinds).toContain('texts.edit');
    const seed = client.calls.find((c) => c.kind === 'tokens.bulkCreate').args[0];
    expect(seed.map((s) => [s.begin, s.end])).toEqual([
      [0, 4],
      [4, 7],
    ]);
    expect(doc.body).toBe('one\ntwo');
  });

  it('sends an edit whose answer was lost again, the same request, and patches from the answer', async () => {
    const client = makeFakeClient();
    let sent = 0;
    client.texts.edit = async (id, ops, auditMessage, options) => {
      client.calls.push({ kind: 'texts.edit', args: [id, ops, auditMessage, options] });
      sent += 1;
      if (sent === 1) {
        throw Object.assign(new Error('Network error at http://x/api/v1/texts/text-1'), {
          status: 0,
          method: 'PATCH',
        });
      }
      return { id, body: 'the cats', digest: 'd1', reshape: { tokens: [], deleted: {} } };
    };
    const doc = makeDoc({ raw: withDigest(buildRawDoc({ body: 'the cat' }), 'd0'), client });
    const gaps = [{ start: 7, end: 7, value: 's' }];
    expect(applyTextOps('the cat', gapsToOps(gaps))).toBe('the cats');
    expect(await doc.editBaselineText({ base: 'the cat', digest: 'd0', gaps })).toBe(true);
    const [first, second] = edits(client);
    expect(second).toEqual(first);
    expect(doc.body).toBe('the cats');
  });
});

// Against a server that keeps what it stores, with strict mode, keys and
// minted ids (test/segmentServer.js).
describe('editBaselineText against the stored text', () => {
  const seg = (id, begin, end, timeBegin, timeEnd) => ({
    id,
    text: 'text-1',
    begin,
    end,
    metadata: { timeBegin, timeEnd },
  });
  const open = (server) => {
    const doc = new IgtDocument({
      raw: structuredClone(server.stored),
      project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
      vocabularies: {},
      client: server.client,
      projectId: 'proj-1',
      user: { id: 'a' },
    });
    doc._writes._retryDelay = () => 5;
    return doc;
  };
  const textEdits = (server) =>
    server.sent
      .flatMap((r) => (r.kind === 'batch' ? r.ops : [r]))
      .filter((w) => w.kind === 'texts.edit');

  it('never sends an edit without a base: a digest not known yet is read first', async () => {
    const server = segmentServer(
      buildRawDoc({
        body: 'one two three',
        words: [],
        morphemes: [],
        alignmentTokens: [seg('a-1', 0, 3, 0, 1), seg('a-2', 4, 7, 1, 2), seg('a-3', 8, 13, 2, 3)],
      }),
    );
    const doc = open(server);
    // A segment edit in the Media tab: the body changes here, and its digest
    // is not known until the answer. Edit is clicked on Baseline meanwhile.
    const segmentWrite = doc.editAlignment('a-2', { text: 'TWO', timeBegin: 1, timeEnd: 2 });
    const base = doc.body;
    const digest = doc.layerInfo.primaryTextLayer.text.digest ?? null;
    expect(digest).toBe(null);
    await segmentWrite;
    // Someone else saves a word at the start, which this page has not read.
    server.otherSaves([{ type: 'insert', index: 0, value: 'zero ' }]);
    const gaps = [{ start: 13, end: 13, value: '!' }];
    expect(await doc.editBaselineText({ base, digest, gaps })).toBe(true);
    expect(server.body).toBe('zero one TWO three!');
    expect(textEdits(server).every((w) => w.args[3]?.base)).toBe(true);
    expect(doc.body).toBe(server.body);
  });

  it('refuses, with nothing sent, when the text read has no digest', async () => {
    const client = makeFakeClient({
      reloadDoc: buildRawDoc({ body: 'the cat', words: [], morphemes: [] }),
    });
    const doc = makeDoc({ raw: buildRawDoc({ body: 'the cat' }), client });
    const errors = [];
    doc.onError = (message, err) => errors.push(err?.message ?? message);
    const gaps = [{ start: 7, end: 7, value: 's' }];
    expect(await doc.editBaselineText({ base: 'the cat', digest: null, gaps })).toBe(false);
    expect(client.calls.filter((c) => c.kind === 'texts.edit')).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('refused, moved onto the text stored and sent, then its answer lost: sent again as it was, and answered from what it stored', async () => {
    const server = segmentServer(
      buildRawDoc({
        body: 'the cat',
        words: [],
        morphemes: [],
        sentences: [{ id: 's-1', begin: 0, end: 7 }],
      }),
    );
    const doc = open(server);
    const errors = [];
    doc.onError = (message, err) => errors.push(err?.message ?? message);
    server.otherSaves([{ type: 'insert', index: 0, value: 'a ' }]);
    server.loseNext(1);
    const gaps = [{ start: 7, end: 7, value: 's' }];
    expect(await doc.editBaselineText({ base: 'the cat', digest: digestOf('the cat'), gaps })).toBe(
      true,
    );
    expect(server.body).toBe('a the cats');
    expect(textEdits(server).map((w) => w.answer)).toEqual([409, 'lost', 'replayed']);
    const [, lost, again] = textEdits(server);
    expect(again.key).toBe(lost.key);
    expect(errors).toEqual([]);
    expect(doc.body).toBe('a the cats');
  });

  it('a key sent before with another request is read back, and a save found stored has landed', async () => {
    const server = segmentServer(buildRawDoc({ body: 'the cat', words: [], morphemes: [] }));
    const doc = open(server);
    const errors = [];
    doc.onError = (message, err) => errors.push(err?.message ?? message);
    const edit = server.client.texts.edit;
    server.client.texts.edit = async (...args) => {
      await edit(...args);
      throw Object.assign(new Error('HTTP 422'), {
        status: 422,
        responseData: { error: 'idempotency-key-reused' },
      });
    };
    const gaps = [{ start: 7, end: 7, value: 's' }];
    expect(await doc.editBaselineText({ base: 'the cat', digest: digestOf('the cat'), gaps })).toBe(
      true,
    );
    expect(errors).toEqual([]);
    expect(server.body).toBe('the cats');
    expect(doc.body).toBe('the cats');
  });

  it('drops a deleted link from the vocabularies kept beside the document too', async () => {
    const link = { id: 'L1', tokens: ['m-2'], vocabItem: { id: 'i1', form: 'cat' } };
    const raw = withDigest(
      buildRawDoc({
        body: 'the cat',
        morphVocabs: [{ id: 'v1', name: 'Lex', vocabLinks: [link] }],
      }),
      'd0',
    );
    const client = makeFakeClient();
    client.texts.edit = async (id) => ({
      id,
      body: 'the',
      digest: 'd1',
      reshape: {
        tokens: [{ id: 's-1', begin: 0, end: 3 }],
        spans: [],
        vocabLinks: [],
        deleted: { tokens: ['w-2', 'm-2'], spans: [], relations: [], vocabLinks: ['L1'] },
      },
    });
    const doc = new IgtDocument({
      raw,
      project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
      vocabularies: { v1: { id: 'v1', name: 'Lex', items: [{ id: 'i1', form: 'cat' }] } },
      client,
      projectId: 'proj-1',
    });
    expect(doc.vocabularies.v1.vocabLinks.map((l) => l.id)).toEqual(['L1']);
    const gaps = [{ start: 3, end: 7, value: '' }];
    expect(await doc.editBaselineText({ base: 'the cat', digest: 'd0', gaps })).toBe(true);
    expect(doc.vocabularies.v1.vocabLinks).toEqual([]);
  });
});
