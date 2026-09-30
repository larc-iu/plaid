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
    const theirs = server.otherRemakes('a-3', 'tres');
    alignLayer(server).tokens = alignLayer(server).tokens.filter((t) => t.id !== 'a-2');
    server.otherSaves([{ type: 'delete', index: 3, value: 4 }]);
    expect(server.body).toBe('one tres');

    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: 'A' });
    await idle(doc);
    expect(outcome.landed).toBe(false);
    expect(outcome.error.conflict).toEqual({ stored: null, mine: 'dos' });
    // B's row keeps its own segment, so no note of A's lands on it.
    expect(doc.alignmentTokens.map((t) => t.id)).toContain(theirs);
    expect(server.body).toBe('one tres');
    expect(server.answers()).toEqual([409]);
  });

  it('with A’s segment deleted and its text kept, B’s is not taken for it either (R6-bis)', async () => {
    const server = twoSpeakers();
    const doc = open(server);
    const theirs = server.otherRemakes('a-3', 'tres');
    alignLayer(server).tokens = alignLayer(server).tokens.filter((t) => t.id !== 'a-2');
    server.otherRelabels('a-1', { speaker: 'X' });

    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: 'A' });
    await idle(doc);
    expect(outcome.error.conflict).toEqual({ stored: null, mine: 'dos' });
    expect(doc.alignmentTokens.map((t) => t.id)).toContain(theirs);
    expect(server.body).toBe('one two tres');
  });

  it('two segments of one speaker over one time span, one made again: neither is guessed', async () => {
    const server = serverWith([
      seg('a-1', 0, 3, 0, 1),
      seg('a-2', 4, 7, 1, 2, 'A'),
      seg('a-3', 8, 13, 1, 2, 'A'),
    ]);
    const doc = open(server);
    const theirs = server.otherRemakes('a-3', 'tres');
    alignLayer(server).tokens = alignLayer(server).tokens.filter((t) => t.id !== 'a-2');
    server.otherRelabels('a-1', { speaker: 'X' });

    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: 'A' });
    await idle(doc);
    expect(outcome.error.conflict).toEqual({ stored: null, mine: 'dos' });
    expect(doc.alignmentTokens.map((t) => t.id)).toContain(theirs);
  });

  it('its text and its end changed elsewhere: refused with both texts, on its own row (T1)', async () => {
    const server = plain();
    const doc = open(server);
    server.otherRetypes('a-3', 'tres!');
    server.otherRelabels('a-3', { timeEnd: 2.7 }, 'c');

    const outcome = await doc.cellWrite(() =>
      doc.editAlignment('a-3', { text: 'MINE3', timeBegin: 2, timeEnd: 3 }),
    );
    await idle(doc);
    expect(outcome.error.conflict).toEqual({ stored: 'tres!', mine: 'MINE3' });
    expect(doc.alignmentTokens.map((t) => t.id)).toContain('a-3');
    expect(server.body).toBe('one two tres!');
  });

  it('its text changed to the same and its end moved: found landed (T1)', async () => {
    const server = plain();
    const doc = open(server);
    server.otherRetypes('a-3', 'tres');
    server.otherRelabels('a-3', { timeEnd: 2.7 });
    const outcome = await doc.cellWrite(() =>
      doc.editAlignment('a-3', { text: 'tres', timeBegin: 2, timeEnd: 3 }),
    );
    await idle(doc);
    expect(outcome.landed).toBe(true);
    expect(server.body).toBe('one two tres');
  });
});

describe('a refused row edit whose segment is gone is never written onto another (B1)', () => {
  it('its segment made again elsewhere, same speaker and times: refused as its own row', async () => {
    const server = plain();
    const doc = open(server);
    const theirs = server.otherRemakes('a-2', 'deux');
    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: 'Ana' });
    await idle(doc);
    expect(outcome.landed).toBe(false);
    expect(outcome.error.conflict).toEqual({ stored: null, mine: 'dos' });
    expect(doc.alignmentTokens.map((t) => t.id)).toContain(theirs);
    expect(server.body).toBe('one deux three');
    expect(server.answers()).toEqual([409]);
  });

  it('deleted, and a new segment of its speaker made over part of its time: not taken for it', async () => {
    const server = twoSpeakers();
    alignLayer(server).tokens[2].metadata = { timeBegin: 2, timeEnd: 3, speaker: 'B' };
    const doc = open(server);
    alignLayer(server).tokens = alignLayer(server).tokens.filter((t) => t.id !== 'a-2');
    server.otherSaves([
      { type: 'delete', index: 4, value: 3 },
      { type: 'insert', index: 4, value: 'nuevo' },
    ]);
    const made = { timeBegin: 1.2, timeEnd: 1.8, speaker: 'A' };
    alignLayer(server).tokens.splice(1, 0, {
      id: 'b-new',
      text: 'text-1',
      begin: 4,
      end: 9,
      metadata: made,
    });

    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: 'A' });
    await idle(doc);
    expect(outcome.error.conflict).toEqual({ stored: null, mine: 'dos' });
    expect(doc.alignmentTokens.map((t) => t.id)).toContain('b-new');
    expect(server.body).toBe('one nuevo three');
    expect(server.answers()).toEqual([409]);
  });

  it('its token deleted, its text kept, and a new overlapping segment of its speaker at the end: not taken for it', async () => {
    const server = twoSpeakers();
    const doc = open(server);
    alignLayer(server).tokens = alignLayer(server).tokens.filter((t) => t.id !== 'a-2');
    server.otherSaves([{ type: 'insert', index: 13, value: ' later' }]);
    const made = { timeBegin: 1.9, timeEnd: 3, speaker: 'A' };
    alignLayer(server).tokens.push({
      id: 'b-new',
      text: 'text-1',
      begin: 14,
      end: 19,
      metadata: made,
    });

    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: 'A' });
    await idle(doc);
    expect(outcome.error.conflict).toEqual({ stored: null, mine: 'dos' });
    expect(server.body).toBe('one two three later');
    expect(server.segments().map((t) => t.id)).toEqual(['a-1', 'a-3', 'b-new']);
    expect(server.answers()).toEqual([409]);
  });

  it('a delete with its text of a segment made again elsewhere is refused', async () => {
    const server = plain();
    const doc = open(server);
    server.otherRemakes('a-2', 'two');
    expect(await doc.deleteAlignment('a-2', { deleteText: true })).toBe(false);
    await idle(doc);
    expect(server.body).toBe('one two three');
    expect(server.segments()).toHaveLength(3);
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

describe('made again after a refusal, a field read as the row reads it (R5-f)', () => {
  const stored = (metadata) =>
    serverWith([
      seg('a-1', 0, 3, 0, 1),
      { id: 'a-2', text: 'text-1', begin: 4, end: 7, metadata },
      seg('a-3', 8, 13, 2, 3),
    ]);

  it('a segment stored with no end, sent with its start as its end, takes the end set elsewhere', async () => {
    const server = stored({ timeBegin: 1 });
    const doc = open(server);
    server.otherRelabels('a-2', { timeEnd: 1.9 });
    server.otherEdits('a-1', 'uno');
    const outcome = await edit(doc, 'a-2', { text: 'dos', timeEnd: 1 });
    await idle(doc);
    expect(outcome.landed).toBe(true);
    expect(server.body).toBe('uno dos three');
    expect(server.segments()[1].metadata.timeEnd).toBe(1.9);
  });

  it('a segment stored with no start, sent with 0, takes the start set elsewhere', async () => {
    const server = stored({ timeEnd: 2 });
    const doc = open(server);
    server.otherRelabels('a-2', { timeBegin: 0.5 });
    server.otherEdits('a-1', 'uno');
    const outcome = await edit(doc, 'a-2', { text: 'dos', timeBegin: 0 });
    await idle(doc);
    expect(outcome.landed).toBe(true);
    expect(server.segments()[1].metadata.timeBegin).toBe(0.5);
  });

  it('a blank speaker is no speaker, and takes the one set elsewhere', async () => {
    const server = stored({ timeBegin: 1, timeEnd: 2, speaker: '' });
    const doc = open(server);
    server.otherRelabels('a-2', { speaker: 'Z' });
    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: '' });
    await idle(doc);
    expect(outcome.landed).toBe(true);
    expect(server.body).toBe('one dos three');
    expect(server.segments()[1].metadata.speaker).toBe('Z');
  });

  it('an end set here and elsewhere within a millisecond is no conflict', async () => {
    const server = plain();
    const doc = open(server);
    server.otherRelabels('a-2', { timeEnd: 2.7000000001 });
    const outcome = await edit(doc, 'a-2', { text: 'dos', speaker: 'Ana', timeEnd: 2.7 });
    await idle(doc);
    expect(outcome.landed).toBe(true);
    expect(server.body).toBe('one dos three');
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

describe('a write replayed inside the client’s own resend after someone else wrote (U1-client)', () => {
  for (const kind of ['create', 'edit', 'deleteText']) {
    it(`${kind}: the screen shows the text stored, not the replayed one`, async () => {
      const server = plain();
      const doc = open(server);
      server.replayNext(() => server.otherEdits('a-1', 'uno'));
      const ok =
        kind === 'create'
          ? await doc.createAlignment({ text: 'four', timeBegin: 3, timeEnd: 4 })
          : kind === 'edit'
            ? await doc.editAlignment('a-2', { text: 'dos', timeBegin: 1, timeEnd: 2 })
            : await doc.deleteAlignment('a-2', { deleteText: true });
      expect(ok).toBe(true);
      await idle(doc);
      expect(server.answers()).toEqual(['replayed in the client']);
      expect(server.body.startsWith('uno ')).toBe(true);
      expect(doc.body).toBe(server.body);
      expect(doc.layerInfo.primaryTextLayer.text.digest).toBe(server.digest);
    });
  }
});
