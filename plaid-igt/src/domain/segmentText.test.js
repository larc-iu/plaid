// A segment's text write goes with the digest of the body it was planned on,
// and a refusal because the body changed is decided by the segment alone.
// Changed elsewhere, the write is made again where the segment is now and
// sent once more. Changed in the segment itself, it is refused with the text
// stored and the text typed, and nothing more is sent. Against a server that
// keeps what it stores (test/segmentServer.js).
import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, resetIds } from './test-helpers.js';
import { digestOf, segmentServer } from '../test/segmentServer.js';

const seg = (id, begin, end, timeBegin, timeEnd) => ({
  id,
  text: 'text-1',
  begin,
  end,
  metadata: { timeBegin, timeEnd },
});

// Three segments over "one two three", a second each.
const RAW = () =>
  buildRawDoc({
    body: 'one two three',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 13 },
    ],
    morphemes: [],
    alignmentTokens: [seg('a-1', 0, 3, 0, 1), seg('a-2', 4, 7, 1, 2), seg('a-3', 8, 13, 2, 3)],
  });

const open = (server) =>
  new IgtDocument({
    raw: server.stored && structuredClone(server.stored),
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client: server.client,
    projectId: 'proj-1',
    user: { id: 'a' },
  });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const idle = async (doc) => {
  while (doc.isSaving) await settle();
};
const textWrites = (server) =>
  server.sent
    .flatMap((r) => (r.kind === 'batch' ? r.ops : [r]))
    .filter((w) => w.kind === 'texts.update');
const baseOf = (write) => write.args[3]?.base;
const textAt = (doc, times) => {
  const t = doc.alignmentTokens.find((s) => s.metadata.timeBegin === times);
  return [...doc.body].slice(t.begin, t.end).join('');
};

beforeEach(() => resetIds());

describe('a segment text write carries the digest of the body it was planned on', () => {
  it('an edit goes with the digest read, and the next one with the digest the first was answered with', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    const read = server.digest;
    expect(await doc.editAlignment('a-2', { text: 'too', timeBegin: 1, timeEnd: 2 })).toBe(true);
    // Made while nothing is on its way, and while the first one is.
    const second = doc.alignmentTokens.find((t) => t.metadata.timeBegin === 2).id;
    const first = doc.editAlignment(second, { text: 'three!', timeBegin: 2, timeEnd: 3 });
    const third = doc.createAlignment({ text: 'four', timeBegin: 3, timeEnd: 4 });
    expect(await first).toBe(true);
    expect(await third).toBe(true);
    await idle(doc);
    const writes = textWrites(server);
    expect(writes).toHaveLength(3);
    expect(baseOf(writes[0])).toBe(read);
    expect(baseOf(writes[1])).toBe(digestOf('one too three'));
    expect(baseOf(writes[2])).toBe(digestOf('one too three!'));
    expect(server.body).toBe('one too three! four');
    expect(doc.body).toBe(server.body);
    // The copy on screen holds the digest of the body it shows.
    expect(doc.layerInfo.primaryTextLayer.text.digest).toBe(server.digest);
  });

  it('a delete with its text goes with it too, in one batch with the segment', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    const read = server.digest;
    expect(await doc.deleteAlignment('a-2', { deleteText: true })).toBe(true);
    const [batch] = server.sent;
    expect(batch.ops.map((w) => w.kind)).toEqual(['tokens.delete', 'texts.update']);
    expect(baseOf(batch.ops[1])).toBe(read);
    expect(server.body).toBe('one three');
    expect(server.segments().map((t) => t.id)).toEqual(['a-1', 'a-3']);
  });
});

describe('refused because the body changed', () => {
  it('an edit of a segment whose text was not touched is made again where it is now, and lands', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    server.otherEdits('a-1', 'uno'); // shifts the other two segments
    expect(await doc.editAlignment('a-2', { text: 'dos', timeBegin: 1, timeEnd: 2 })).toBe(true);
    await idle(doc);
    const writes = textWrites(server);
    expect(writes).toHaveLength(2);
    expect(baseOf(writes[1])).toBe(digestOf('uno two three'));
    // Replaced where the segment is on the server, not where it was read.
    expect(writes[1].args[1]).toEqual([
      { type: 'delete', index: 4, value: 3 },
      { type: 'insert', index: 4, value: 'dos' },
    ]);
    expect(server.body).toBe('uno dos three');
    expect(doc.body).toBe(server.body);
    expect(textAt(doc, 1)).toBe('dos');
  });

  it('an edit of a segment someone else changed is refused with both texts, and nothing more is sent', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    server.otherEdits('a-2', 'deux');
    const outcome = await doc.cellWrite(() =>
      doc.editAlignment('a-2', { text: 'dos', timeBegin: 1, timeEnd: 2 }),
    );
    await idle(doc);
    expect(outcome.landed).toBe(false);
    expect(outcome.status).toBe(409);
    expect(outcome.error.conflict).toEqual({ stored: 'deux', mine: 'dos' });
    expect(textWrites(server)).toHaveLength(1);
    expect(server.body).toBe('one deux three');
    expect(doc.body).toBe('one deux three');
    expect(textAt(doc, 1)).toBe('deux');
    // A conflict the screen shows itself: no second message.
    expect(doc.error).toBe('');
  });

  it('a refusal with the body as it was (the version moved) is sent again at once', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    server.refuseNext(409);
    expect(await doc.editAlignment('a-2', { text: 'dos', timeBegin: 1, timeEnd: 2 })).toBe(true);
    await idle(doc);
    expect(textWrites(server)).toHaveLength(2);
    expect(server.body).toBe('one dos three');
  });

  it('a new segment is put where it goes in the body as stored', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    server.otherEdits('a-3', 'tres');
    expect(await doc.createAlignment({ text: 'four', timeBegin: 3, timeEnd: 4 })).toBe(true);
    await idle(doc);
    expect(server.body).toBe('one two tres four');
    const made = server.segments().find((t) => t.metadata.timeBegin === 3);
    expect([...server.body].slice(made.begin, made.end).join('')).toBe('four');
    expect(doc.body).toBe(server.body);
  });

  it('a delete with its text over a segment someone else changed is refused, and nothing is deleted', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    const theirs = server.otherEdits('a-2', 'deux');
    const errors = [];
    doc.onError = (message, err, title) => errors.push({ err, title });
    expect(await doc.deleteAlignment('a-2', { deleteText: true })).toBe(false);
    await idle(doc);
    expect(textWrites(server)).toHaveLength(1);
    expect(server.body).toBe('one deux three');
    expect(server.segments().map((t) => t.id)).toContain(theirs);
    expect(doc.body).toBe('one deux three');
    expect(textAt(doc, 1)).toBe('deux');
    expect(errors).toHaveLength(1);
    expect(errors[0].title).toBe('Failed to delete segment');
    expect(errors[0].err.status).toBe(409);
  });

  it('a delete with its text of a segment that was not touched goes again and lands', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    server.otherEdits('a-1', 'uno');
    expect(await doc.deleteAlignment('a-2', { deleteText: true })).toBe(true);
    await idle(doc);
    expect(server.body).toBe('uno three');
    expect(doc.body).toBe(server.body);
  });
});

describe('made again after a refusal', () => {
  it('keeps the speaker and the times someone else set on the segment meanwhile', async () => {
    const raw = RAW();
    raw.textLayers[0].tokenLayers.find((l) => l.id === 'alignL').tokens[1].metadata.speaker = 'Ana';
    const server = segmentServer(raw);
    const doc = open(server);
    // Another user relabels segment 2 and moves its end: the body is as it
    // was, the document's version is not.
    server.otherRelabels('a-2', { speaker: 'Maria', timeEnd: 1.8 });
    const edit = { text: 'dos', timeBegin: 1, timeEnd: 2, speaker: 'Ana' };
    expect(await doc.editAlignment('a-2', edit)).toBe(true);
    await idle(doc);
    const now = server.segments().find((t) => t.metadata.timeBegin === 1);
    expect(now.metadata).toMatchObject({ speaker: 'Maria', timeEnd: 1.8 });
    expect(server.body).toBe('one dos three');
  });

  it('writes a speaker this edit set, over the one stored', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    server.otherRelabels('a-2', { speaker: 'Maria', timeEnd: 1.8 });
    const edit = { text: 'dos', timeBegin: 1, timeEnd: 2, speaker: 'Ana' };
    expect(await doc.editAlignment('a-2', edit)).toBe(true);
    await idle(doc);
    const now = server.segments().find((t) => t.metadata.timeBegin === 1);
    expect(now.metadata).toMatchObject({ speaker: 'Ana', timeEnd: 1.8 });
  });

  for (const kind of ['a new segment', 'an edit']) {
    it(`${kind} whose answer is lost is sent again as it was, and answered from what it stored`, async () => {
      const server = segmentServer(RAW());
      const doc = open(server);
      doc._writes._retryDelay = () => 5;
      const errors = [];
      doc.onError = (message, err) => errors.push(err?.message ?? message);
      server.otherEdits('a-1', 'uno!'); // refused once, then made again
      server.loseNext(1);
      const ok =
        kind === 'an edit'
          ? await doc.editAlignment('a-2', { text: 'dos', timeBegin: 1, timeEnd: 2 })
          : await doc.createAlignment({ text: 'four', timeBegin: 3, timeEnd: 4 });
      expect(ok).toBe(true);
      await idle(doc);
      expect(server.answers()).toEqual([409, 'lost', 'replayed']);
      expect(server.sent[2].key).toBe(server.sent[1].key);
      expect(server.body).toBe(kind === 'an edit' ? 'uno! dos three' : 'uno! two three four');
      expect(server.segments()).toHaveLength(kind === 'an edit' ? 3 : 4);
      expect(errors).toEqual([]);
      expect(doc.body).toBe(server.body);
    });
  }

  it('a second edit of the same row queued behind it is not taken for someone else’s', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    const errors = [];
    doc.onError = (message, err) => errors.push(err?.message ?? message);
    server.otherEdits('a-1', 'uno!');
    const first = doc.editAlignment('a-2', { text: 'dos', timeBegin: 1, timeEnd: 2 });
    const pending = doc.alignmentTokens.find((t) => t.metadata.timeBegin === 1).id;
    const second = doc.editAlignment(pending, { text: 'dos!', timeBegin: 1, timeEnd: 2 });
    expect([await first, await second]).toEqual([true, true]);
    await idle(doc);
    expect(server.body).toBe('uno! dos! three');
    expect(errors).toEqual([]);
  });

  it('two speakers over one time span: a change to one is not the other', async () => {
    const speaking = (id, begin, end, speaker) => ({
      id,
      text: 'text-1',
      begin,
      end,
      metadata: { timeBegin: 1, timeEnd: 2, speaker },
    });
    const server = segmentServer(
      buildRawDoc({
        body: 'one two three',
        words: [],
        morphemes: [],
        alignmentTokens: [
          seg('a-1', 0, 3, 0, 1),
          speaking('a-2', 4, 7, 'A'),
          speaking('a-3', 8, 13, 'B'),
        ],
      }),
    );
    const doc = open(server);
    const theirs = server.otherEdits('a-2', 'deux');
    const outcome = await doc.cellWrite(() =>
      doc.editAlignment('a-2', { text: 'dos', timeBegin: 1, timeEnd: 2, speaker: 'A' }),
    );
    await idle(doc);
    expect(outcome.error.conflict).toEqual({ stored: 'deux', mine: 'dos' });
    // The row the conflict belongs to is the segment made again elsewhere.
    expect(doc.segmentOrigin(theirs)).toBe('a-2');
    expect(doc.segmentOrigin('a-3')).toBe('a-3');
  });

  it('astral text: a segment made again at its new place, then deleted with its text', async () => {
    const server = segmentServer(
      buildRawDoc({
        body: '𐌰𐌱 😀x three',
        words: [],
        morphemes: [],
        alignmentTokens: [seg('a-1', 0, 2, 0, 1), seg('a-2', 3, 5, 1, 2), seg('a-3', 6, 11, 2, 3)],
      }),
    );
    const doc = open(server);
    server.otherEdits('a-1', '𐍈');
    expect(await doc.editAlignment('a-2', { text: '😁y', timeBegin: 1, timeEnd: 2 })).toBe(true);
    await idle(doc);
    expect(server.body).toBe('𐍈 😁y three');
    const third = doc.alignmentTokens.find((t) => t.metadata.timeBegin === 2).id;
    expect(await doc.deleteAlignment(third, { deleteText: true })).toBe(true);
    await idle(doc);
    expect(server.body).toBe('𐍈 😁y');
    expect(doc.body).toBe(server.body);
  });
});
