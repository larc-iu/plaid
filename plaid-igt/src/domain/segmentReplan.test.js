// Which segment a refused transcript write is about, on the document as read
// after the refusal, and when it is made again (the second review of the
// edit-operation path: R6-bis, T1, R5-bis, U1). Against a server that keeps
// what it stores (test/segmentServer.js).
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRawDoc, resetIds, makeIgtDoc, settle } from './test-helpers.js';
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
  const doc = makeIgtDoc({
    raw: structuredClone(server.stored),
    client: server.client,
    user: { id: 'a' },
  });
  doc._writes._retryDelay = () => 2;
  doc.onError = () => {};
  return doc;
};
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

// H2-1-2: a row edit or a trash with its text, from a page opened before
// another person glossed the words it deletes. Refused, so the row asks
// again on the document read, rather than resent with the loss unasked.
describe('a row write that deletes more than its page counted', () => {
  const glossed = () => {
    const raw = buildRawDoc({
      body: 'uno dos tres',
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 7 },
        { id: 'w-3', begin: 8, end: 12 },
      ],
      alignmentTokens: [seg('a-1', 0, 3, 0, 1), seg('a-2', 4, 7, 1, 2), seg('a-3', 8, 12, 2, 3)],
    });
    return segmentServer(raw);
  };
  const spans = (server) =>
    server.stored.textLayers[0].tokenLayers.flatMap((l) =>
      (l.spanLayers || []).flatMap((sl) => sl.spans.map((x) => x.value)),
    );

  it('a retype of a word glossed meanwhile is refused, and asks on the document read', async () => {
    const server = glossed();
    const doc = open(server);
    expect(doc.segmentEditLoss('a-2', { text: 'xyz' }).loss.annotations).toBe(0);
    server.otherGlosses('m-2', 'two');
    server.otherGlosses('w-2', 'two.w');
    const outcome = await edit(doc, 'a-2', { text: 'xyz' });
    await idle(doc);
    expect(outcome.landed).toBe(false);
    expect(outcome.error.conflict).toEqual({ stored: 'dos', mine: 'xyz' });
    expect(server.body).toBe('uno dos tres');
    expect(spans(server)).toEqual(['two.w', 'two']);
    // The page now counts what the row's question names.
    expect(doc.segmentEditLoss('a-2', { text: 'xyz' }).loss.annotations).toBe(2);
    // Asked and answered on that count, it is saved.
    const again = await edit(doc, 'a-2', { text: 'xyz' });
    await idle(doc);
    expect(again.landed).toBe(true);
    expect(server.body).toBe('uno xyz tres');
  });

  it('a retype is still made again when what was added meanwhile is elsewhere', async () => {
    const server = glossed();
    const doc = open(server);
    server.otherGlosses('m-1', 'one');
    const outcome = await edit(doc, 'a-2', { text: 'xyz' });
    await idle(doc);
    expect(outcome.landed).toBe(true);
    expect(server.body).toBe('uno xyz tres');
    expect(spans(server)).toEqual(['one']);
  });

  it('a trash with its text over words glossed meanwhile is refused', async () => {
    const server = glossed();
    const doc = open(server);
    server.otherGlosses('m-2', 'two');
    expect(await doc.deleteAlignment('a-2', { deleteText: true })).toBe(false);
    await idle(doc);
    expect(server.body).toBe('uno dos tres');
    expect(server.segments()).toHaveLength(3);
    expect(spans(server)).toEqual(['two']);
    expect(doc.segmentDeleteLoss('a-2').annotations).toBe(1);
  });
});

// H2-1-3: the document was deleted elsewhere while the Media tab was open. The
// row write is refused 403 (an id the core cannot place), and so is the read
// after it. What is said is the write's refusal, changed or removed, not the
// read's, which reads as a missing permission.
describe('a row write after the document was deleted elsewhere', () => {
  const gone = (method) =>
    Object.assign(new Error('HTTP 403 lacks sufficient privileges to read the project'), {
      status: 403,
      method,
      responseData: { error: 'lacks sufficient privileges to read the project', unresolved: true },
    });
  const deleted = (server) => {
    server.refuseNext(403, null, gone('POST'));
    server.client.documents.get = async () => {
      throw gone('GET');
    };
  };

  it('is refused as changed or removed elsewhere', async () => {
    const server = plain();
    const doc = open(server);
    const said = [];
    doc.onError = (message, err, title) => said.push([title, message, err]);
    deleted(server);
    const outcome = await edit(doc, 'a-2', { text: 'dos dos', speaker: 'Ana' });
    await idle(doc);
    expect(outcome.landed).toBe(false);
    // The write's refusal, which says changed or removed (isGone).
    expect(outcome.error.method).toBe('POST');
    expect(said.some(([, , err]) => err?.method === 'GET')).toBe(false);
    expect(said.map(([title]) => title)).toContain('Read-only');
  });

  it('a trash with its text is refused the same way', async () => {
    const server = plain();
    const doc = open(server);
    const said = [];
    doc.onError = (message, err, title) => said.push([title, message, err]);
    deleted(server);
    expect(await doc.deleteAlignment('a-2', { deleteText: true })).toBe(false);
    await idle(doc);
    expect(said.some(([, , err]) => err?.method === 'GET')).toBe(false);
    expect(said.some(([, , err]) => err?.method === 'POST')).toBe(true);
    expect(said.map(([title]) => title)).toContain('Read-only');
  });
});

// REV-G1-1: a row write planned before the page last read the document is
// counted again on what was read before it goes, against the loss the person
// was asked about (or none, when nothing was asked).
describe('a row write planned before the page read the document again', () => {
  const glossed = () =>
    segmentServer(
      buildRawDoc({
        body: 'uno dos tres',
        words: [
          { id: 'w-1', begin: 0, end: 3 },
          { id: 'w-2', begin: 4, end: 7 },
          { id: 'w-3', begin: 8, end: 12 },
        ],
        alignmentTokens: [seg('a-1', 0, 3, 0, 1), seg('a-2', 4, 7, 1, 2), seg('a-3', 8, 12, 2, 3)],
      }),
    );
  const spans = (server) =>
    server.stored.textLayers[0].tokenLayers.flatMap((l) =>
      (l.spanLayers || []).flatMap((sl) => sl.spans.map((x) => x.value)),
    );
  const none = { annotations: 0, links: 0, shortened: { annotations: 0, links: 0 } };
  const retypeDos = (doc, asked) =>
    doc.cellWrite(() => doc.editAlignment('a-2', { text: 'xyz', timeBegin: 1, timeEnd: 2, asked }));

  it('queued behind a row edit that met the 409 first', async () => {
    const server = glossed();
    const doc = open(server);
    server.otherGlosses('m-2', 'two');
    server.otherGlosses('w-2', 'two.w');
    const w1 = doc.cellWrite(() =>
      doc.editAlignment('a-1', { text: 'una', timeBegin: 0, timeEnd: 1 }),
    );
    const w2 = retypeDos(doc, none);
    const [o1, o2] = await Promise.all([w1, w2]);
    await idle(doc);
    expect(o1.landed).toBe(true);
    expect(o2.landed).toBe(false);
    expect(server.body).toBe('una dos tres');
    expect(spans(server)).toEqual(['two.w', 'two']);
  });

  it('queued behind a trash with its text', async () => {
    const server = glossed();
    const doc = open(server);
    server.otherGlosses('m-2', 'two');
    const w1 = doc.deleteAlignment('a-1', { deleteText: true });
    const w2 = retypeDos(doc, none);
    const [, o2] = await Promise.all([w1, w2]);
    await idle(doc);
    expect(o2.landed).toBe(false);
    expect(spans(server)).toContain('two');
  });

  it('queued behind a speaker change', async () => {
    const server = glossed();
    const doc = open(server);
    server.otherGlosses('m-2', 'two');
    const w1 = doc.updateAlignmentSpeaker('a-1', 'Ana');
    const w2 = retypeDos(doc, none);
    const [, o2] = await Promise.all([w1, w2]);
    await idle(doc);
    expect(o2.landed).toBe(false);
    expect(spans(server)).toContain('two');
  });

  it('asked about on the page before it was read again', async () => {
    const server = glossed();
    const doc = open(server);
    server.otherGlosses('m-2', 'two');
    // Read while the row's question was open: the page and its version are
    // fresh, the answer is not.
    await doc.reload();
    const o = await retypeDos(doc, none);
    await idle(doc);
    expect(o.landed).toBe(false);
    expect(spans(server)).toEqual(['two']);
    // Asked about what is there now, it is saved.
    const again = await retypeDos(doc, doc.segmentEditLoss('a-2', { text: 'xyz' }).loss);
    await idle(doc);
    expect(again.landed).toBe(true);
    expect(server.body).toBe('uno xyz tres');
  });

  it('a trash asked about before the page was read again', async () => {
    const server = glossed();
    const doc = open(server);
    server.otherGlosses('m-2', 'two');
    await doc.reload();
    expect(await doc.deleteAlignment('a-2', { deleteText: true, asked: none })).toBe(false);
    await idle(doc);
    expect(server.body).toBe('uno dos tres');
    expect(spans(server)).toEqual(['two']);
  });
});

// REV-G1-2: a loss that grew in one count is a loss that grew, though the
// sum of the counts did not (a gloss taken away and a link made meanwhile).
describe('a row write whose loss changed kind', () => {
  it('is refused when a link is to go where only an annotation was asked about', async () => {
    const server = plain();
    const doc = open(server);
    const real = doc.segmentEditLoss.bind(doc);
    // On the document read after the refusal: no annotation, one link.
    doc.segmentEditLoss = (id, edit, info) =>
      info
        ? {
            stretches: [],
            loss: { annotations: 0, links: 1, shortened: { annotations: 0, links: 0 } },
          }
        : real(id, edit);
    server.refuseNext(409);
    const asked = { annotations: 1, links: 0, shortened: { annotations: 0, links: 0 } };
    const o = await edit(doc, 'a-2', { text: 'xyz', speaker: 'Ana', asked });
    await idle(doc);
    expect(o.landed).toBe(false);
    expect(server.body).toBe('one two three');
  });
});
