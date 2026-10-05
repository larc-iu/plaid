// A segment's times are chosen by listening to the recording the page plays.
// When someone replaces or deletes that recording meanwhile, the write that
// carries the times is refused after the 409, never stored at those times on
// the new recording (L2-IGT-MULTI-1). The Media tab's notice of the change
// says what went unsaved (`takeRecordingRefusal`), so the refusal makes no
// toast or banner of its own.
import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, resetIds } from './test-helpers.js';
import { segmentServer } from '../test/segmentServer.js';

const R1 = '/api/v1/documents/d/media?v=1-6';
const R2 = '/api/v1/documents/d/media?v=2-11';

const seg = (id, begin, end, timeBegin, timeEnd) => ({
  id,
  text: 'text-1',
  begin,
  end,
  metadata: { timeBegin, timeEnd },
});

const serverWith = (segments, body = 'one two three') => {
  const server = segmentServer(
    buildRawDoc({ body, words: [], morphemes: [], alignmentTokens: segments }),
  );
  server.stored.mediaUrl = R1;
  return server;
};

const open = (server) => {
  const doc = new IgtDocument({
    raw: structuredClone(server.stored),
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client: server.client,
    projectId: 'proj-1',
    user: { id: 'a' },
  });
  doc._writes._retryDelay = () => 2;
  // Strict mode, as the Media tab has it: a write refused 409 with nothing
  // stored is asked again on the document read (DocumentModel `_afterConflict`).
  server.client.strictModeDocumentId = doc.id;
  server.client.documentVersions = { [doc.id]: 1 };
  doc.errors = [];
  doc.onError = (msg, err, label) => doc.errors.push([label, err?.message ?? msg]);
  return doc;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const idle = async (doc) => {
  while (doc.isSaving) await settle();
};

beforeEach(() => resetIds());

describe('a segment write against a recording replaced meanwhile', () => {
  it('a new segment is refused, not stored on the new recording', async () => {
    const server = serverWith([seg('a-1', 0, 3, 0, 1)]);
    const doc = open(server);
    server.otherReplacesMedia(R2);

    const ok = await doc.createAlignment({ text: 'moro pani', timeBegin: 1.06, timeEnd: 1.96 });
    await idle(doc);
    expect(ok).toBe(false);
    expect(server.segments().map((t) => t.id)).toEqual(['a-1']);
    expect(server.body).toBe('one two three');
    expect(server.answers()).toEqual([409]);
    // On screen: the new recording, without the segment, and no message of
    // the write's own. The notice of the change says the segment went.
    expect(doc.document.mediaUrl).toBe(R2);
    expect(doc.alignmentTokens.map((t) => t.id)).toEqual(['a-1']);
    expect(doc.errors).toEqual([]);
    expect(doc.error).toBe('');
    expect(doc.takeRecordingRefusal(R2)).toBe('Segment');
    expect(doc.takeRecordingRefusal(R2)).toBeNull();
  });

  it('a segment over baseline text is refused the same way', async () => {
    const server = serverWith([seg('a-1', 0, 3, 0, 1)]);
    const doc = open(server);
    server.otherReplacesMedia(R2);

    await doc.alignBaseline({ begin: 4, end: 7, timeBegin: 1, timeEnd: 2 });
    await idle(doc);
    expect(server.segments().map((t) => t.id)).toEqual(['a-1']);
    expect(server.answers()).toEqual([409]);
    expect(doc.alignmentTokens.map((t) => t.id)).toEqual(['a-1']);
    expect(doc.errors).toEqual([]);
    expect(doc.takeRecordingRefusal(R2)).toBe('Segment');
  });

  it('new times for a segment are refused, and the stored ones kept', async () => {
    const server = serverWith([seg('a-1', 0, 3, 0, 1)]);
    const doc = open(server);
    server.otherReplacesMedia(R2);

    await doc.updateAlignmentBounds('a-1', { timeBegin: 0.5, timeEnd: 1.5 });
    await idle(doc);
    expect(server.segments()[0].metadata).toEqual({ timeBegin: 0, timeEnd: 1 });
    expect(doc.alignmentTokens[0].metadata).toEqual({ timeBegin: 0, timeEnd: 1 });
    expect(doc.takeRecordingRefusal(R2)).toBe('Segment times');
  });

  it('a row edit that sets times is refused, and one that does not is made again', async () => {
    const server = serverWith([seg('a-1', 0, 3, 0, 1), seg('a-2', 4, 7, 1, 2)]);
    const doc = open(server);
    server.otherReplacesMedia(R2);

    await doc.cellWrite(() =>
      doc.editAlignment('a-1', { text: 'uno', timeBegin: 0.2, timeEnd: 1 }),
    );
    await idle(doc);
    expect(server.body).toBe('one two three');
    expect(doc.takeRecordingRefusal(R2)).toBe('Segment edit');

    // Text alone was typed against the words, not the recording.
    await doc.cellWrite(() => doc.editAlignment('a-2', { text: 'dos', timeBegin: 1, timeEnd: 2 }));
    await idle(doc);
    expect(server.body).toBe('one dos three');
  });

  it('a recording deleted meanwhile refuses a new segment', async () => {
    const server = serverWith([seg('a-1', 0, 3, 0, 1)]);
    const doc = open(server);
    server.otherReplacesMedia(null);

    await doc.alignBaseline({ begin: 4, end: 7, timeBegin: 1, timeEnd: 2 });
    await idle(doc);
    expect(server.segments().map((t) => t.id)).toEqual(['a-1']);
    expect(doc.takeRecordingRefusal(null)).toBe('Segment');
  });

  it('a segment waiting behind a refused write is refused unsent', async () => {
    const server = serverWith([seg('a-1', 0, 3, 0, 1)]);
    const doc = open(server);
    server.otherReplacesMedia(R2);

    doc.updateAlignmentBounds('a-1', { timeBegin: 0.5, timeEnd: 1.5 });
    doc.alignBaseline({ begin: 4, end: 7, timeBegin: 1.6, timeEnd: 2 });
    await idle(doc);
    expect(server.segments().map((t) => t.id)).toEqual(['a-1']);
    expect(server.segments()[0].metadata).toEqual({ timeBegin: 0, timeEnd: 1 });
    expect(server.answers()).toEqual([409]);
    expect(doc.errors).toEqual([]);
  });

  it('a page already showing the new recording toasts the refusal itself', async () => {
    const server = serverWith([seg('a-1', 0, 3, 0, 1)]);
    const doc = open(server);
    const write = doc.alignBaseline({ begin: 4, end: 7, timeBegin: 1, timeEnd: 2 });
    // The page learned of the new recording before this write was refused.
    doc._raw = { ...doc._raw, mediaUrl: R2 };
    server.otherReplacesMedia(R2);
    await write;
    await idle(doc);
    expect(server.segments().map((t) => t.id)).toEqual(['a-1']);
    expect(doc.errors).toEqual([
      ['Failed to align baseline text', 'Replaced elsewhere. Segment not saved.'],
    ]);
    expect(doc.takeRecordingRefusal(R2)).toBeNull();
  });

  it('a recording left as it was changes nothing', async () => {
    const server = serverWith([seg('a-1', 0, 3, 0, 1)]);
    const doc = open(server);
    // The document moved on, with the recording it holds as it was.
    server.otherReplacesMedia(R1);

    await doc.alignBaseline({ begin: 8, end: 13, timeBegin: 2, timeEnd: 3 });
    await idle(doc);
    expect(server.segments()).toHaveLength(2);
    expect(server.answers()).toEqual([409, 200]);
  });
});
