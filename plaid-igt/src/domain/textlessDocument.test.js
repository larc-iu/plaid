// A document with no text yet (made by ud's form, an import with no body, the
// API, or a New document whose second request failed) gets its text from the
// first write that needs one, in that write's batch (A3-8): the Baseline save,
// and a segment made in the Media tab. Against a server that keeps what it
// stores (test/segmentServer.js).
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRawDoc, makeIgtDoc, resetIds, settle } from './test-helpers.js';
import { segmentServer } from '../test/segmentServer.js';
import { isPendingId } from '@ui/domain/pendingIds.js';

const textless = () => {
  const raw = buildRawDoc({ body: '', words: [], morphemes: [], sentences: [] });
  delete raw.textLayers[0].text;
  return raw;
};

const open = () => {
  const server = segmentServer(textless());
  const doc = makeIgtDoc({
    raw: structuredClone(server.stored),
    client: server.client,
    user: { id: 'a' },
  });
  doc.onError = (message) => {
    throw new Error(message);
  };
  return { doc, server };
};

const idle = async (doc) => {
  while (doc.isSaving) await settle();
};

beforeEach(() => resetIds());

describe('a document with no text', () => {
  it('takes a segment, the text made with it in one batch', async () => {
    const { doc, server } = open();
    const made = doc.createAlignment({ text: 'kai pele', timeBegin: 0, timeEnd: 1 });
    // Shown before the server answers.
    expect(doc.body).toBe('kai pele');
    expect(doc.alignmentTokens).toHaveLength(1);
    expect(await made).toBe(true);
    await idle(doc);

    const [batch] = server.sent;
    expect(batch.ops.map((o) => o.kind)).toEqual([
      'texts.create',
      'tokens.create',
      'tokens.bulkCreate',
    ]);
    const [layerId, documentId, body, , , options] = batch.ops[0].args;
    expect([layerId, documentId, body]).toEqual(['tl-1', 'doc-1', 'kai pele']);
    // The segment and the sentence are made over the text the batch makes.
    expect(batch.ops[1].args[1]).toBe(options.id);
    expect(batch.ops[2].args[0][0].text).toBe(options.id);
    expect(server.body).toBe('kai pele');
    expect(server.segments().map((s) => [s.begin, s.end])).toEqual([[0, 8]]);
    // The words the server made with the text, and its digest, are read.
    expect(doc.layerInfo.primaryTokenLayer.tokens.map((t) => [t.begin, t.end])).toEqual([
      [0, 3],
      [4, 8],
    ]);
    expect(doc.layerInfo.primaryTextLayer.text.digest).toBe(server.digest);
  });

  it('takes a second segment made while the first is on its way over the same text', async () => {
    const { doc, server } = open();
    const first = doc.createAlignment({ text: 'kai', timeBegin: 0, timeEnd: 1 });
    const second = doc.createAlignment({ text: 'pele', timeBegin: 1, timeEnd: 2 });
    expect(doc.body).toBe('kai pele');
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    await idle(doc);
    const creates = server.sent
      .flatMap((r) => (r.kind === 'batch' ? r.ops : [r]))
      .filter((w) => w.kind === 'texts.create');
    expect(creates).toHaveLength(1);
    expect(server.body).toBe('kai pele');
    expect(server.segments().map((s) => [s.begin, s.end])).toEqual([
      [0, 3],
      [4, 8],
    ]);
    expect(doc.body).toBe('kai pele');
    expect(isPendingId(doc.layerInfo.primaryTextLayer.text.id)).toBe(false);
  });

  // `bb fidelity` (the kitchen sink): the text the Baseline save made was
  // still taken for one to make, and aligning its sentence sent the create
  // again, refused 409 id-taken.
  it('aligns its baseline once the Baseline save made the text, with no second create', async () => {
    const { doc, server } = open();
    expect(await doc.saveBaselineText('kai pele', '')).toBe(true);
    await idle(doc);
    expect(await doc.alignBaseline({ begin: 0, end: 8, timeBegin: 0, timeEnd: 1 })).toBe(true);
    await idle(doc);
    const creates = server.sent
      .flatMap((r) => (r.kind === 'batch' ? r.ops : [r]))
      .filter((w) => w.kind === 'texts.create');
    expect(creates).toHaveLength(1);
    expect(server.segments().map((s) => [s.begin, s.end])).toEqual([[0, 8]]);
  });

  it('takes its first Baseline save, the text and its sentences in one batch', async () => {
    const { doc, server } = open();
    expect(await doc.saveBaselineText('kai pele', '', { tokenize: true })).toBe(true);
    await idle(doc);
    const [batch] = server.sent;
    expect(batch.ops.map((o) => o.kind)).toEqual(['texts.create', 'tokens.bulkCreate']);
    expect(server.body).toBe('kai pele');
    expect(doc.body).toBe('kai pele');
  });

  // The Baseline save shows the text it makes before it sends, so a segment
  // made while that save is on its way plans an edit of it, and no second
  // create.
  it('takes a segment made while its first Baseline save is on its way', async () => {
    const { doc, server } = open();
    const saved = doc.saveBaselineText('kai pele', '');
    expect(doc.body).toBe('kai pele');
    expect(doc.layerInfo.sentenceTokenLayer.tokens.map((t) => [t.begin, t.end])).toEqual([[0, 8]]);
    const segment = doc.createAlignment({ text: 'mau', timeBegin: 0, timeEnd: 1 });
    expect(await saved).toBe(true);
    expect(await segment).toBe(true);
    await idle(doc);
    const creates = server.sent
      .flatMap((r) => (r.kind === 'batch' ? r.ops : [r]))
      .filter((w) => w.kind === 'texts.create');
    expect(creates).toHaveLength(1);
    expect(server.segments()).toHaveLength(1);
    expect(server.body).toContain('kai pele');
    expect(server.body).toContain('mau');
    expect(doc.body).toBe(server.body);
  });

  // A segment that makes the text, stored with its answer lost, and the
  // client's own resend refused before the key is looked up: it is stored,
  // so it is no failure, as a segment over a text already there.
  it('takes a segment that made the text when its resend is refused', async () => {
    const server = segmentServer(textless());
    const doc = makeIgtDoc({
      raw: structuredClone(server.stored),
      client: server.client,
      user: { id: 'a' },
    });
    const errors = [];
    doc.onError = (message) => errors.push(String(message));
    server.storeThenRefuse(500);
    const first = doc.createAlignment({ text: 'kai', timeBegin: 0, timeEnd: 1 });
    const second = doc.createAlignment({ text: 'pele', timeBegin: 1, timeEnd: 2 });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    await idle(doc);
    expect(errors).toEqual([]);
    expect(server.body).toBe('kai pele');
    expect(server.segments()).toHaveLength(2);
    expect(doc.alignmentTokens).toHaveLength(2);
  });
});
