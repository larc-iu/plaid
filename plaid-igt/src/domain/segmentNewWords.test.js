// "Tokenize new text" on the Media tab's transcript rows: the text a new
// segment or a row edit adds gets the words a Baseline save would give it,
// shown at once and made in the batch that writes the text, unless the
// project has the setting off or the text is in a script written without
// spaces. Against a server that keeps what it stores (test/segmentServer.js).
import { beforeEach, describe, expect, it } from 'vitest';
import { isPendingId } from '@ui/domain/pendingIds.js';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, resetIds } from './test-helpers.js';
import { segmentServer } from '../test/segmentServer.js';

beforeEach(() => resetIds());

const seg = (id, begin, end, timeBegin, timeEnd) => ({
  id,
  text: 'text-1',
  begin,
  end,
  metadata: { timeBegin, timeEnd },
});

// Three segments over "one two three", a word each.
const RAW = (tokenize) => {
  const raw = buildRawDoc({
    body: 'one two three',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 13 },
    ],
    morphemes: [],
    alignmentTokens: [seg('a-1', 0, 3, 0, 1), seg('a-2', 4, 7, 1, 2), seg('a-3', 8, 13, 2, 3)],
  });
  if (tokenize !== undefined) wordLayer(raw).config.igt.tokenizeNewText = tokenize;
  return raw;
};

const wordLayer = (raw) => raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL');

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const idle = async (doc) => {
  while (doc.isSaving) await settle();
};

// The words of a raw document, as their text.
const wordsOf = (raw) => {
  const body = [...raw.textLayers[0].text.body];
  return wordLayer(raw)
    .tokens.slice()
    .sort((a, b) => a.begin - b.begin)
    .map((t) => body.slice(t.begin, t.end).join(''));
};

// What was sent: each request as the kinds of its writes.
const requests = (server) =>
  server.sent.map((r) => (r.kind === 'batch' ? r.ops.map((o) => o.kind) : [r.kind]));

const editRow = (doc, id, over, text, gaps, times) =>
  doc.editAlignment(id, { text, ...times, edits: { over, gaps } });

describe('a new segment with "Tokenize new text"', () => {
  it('shows the words of its text at once and makes them in the batch that writes it', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    const saving = doc.createAlignment({ text: 'four, five', timeBegin: 3, timeEnd: 4 });
    // On screen before the server answers, under pending ids.
    expect(wordsOf(doc._raw)).toEqual(['one', 'two', 'three', 'four', 'five']);
    const shown = wordLayer(doc._raw).tokens.filter((t) => t.begin >= 14);
    expect(shown.every((t) => isPendingId(t.id))).toBe(true);
    expect(await saving).toBe(true);
    await idle(doc);
    expect(requests(server)).toEqual([['texts.update', 'tokens.create', 'tokens.bulkCreate']]);
    expect(server.body).toBe('one two three four, five');
    expect(wordsOf(server.stored)).toEqual(['one', 'two', 'three', 'four', 'five']);
    // The page holds the ids the server made them under.
    const stored = new Set(wordLayer(server.stored).tokens.map((t) => t.id));
    expect(wordLayer(doc._raw).tokens.every((t) => stored.has(t.id))).toBe(true);
  });

  it('makes no words when the project has the setting off', async () => {
    const server = segmentServer(RAW(false));
    const doc = open(server);
    expect(await doc.createAlignment({ text: 'four five', timeBegin: 3, timeEnd: 4 })).toBe(true);
    await idle(doc);
    expect(requests(server)).toEqual([['texts.update', 'tokens.create']]);
    expect(wordsOf(server.stored)).toEqual(['one', 'two', 'three']);
    expect(wordsOf(doc._raw)).toEqual(['one', 'two', 'three']);
  });

  it('makes no words of a script written without spaces, and words of the rest', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    await doc.createAlignment({ text: '我今天去北京。', timeBegin: 3, timeEnd: 4 });
    await doc.createAlignment({ text: '我用 Plaid 写', timeBegin: 4, timeEnd: 5 });
    await idle(doc);
    expect(requests(server)).toEqual([
      ['texts.update', 'tokens.create'],
      ['texts.update', 'tokens.create', 'tokens.bulkCreate'],
    ]);
    expect(wordsOf(server.stored)).toEqual(['one', 'two', 'three', 'Plaid']);
  });

  it('a lost answer is sent again as it was, and the words are made once', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    server.loseNext();
    expect(await doc.createAlignment({ text: 'four', timeBegin: 3, timeEnd: 4 })).toBe(true);
    await idle(doc);
    expect(server.answers()).toEqual(['lost', 'replayed']);
    expect(server.sent[0].key).toBe(server.sent[1].key);
    expect(wordsOf(server.stored)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('a batch refused for a word over one the server placed goes again without its words', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    server.refuseNext(409, 'Bulk-created token overlaps an existing token.');
    expect(await doc.createAlignment({ text: 'four', timeBegin: 3, timeEnd: 4 })).toBe(true);
    await idle(doc);
    expect(requests(server)).toEqual([
      ['texts.update', 'tokens.create', 'tokens.bulkCreate'],
      ['texts.update', 'tokens.create'],
    ]);
    // Under new keys: the refused request stored nothing under its own.
    expect(server.sent[1].key).not.toBe(server.sent[0].key);
    expect(server.answers()).toEqual([409, 200]);
    expect(server.body).toBe('one two three four');
    expect(wordsOf(server.stored)).toEqual(['one', 'two', 'three']);
    expect(wordsOf(doc._raw)).toEqual(['one', 'two', 'three']);
    expect(doc._raw.textLayers[0].text.body).toBe('one two three four');
  });
});

describe('a transcript row edit with "Tokenize new text"', () => {
  it('a word typed after a space is made', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    const saving = editRow(
      doc,
      'a-3',
      'three',
      'three more',
      [{ start: 5, end: 5, value: ' more' }],
      {
        timeBegin: 2,
        timeEnd: 3,
      },
    );
    // On screen before the server answers.
    expect(wordsOf(doc._raw)).toEqual(['one', 'two', 'three', 'more']);
    expect(await saving).toBe(true);
    await idle(doc);
    expect(requests(server)).toEqual([['texts.edit', 'tokens.update', 'tokens.bulkCreate']]);
    expect(server.body).toBe('one two three more');
    expect(wordsOf(server.stored)).toEqual(['one', 'two', 'three', 'more']);
    expect(wordsOf(doc._raw)).toEqual(['one', 'two', 'three', 'more']);
    const stored = new Set(wordLayer(server.stored).tokens.map((t) => t.id));
    expect(wordLayer(doc._raw).tokens.every((t) => stored.has(t.id))).toBe(true);
  });

  it('letters typed against a word are left to it', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    await editRow(doc, 'a-3', 'three', 'threes', [{ start: 5, end: 5, value: 's' }], {
      timeBegin: 2,
      timeEnd: 3,
    });
    await idle(doc);
    expect(requests(server)).toEqual([['texts.edit', 'tokens.update']]);
    expect(wordsOf(server.stored)).toEqual(['one', 'two', 'threes']);
  });

  it('makes no words when the project has the setting off', async () => {
    const server = segmentServer(RAW(false));
    const doc = open(server);
    await editRow(doc, 'a-3', 'three', 'three more', [{ start: 5, end: 5, value: ' more' }], {
      timeBegin: 2,
      timeEnd: 3,
    });
    await idle(doc);
    expect(requests(server)).toEqual([['texts.edit', 'tokens.update']]);
    expect(wordsOf(server.stored)).toEqual(['one', 'two', 'three']);
  });

  it('makes no words of a script written without spaces', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    await editRow(doc, 'a-3', 'three', 'three 北京', [{ start: 5, end: 5, value: ' 北京' }], {
      timeBegin: 2,
      timeEnd: 3,
    });
    await idle(doc);
    expect(requests(server)).toEqual([['texts.edit', 'tokens.update']]);
  });

  it('a batch refused for a word over one the server placed goes again without its words', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    server.refuseNext(409, 'Bulk-created token overlaps an existing token.');
    expect(
      await editRow(doc, 'a-2', 'two', 'two too', [{ start: 3, end: 3, value: ' too' }], {
        timeBegin: 1,
        timeEnd: 2,
      }),
    ).toBe(true);
    await idle(doc);
    expect(requests(server)).toEqual([
      ['texts.edit', 'tokens.update', 'tokens.bulkCreate'],
      ['texts.edit', 'tokens.update'],
    ]);
    expect(server.sent[1].key).not.toBe(server.sent[0].key);
    expect(server.body).toBe('one two too three');
    expect(wordsOf(server.stored)).toEqual(['one', 'two', 'three']);
    expect(wordsOf(doc._raw)).toEqual(['one', 'two', 'three']);
  });
});
