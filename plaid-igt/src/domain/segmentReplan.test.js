// Which segment a refused transcript write is about, on the document as read
// after the refusal, and when it is made again (the second review of the
// edit-operation path: R6-bis, T1, R5-bis, U1). Against a server that keeps
// what it stores (test/segmentServer.js).
import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, resetIds } from './test-helpers.js';
import { segmentServer } from '../test/segmentServer.js';

const seg = (id, begin, end, timeBegin, timeEnd, speaker) => ({
  id,
  text: 'text-1',
  begin,
  end,
  metadata: { timeBegin, timeEnd, ...(speaker ? { speaker } : {}) },
});

const serverWith = (segments, body = 'one two three') =>
  segmentServer(buildRawDoc({ body, words: [], morphemes: [], alignmentTokens: segments }));

// Three segments over "one two three", a second each, the second Ana's.
const plain = () =>
  serverWith([seg('a-1', 0, 3, 0, 1), seg('a-2', 4, 7, 1, 2, 'Ana'), seg('a-3', 8, 13, 2, 3)]);

// Speakers A and B over one time span.
const twoSpeakers = () =>
  serverWith([seg('a-1', 0, 3, 0, 1), seg('a-2', 4, 7, 1, 2, 'A'), seg('a-3', 8, 13, 1, 2, 'B')]);

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
  doc.onError = () => {};
  return doc;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const idle = async (doc) => {
  while (doc.isSaving) await settle();
};
const edit = (doc, id, fields) =>
  doc.cellWrite(() => doc.editAlignment(id, { timeBegin: 1, timeEnd: 2, ...fields }));
const alignLayer = (server) =>
  server.stored.textLayers[0].tokenLayers.find((l) => l.id === 'alignL');

beforeEach(() => resetIds());

describe('a refused row edit is about its own segment only', () => {
  it('another speaker’s segment made again over the same times is not taken for it (R6-bis)', async () => {
    const server = twoSpeakers();
    const doc = open(server);
    // Elsewhere: B's text changed (its token made again), A's segment
    // deleted with its text.
    const theirs = server.otherEdits('a-3', 'tres');
    alignLayer(server).tokens = alignLayer(server).tokens.filter((t) => t.id !== 'a-2');
    server.otherSaves([{ type: 'delete', index: 3, value: 4 }]);
    expect(server.body).toBe('one tres');

    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: 'A' });
    await idle(doc);
    expect(outcome.landed).toBe(false);
    expect(outcome.error.conflict).toEqual({ stored: null, mine: 'dos' });
    // B's row keeps its own segment, so no note of A's lands on it.
    expect(doc.segmentOrigin(theirs)).toBe(theirs);
    expect(server.body).toBe('one tres');
    expect(server.answers()).toEqual([409]);
  });

  it('with A’s segment deleted and its text kept, B’s is not taken for it either (R6-bis)', async () => {
    const server = twoSpeakers();
    const doc = open(server);
    const theirs = server.otherEdits('a-3', 'tres');
    alignLayer(server).tokens = alignLayer(server).tokens.filter((t) => t.id !== 'a-2');
    server.otherRelabels('a-1', { speaker: 'X' });

    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: 'A' });
    await idle(doc);
    expect(outcome.error.conflict).toEqual({ stored: null, mine: 'dos' });
    expect(doc.segmentOrigin(theirs)).toBe(theirs);
    expect(server.body).toBe('one two tres');
  });

  it('two segments of one speaker over one time span, one made again: neither is guessed', async () => {
    const server = serverWith([
      seg('a-1', 0, 3, 0, 1),
      seg('a-2', 4, 7, 1, 2, 'A'),
      seg('a-3', 8, 13, 1, 2, 'A'),
    ]);
    const doc = open(server);
    const theirs = server.otherEdits('a-3', 'tres');
    alignLayer(server).tokens = alignLayer(server).tokens.filter((t) => t.id !== 'a-2');
    server.otherRelabels('a-1', { speaker: 'X' });

    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: 'A' });
    await idle(doc);
    expect(outcome.error.conflict).toEqual({ stored: null, mine: 'dos' });
    expect(doc.segmentOrigin(theirs)).toBe(theirs);
  });

  it('its text and its end changed elsewhere: refused with both texts, on its own row (T1)', async () => {
    const server = plain();
    const doc = open(server);
    const theirs = server.otherEdits('a-3', 'tres!');
    server.otherRelabels(theirs, { timeEnd: 2.7 }, 'c');

    const outcome = await doc.cellWrite(() =>
      doc.editAlignment('a-3', { text: 'MINE3', timeBegin: 2, timeEnd: 3 }),
    );
    await idle(doc);
    expect(outcome.error.conflict).toEqual({ stored: 'tres!', mine: 'MINE3' });
    expect(doc.segmentOrigin(theirs)).toBe('a-3');
    expect(server.body).toBe('one two tres!');
  });

  it('its text changed to the same and its end moved: found landed (T1)', async () => {
    const server = plain();
    const doc = open(server);
    const theirs = server.otherEdits('a-3', 'tres');
    server.otherRelabels(theirs, { timeEnd: 2.7 });
    const outcome = await doc.cellWrite(() =>
      doc.editAlignment('a-3', { text: 'tres', timeBegin: 2, timeEnd: 3 }),
    );
    await idle(doc);
    expect(outcome.landed).toBe(true);
    expect(server.body).toBe('one two tres');
  });
});

describe('made again after a refusal, a field both sides changed', () => {
  it('a speaker set here and changed to another elsewhere is refused (R5-bis)', async () => {
    const server = plain();
    const doc = open(server);
    server.otherRelabels('a-2', { speaker: 'Maria' });
    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: 'Pedro' });
    await idle(doc);
    expect(outcome.landed).toBe(false);
    expect(outcome.error.conflict).toEqual({ stored: 'two', mine: 'dos' });
    expect(server.body).toBe('one two three');
    expect(server.segments()[1].metadata.speaker).toBe('Maria');
    expect(server.answers()).toEqual([409]);
  });

  it('an end set here and moved to another elsewhere is refused (R5-bis)', async () => {
    const server = plain();
    const doc = open(server);
    server.otherRelabels('a-2', { timeEnd: 1.8 });
    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: 'Ana', timeEnd: 2.5 });
    await idle(doc);
    expect(outcome.error.conflict).toEqual({ stored: 'two', mine: 'dos' });
    expect(server.segments()[1].metadata.timeEnd).toBe(1.8);
  });

  it('both set to the same value is no conflict', async () => {
    const server = plain();
    const doc = open(server);
    server.otherRelabels('a-2', { speaker: 'Pedro' });
    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: 'Pedro' });
    await idle(doc);
    expect(outcome.landed).toBe(true);
    expect(server.body).toBe('one dos three');
    expect(server.segments()[1].metadata.speaker).toBe('Pedro');
  });
});

describe('a write whose lost answer is replayed after someone else wrote (U1)', () => {
  for (const kind of ['create', 'edit', 'deleteText']) {
    it(`${kind}: the screen shows the text stored, not the replayed one`, async () => {
      const server = plain();
      const doc = open(server);
      server.loseNext(1);
      const batched = server.client.batched;
      let n = 0;
      server.client.batched = async (fn) => {
        n += 1;
        try {
          return await batched(fn);
        } finally {
          if (n === 1) server.otherEdits('a-1', 'uno');
        }
      };
      const ok =
        kind === 'create'
          ? await doc.createAlignment({ text: 'four', timeBegin: 3, timeEnd: 4 })
          : kind === 'edit'
            ? await doc.editAlignment('a-2', { text: 'dos', timeBegin: 1, timeEnd: 2 })
            : await doc.deleteAlignment('a-2', { deleteText: true });
      expect(ok).toBe(true);
      await idle(doc);
      expect(server.answers()).toEqual(['lost', 'replayed']);
      expect(server.body.startsWith('uno ')).toBe(true);
      expect(doc.body).toBe(server.body);
      expect(doc.layerInfo.primaryTextLayer.text.digest).toBe(server.digest);
    });
  }
});
