// A transcript row's text is saved as the edits typed in it, at the caret,
// with the digest of the body they were made on (PATCH /texts/:id with
// `edits` and `base`), and the segment is set over the row's new text. So the
// segment keeps its id, and the words inside it keep their morphemes and
// glosses where the text rules keep them (M1). Another user's edit of the
// same row then comes back to this page as a conflict on that row (Luke's
// ruling Q1), not as a segment gone. Against a server that keeps what it
// stores (test/segmentServer.js).
import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, resetIds } from './test-helpers.js';
import { digestOf, segmentServer } from '../test/segmentServer.js';

const seg = (id, begin, end, timeBegin, timeEnd, extra = {}) => ({
  id,
  text: 'text-1',
  begin,
  end,
  metadata: { timeBegin, timeEnd, ...extra },
});

// Three segments over "one two three", a second each, one word and one
// morpheme per segment, and a gloss on each morpheme.
const RAW = () => {
  const raw = buildRawDoc({
    body: 'one two three',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 13 },
    ],
    alignmentTokens: [seg('a-1', 0, 3, 0, 1), seg('a-2', 4, 7, 1, 2), seg('a-3', 8, 13, 2, 3)],
  });
  const morphL = raw.textLayers[0].tokenLayers.find((l) => l.id === 'morphL');
  morphL.spanLayers[0].spans = ['m-1', 'm-2', 'm-3'].map((m, i) => ({
    id: `g-${i + 1}`,
    tokens: [m],
    value: `G${i + 1}`,
  }));
  return raw;
};

const open = (server, client = server.client, user = 'a') =>
  new IgtDocument({
    raw: structuredClone(server.stored),
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: { id: user },
  });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const idle = async (doc) => {
  while (doc.isSaving) await settle();
};
const layer = (raw, id) => raw.textLayers[0].tokenLayers.find((l) => l.id === id);
const textOf = (raw, id) => {
  const t = layer(raw, 'alignL').tokens.find((s) => s.id === id);
  return t ? [...raw.textLayers[0].text.body].slice(t.begin, t.end).join('') : null;
};
const glosses = (raw) =>
  layer(raw, 'morphL').spanLayers[0].spans.map((s) => {
    const m = layer(raw, 'morphL').tokens.find((t) => t.id === s.tokens[0]);
    return `${[...raw.textLayers[0].text.body].slice(m.begin, m.end).join('')}:${s.value}`;
  });
const textWrites = (server) =>
  server.sent
    .flatMap((r) => (r.kind === 'batch' ? r.ops : [r]))
    .filter((w) => w.kind.startsWith('texts.'));

beforeEach(() => resetIds());

describe('a row edit is saved as the edits typed, and the segment keeps its id (M1)', () => {
  it("a letter typed at a word's end keeps the word, its morpheme and its gloss", async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    const read = server.digest;
    const ok = await doc.editAlignment('a-2', {
      text: 'two!',
      timeBegin: 1,
      timeEnd: 2,
      edits: { over: 'two', gaps: [{ start: 3, end: 3, value: '!' }] },
    });
    expect(ok).toBe(true);
    await idle(doc);

    const [write] = textWrites(server);
    expect(write.kind).toBe('texts.edit');
    expect(write.args[1]).toEqual([{ type: 'insert', index: 7, value: '!' }]);
    expect(write.args[3].base).toBe(read);
    expect(server.body).toBe('one two! three');
    // The same segment, over the new text, and nothing made again.
    expect(server.segments().map((t) => t.id)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(textOf(server.stored, 'a-2')).toBe('two!');
    expect(layer(server.stored, 'wordL').tokens.map((t) => t.id)).toEqual(['w-1', 'w-2', 'w-3']);
    expect(glosses(server.stored)).toEqual(['one:G1', 'two!:G2', 'three:G3']);
    // The page shows what is stored.
    expect(doc.body).toBe(server.body);
    expect(textOf(doc._raw, 'a-2')).toBe('two!');
    expect(glosses(doc._raw)).toEqual(['one:G1', 'two!:G2', 'three:G3']);
  });

  it('text typed at the front of a row is inside its segment', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    await doc.editAlignment('a-2', {
      text: 'and two',
      timeBegin: 1,
      timeEnd: 2,
      edits: { over: 'two', gaps: [{ start: 0, end: 0, value: 'and ' }] },
    });
    await idle(doc);
    expect(server.body).toBe('one and two three');
    expect(textOf(server.stored, 'a-2')).toBe('and two');
    expect(textOf(server.stored, 'a-1')).toBe('one');
    expect(glosses(server.stored)).toEqual(['one:G1', 'two:G2', 'three:G3']);
    expect(textOf(doc._raw, 'a-2')).toBe('and two');
  });

  it('an edit made without its edits is read from the text, and trailing space is not saved', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    await doc.editAlignment('a-3', { text: 'three more', timeBegin: 2, timeEnd: 3 });
    await idle(doc);
    expect(textWrites(server)[0].args[1]).toEqual([{ type: 'insert', index: 13, value: ' more' }]);
    expect(textOf(server.stored, 'a-3')).toBe('three more');

    await doc.editAlignment('a-1', {
      text: 'one',
      timeBegin: 0,
      timeEnd: 1,
      edits: { over: 'one', gaps: [{ start: 3, end: 3, value: '  ' }] },
    });
    await idle(doc);
    // Nothing is left to save once the typed spaces are trimmed.
    expect(textWrites(server)).toHaveLength(1);
  });

  it('a speaker set in the same edit is written on the segment, and its times stay', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    await doc.editAlignment('a-2', {
      text: 'two!',
      timeBegin: 1,
      timeEnd: 2,
      speaker: 'Ana',
      edits: { over: 'two', gaps: [{ start: 3, end: 3, value: '!' }] },
    });
    await idle(doc);
    expect(server.segments()[1].id).toBe('a-2');
    expect(server.segments()[1].metadata).toMatchObject({
      timeBegin: 1,
      timeEnd: 2,
      speaker: 'Ana',
    });
  });

  it('a row that is the whole text, typed over with nothing kept, is one edit that keeps its segment and its word', async () => {
    const server = segmentServer(
      buildRawDoc({
        body: 'abc',
        words: [{ id: 'w-1', begin: 0, end: 3 }],
        alignmentTokens: [seg('a-1', 0, 3, 0, 1)],
      }),
    );
    const doc = open(server);
    await doc.editAlignment('a-1', { text: 'xyzw', timeBegin: 0, timeEnd: 1 });
    await idle(doc);
    expect(server.body).toBe('xyzw');
    expect(server.segments().map((t) => [t.id, t.begin, t.end])).toEqual([['a-1', 0, 4]]);
    expect(layer(server.stored, 'sentL').tokens.map((t) => [t.begin, t.end])).toEqual([[0, 4]]);
    expect(doc.body).toBe('xyzw');
    expect(textOf(doc._raw, 'a-1')).toBe('xyzw');
    // one text write, the stretch typed over as it was typed
    const edits = server.sent
      .flatMap((s) => (s.kind === 'batch' ? s.ops : [s]))
      .filter((w) => w.kind === 'texts.edit');
    expect(edits.map((w) => w.args[1])).toEqual([
      [{ type: 'replace', index: 0, length: 3, value: 'xyzw' }],
    ]);
    // the word typed over whole keeps its token, as in the Baseline
    expect(layer(server.stored, 'wordL').tokens.map((t) => [t.id, t.begin, t.end])).toEqual([
      ['w-1', 0, 4],
    ]);
  });
});

describe('rows written together (L2)', () => {
  // A Baseline delete of the space between two rows leaves their segments
  // touching. Text typed at the front of the second row then joins the first
  // row's last word, which the text rules give it, and the row's segment is
  // still set over its own text.
  const glued = () =>
    segmentServer(
      buildRawDoc({
        body: 'onetwo',
        words: [
          { id: 'w-1', begin: 0, end: 3 },
          { id: 'w-2', begin: 3, end: 6 },
        ],
        alignmentTokens: [seg('a-1', 0, 3, 0, 1), seg('a-2', 3, 6, 1, 2)],
      }),
    );

  it('text typed at the front of the second row is saved in it, and the first row keeps its text', async () => {
    const server = glued();
    const doc = open(server);
    const errors = [];
    doc.onError = (message) => errors.push(message);
    const ok = await doc.editAlignment('a-2', {
      text: 'xtwo',
      timeBegin: 1,
      timeEnd: 2,
      edits: { over: 'two', gaps: [{ start: 0, end: 0, value: 'x' }] },
    });
    await idle(doc);
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(server.body).toBe('onextwo');
    expect(textOf(server.stored, 'a-1')).toBe('one');
    expect(textOf(server.stored, 'a-2')).toBe('xtwo');
    // the page shows what is stored
    expect(textOf(doc._raw, 'a-1')).toBe('one');
    expect(textOf(doc._raw, 'a-2')).toBe('xtwo');
  });

  it('text typed at the end of the first row is saved in it, and the second row keeps its text', async () => {
    const server = glued();
    const doc = open(server);
    const ok = await doc.editAlignment('a-1', {
      text: 'one ',
      timeBegin: 0,
      timeEnd: 1,
      edits: { over: 'one', gaps: [{ start: 3, end: 3, value: ' ' }] },
    });
    await idle(doc);
    expect(ok).toBe(true);
    expect(textOf(server.stored, 'a-2')).toBe('two');
  });

  it('the second row typed over whole keeps its segment', async () => {
    const server = glued();
    const doc = open(server);
    const ok = await doc.editAlignment('a-2', { text: 'xyz', timeBegin: 1, timeEnd: 2 });
    await idle(doc);
    expect(ok).toBe(true);
    expect(server.segments().map((t) => [t.id, t.begin, t.end])).toEqual([
      ['a-1', 0, 3],
      ['a-2', 3, 6],
    ]);
  });
});

describe('a row edit whose resend inside the client is refused (G1-gap)', () => {
  for (const kind of ['an edit', 'a new segment']) {
    it(`${kind} stored by the first send is found stored, with no error and nothing sent again`, async () => {
      const server = segmentServer(RAW());
      const doc = open(server);
      const errors = [];
      doc.onError = (message, err, title) => errors.push(title);
      server.storeThenRefuse(500);
      const outcome = await doc.cellWrite(() =>
        kind === 'an edit'
          ? doc.editAlignment('a-2', {
              text: 'two!',
              timeBegin: 1,
              timeEnd: 2,
              edits: { over: 'two', gaps: [{ start: 3, end: 3, value: '!' }] },
            })
          : doc.createAlignment({ text: 'four', timeBegin: 3, timeEnd: 4 }),
      );
      await idle(doc);
      expect(outcome.landed).toBe(true);
      expect(errors).toEqual([]);
      expect(server.answers()).toEqual(['stored, then 500 in the client']);
      expect(server.body).toBe(kind === 'an edit' ? 'one two! three' : 'one two three four');
      expect(doc.body).toBe(server.body);
    });
  }

  it('an edit that was not stored is still refused', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    const errors = [];
    doc.onError = (message, err, title) => errors.push(title);
    server.refuseNext(500, 'Injected');
    const outcome = await doc.cellWrite(() =>
      doc.editAlignment('a-2', { text: 'two!', timeBegin: 1, timeEnd: 2 }),
    );
    await idle(doc);
    expect(outcome.landed).toBe(false);
    expect(errors).toEqual(['Failed to edit alignment']);
    expect(server.body).toBe('one two three');
  });
});

describe('a row edit in a text with no sentences', () => {
  it('makes its first sentence in the same batch, over the new body', async () => {
    const server = segmentServer(
      buildRawDoc({
        body: 'one two',
        words: [],
        morphemes: [],
        sentences: [],
        alignmentTokens: [seg('a-1', 0, 3, 0, 1), seg('a-2', 4, 7, 1, 2)],
      }),
    );
    const doc = open(server);
    await doc.editAlignment('a-2', { text: 'two!', timeBegin: 1, timeEnd: 2, speaker: 'Ana' });
    await idle(doc);
    expect(server.sent[0].ops.map((w) => w.kind)).toEqual([
      'texts.edit',
      'tokens.update',
      'tokens.patchMetadata',
      'tokens.bulkCreate',
    ]);
    expect(layer(server.stored, 'sentL').tokens.map((t) => [t.begin, t.end])).toEqual([[0, 8]]);
    expect(layer(doc._raw, 'sentL').tokens.map((t) => [t.id, t.begin, t.end])).toEqual(
      layer(server.stored, 'sentL').tokens.map((t) => [t.id, t.begin, t.end]),
    );
  });
});

describe('two pages edit the same row (Q1)', () => {
  it('the later edit is refused with the stored text and its own, on the same segment', async () => {
    const server = segmentServer(RAW());
    const mine = open(server);
    const theirs = open(server, server.connect('b'), 'b');
    expect(
      await theirs.editAlignment('a-2', {
        text: 'deux',
        timeBegin: 1,
        timeEnd: 2,
        edits: { over: 'two', gaps: [{ start: 0, end: 3, value: 'deux' }] },
      }),
    ).toBe(true);
    await idle(theirs);
    expect(server.segments().map((t) => t.id)).toEqual(['a-1', 'a-2', 'a-3']);

    const outcome = await mine.cellWrite(() =>
      mine.editAlignment('a-2', {
        text: 'dos',
        timeBegin: 1,
        timeEnd: 2,
        edits: { over: 'two', gaps: [{ start: 0, end: 3, value: 'dos' }] },
      }),
    );
    await idle(mine);
    expect(outcome.landed).toBe(false);
    expect(outcome.status).toBe(409);
    // Their segment is this row's segment, so the refusal is a conflict on
    // it, not a row whose segment is gone.
    expect(outcome.error.conflict).toEqual({ stored: 'deux', mine: 'dos' });
    expect(server.body).toBe('one deux three');
    expect(textOf(mine._raw, 'a-2')).toBe('deux');
    expect(mine.unsavedRows).toEqual([]);
  });

  it('an edit of another row by the other page is no conflict, and both land', async () => {
    const server = segmentServer(RAW());
    const mine = open(server);
    const theirs = open(server, server.connect('b'), 'b');
    await theirs.editAlignment('a-1', { text: 'uno', timeBegin: 0, timeEnd: 1 });
    await idle(theirs);
    const outcome = await mine.cellWrite(() =>
      mine.editAlignment('a-3', {
        text: 'three!',
        timeBegin: 2,
        timeEnd: 3,
        edits: { over: 'three', gaps: [{ start: 5, end: 5, value: '!' }] },
      }),
    );
    await idle(mine);
    expect(outcome.landed).toBe(true);
    expect(server.body).toBe('uno two three!');
    expect(textWrites(server).at(-1).args[3].base).toBe(digestOf('uno two three'));
    expect(glosses(server.stored)).toEqual(['uno:G1', 'two:G2', 'three!:G3']);
    expect(mine.body).toBe(server.body);
  });
});
