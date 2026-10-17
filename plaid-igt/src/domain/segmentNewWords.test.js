// "Tokenize new text" on the Media tab's transcript rows: the text write of a
// new segment or a row edit names the word layer, unless the project has the
// setting off, and the words the server makes are shown from its answer.
// Which words it makes is the core's (`tokenize_new_text_test.clj`): the
// server here (test/segmentServer.js) makes a stand-in's.
import { beforeEach, describe, expect, it } from 'vitest';
import { buildRawDoc, resetIds, makeIgtDoc, settle } from './test-helpers.js';
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
  const doc = makeIgtDoc({
    raw: structuredClone(server.stored),
    client: server.client,
    user: { id: 'a' },
  });
  doc._writes._retryDelay = () => 5;
  return doc;
};
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

// The options the text write of request `i` went with.
const textOptions = (server, i = 0) => server.sent[i].ops[0].args[3];

const editRow = (doc, id, over, text, gaps, times) =>
  doc.editAlignment(id, { text, ...times, edits: { over, gaps } });

describe('a new segment with "Tokenize new text"', () => {
  it('names the word layer, and shows the words the answer made under their ids', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    expect(await doc.createAlignment({ text: 'four, five', timeBegin: 3, timeEnd: 4 })).toBe(true);
    await idle(doc);
    expect(requests(server)).toEqual([['texts.update', 'tokens.create']]);
    expect(textOptions(server).tokenizeLayer).toBe('wordL');
    expect(wordsOf(server.stored)).toEqual(['one', 'two', 'three', 'four,', 'five']);
    expect(wordsOf(doc._raw)).toEqual(wordsOf(server.stored));
    const stored = new Set(wordLayer(server.stored).tokens.map((t) => t.id));
    expect(wordLayer(doc._raw).tokens.every((t) => stored.has(t.id))).toBe(true);
  });

  it('names no layer when the project has the setting off', async () => {
    const server = segmentServer(RAW(false));
    const doc = open(server);
    expect(await doc.createAlignment({ text: 'four five', timeBegin: 3, timeEnd: 4 })).toBe(true);
    await idle(doc);
    expect(textOptions(server).tokenizeLayer).toBeUndefined();
    expect(wordsOf(doc._raw)).toEqual(['one', 'two', 'three']);
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
});

describe('a transcript row edit with "Tokenize new text"', () => {
  it('names the word layer, and shows the words the answer made', async () => {
    const server = segmentServer(RAW());
    const doc = open(server);
    expect(
      await editRow(doc, 'a-3', 'three', 'three more', [{ start: 5, end: 5, value: ' more' }], {
        timeBegin: 2,
        timeEnd: 3,
      }),
    ).toBe(true);
    await idle(doc);
    expect(requests(server)).toEqual([['texts.edit', 'tokens.update']]);
    expect(textOptions(server).tokenizeLayer).toBe('wordL');
    expect(wordsOf(server.stored)).toEqual(['one', 'two', 'three', 'more']);
    expect(wordsOf(doc._raw)).toEqual(['one', 'two', 'three', 'more']);
  });

  it('names no layer when the project has the setting off', async () => {
    const server = segmentServer(RAW(false));
    const doc = open(server);
    await editRow(doc, 'a-3', 'three', 'three more', [{ start: 5, end: 5, value: ' more' }], {
      timeBegin: 2,
      timeEnd: 3,
    });
    await idle(doc);
    expect(textOptions(server).tokenizeLayer).toBeUndefined();
    expect(wordsOf(server.stored)).toEqual(['one', 'two', 'three']);
  });
});
