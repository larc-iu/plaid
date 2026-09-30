// The Baseline tab's save as edits at the caret (editBaselineText): sent with
// the digest of the body they were typed over, the document patched from the
// answer's reshape, moved onto a text saved elsewhere, and looked up when the
// answer is lost.
import { beforeEach, describe, expect, it } from 'vitest';
import { applyTextOps, gapsToOps } from '@larc-iu/plaid-client';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';

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

  it('finds an edit whose answer was lost stored, and does not send it again', async () => {
    const landed = withDigest(buildRawDoc({ body: 'the cats' }), 'd1');
    const client = makeFakeClient({ reloadDoc: landed });
    client.texts.edit = async (id, ops, auditMessage, options) => {
      client.calls.push({ kind: 'texts.edit', args: [id, ops, auditMessage, options] });
      throw Object.assign(new Error('Network error at http://x/api/v1/texts/text-1'), {
        status: 0,
        method: 'PATCH',
      });
    };
    const doc = makeDoc({ raw: withDigest(buildRawDoc({ body: 'the cat' }), 'd0'), client });
    const gaps = [{ start: 7, end: 7, value: 's' }];
    expect(applyTextOps('the cat', gapsToOps(gaps))).toBe('the cats');
    expect(await doc.editBaselineText({ base: 'the cat', digest: 'd0', gaps })).toBe(true);
    expect(edits(client)).toHaveLength(1);
    expect(doc.body).toBe('the cats');
  });
});
