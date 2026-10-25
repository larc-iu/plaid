// A document with no text yet (made by ud's form, an import with no body, a
// New document, which makes none) gets its text from the first write that
// needs one, in that write's batch (A3-8): the Baseline save, and a segment
// made in the Media tab. Against a server that keeps what it stores
// (test/segmentServer.js).
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

  it('takes its first Baseline save, the text and its sentences in one batch', async () => {
    const { doc, server } = open();
    expect(await doc.saveBaselineText('kai pele', '', { tokenize: true })).toBe(true);
    await idle(doc);
    const [batch] = server.sent;
    expect(batch.ops.map((o) => o.kind)).toEqual(['texts.create', 'tokens.bulkCreate']);
    expect(server.body).toBe('kai pele');
    expect(doc.body).toBe('kai pele');
  });
});
