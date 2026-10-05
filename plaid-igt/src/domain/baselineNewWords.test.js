// "Tokenize new text" on the Baseline tab's save: the words of the text typed
// go in the same request as the edit, or the save goes alone when there are
// none, the setting is off, or the text is spaceless.
import { beforeEach, describe, expect, it } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';
import { digestOf, segmentServer } from '../test/segmentServer.js';

beforeEach(() => resetIds());

const wordLayer = (raw) => raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL');
const setting = (raw, value) => {
  if (value !== undefined) wordLayer(raw).config.igt.tokenizeNewText = value;
  return raw;
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
  doc._writes._retryDelay = () => 5;
  return doc;
};

// The words stored, as their text.
const storedWords = (server) => {
  const body = [...server.body];
  return wordLayer(server.stored)
    .tokens.slice()
    .sort((a, b) => a.begin - b.begin)
    .map((t) => body.slice(t.begin, t.end).join(''));
};

// What was sent: each request as the kinds of its writes.
const requests = (server) =>
  server.sent.map((r) => (r.kind === 'batch' ? r.ops.map((o) => o.kind) : [r.kind]));

const tokenized = (body, extra = {}) =>
  buildRawDoc({
    body,
    words: [...body.matchAll(/\S+/gu)].map((m, i) => ({
      id: `w-${i + 1}`,
      begin: [...body.slice(0, m.index)].length,
      end: [...body.slice(0, m.index)].length + [...m[0]].length,
    })),
    morphemes: [],
    ...extra,
  });

describe('a Baseline save with "Tokenize new text"', () => {
  it('sends the words of a new sentence in the request that saves it', async () => {
    const server = segmentServer(tokenized('uno dos'));
    const doc = open(server);
    const gaps = [{ start: 7, end: 7, value: '. Tres cuatro, cinco.' }];
    expect(await doc.editBaselineText({ base: 'uno dos', digest: digestOf('uno dos'), gaps })).toBe(
      true,
    );
    expect(requests(server)).toEqual([['texts.edit', 'tokens.bulkCreate']]);
    expect(server.body).toBe('uno dos. Tres cuatro, cinco.');
    expect(storedWords(server)).toEqual(['uno', 'dos', 'Tres', 'cuatro', 'cinco']);
    // the page shows them
    const body = [...doc.body];
    expect(
      doc.layerInfo.primaryTokenLayer.tokens.map((t) => body.slice(t.begin, t.end).join('')),
    ).toEqual(['uno', 'dos', 'Tres', 'cuatro', 'cinco']);
  });

  it('gives a word to one added by a line pasted over itself (L1-TEXT-2)', async () => {
    const line = 'One two three four.';
    const server = segmentServer(tokenized(line));
    const doc = open(server);
    const gaps = [{ start: 0, end: 19, value: 'One two and three four.' }];
    await doc.editBaselineText({ base: line, digest: digestOf(line), gaps });
    expect(requests(server)).toEqual([['texts.edit', 'tokens.bulkCreate']]);
    const made = server.sent[0].ops[1].args[0];
    expect(made.map((w) => [...server.body].slice(w.begin, w.end).join(''))).toEqual(['and']);
  });

  it('is on when the project has never set it', async () => {
    const raw = tokenized('uno');
    expect(wordLayer(raw).config.igt.tokenizeNewText).toBeUndefined();
    const server = segmentServer(raw);
    const doc = open(server);
    const gaps = [{ start: 3, end: 3, value: ' dos' }];
    await doc.editBaselineText({ base: 'uno', digest: digestOf('uno'), gaps });
    expect(storedWords(server)).toEqual(['uno', 'dos']);
  });

  it('sends the edit alone when the text typed joins a word', async () => {
    const server = segmentServer(tokenized('uno dos'));
    const doc = open(server);
    const gaps = [{ start: 7, end: 7, value: 's' }];
    await doc.editBaselineText({ base: 'uno dos', digest: digestOf('uno dos'), gaps });
    expect(requests(server)).toEqual([['texts.edit']]);
  });

  it('sends the edit alone when the project has it off', async () => {
    const server = segmentServer(setting(tokenized('uno dos'), false));
    const doc = open(server);
    const gaps = [{ start: 7, end: 7, value: ' tres' }];
    await doc.editBaselineText({ base: 'uno dos', digest: digestOf('uno dos'), gaps });
    expect(requests(server)).toEqual([['texts.edit']]);
    expect(storedWords(server)).toEqual(['uno', 'dos']);
  });

  it('makes no words of text in a script written without spaces', async () => {
    const body = '我今天去北京。';
    const server = segmentServer(
      buildRawDoc({ body, words: [], morphemes: [], sentences: [{ id: 's-1', begin: 0, end: 7 }] }),
    );
    const doc = open(server);
    const gaps = [{ start: 7, end: 7, value: '他明天来。' }];
    await doc.editBaselineText({ base: body, digest: digestOf(body), gaps });
    expect(requests(server)).toEqual([['texts.edit']]);
    expect(storedWords(server)).toEqual([]);
  });

  it('sends the first sentences and the words with the edit when the text has no sentences', async () => {
    const server = segmentServer(
      buildRawDoc({ body: 'uno', words: [], morphemes: [], sentences: [] }),
    );
    const doc = open(server);
    const gaps = [{ start: 3, end: 3, value: ' dos\ntres' }];
    await doc.editBaselineText({ base: 'uno', digest: digestOf('uno'), gaps });
    expect(requests(server)).toEqual([['texts.edit', 'tokens.bulkCreate', 'tokens.bulkCreate']]);
    // `uno` was there before the save, untyped: it stays as it was
    expect(storedWords(server)).toEqual(['dos', 'tres']);
  });

  it('sends a save whose answer was lost again as it was, words and all, under its keys', async () => {
    const server = segmentServer(tokenized('uno'));
    const doc = open(server);
    server.loseNext(1);
    const gaps = [{ start: 3, end: 3, value: ' dos' }];
    expect(await doc.editBaselineText({ base: 'uno', digest: digestOf('uno'), gaps })).toBe(true);
    const [lost, again] = server.sent;
    expect([lost.answer, again.answer]).toEqual(['lost', 'replayed']);
    expect(again.key).toBe(lost.key);
    expect(again.ops).toEqual(lost.ops);
    expect(storedWords(server)).toEqual(['uno', 'dos']);
    expect(doc.layerInfo.primaryTokenLayer.tokens).toHaveLength(2);
  });

  it('saves the edit without the words when a word of them lies over one the server placed', async () => {
    const server = segmentServer(tokenized('uno'));
    const doc = open(server);
    const errors = [];
    doc.onError = (message, err) => errors.push(err?.message ?? message);
    server.refuseNext(409, 'Bulk-created token overlaps with existing token(s)');
    const gaps = [{ start: 3, end: 3, value: ' dos' }];
    expect(await doc.editBaselineText({ base: 'uno', digest: digestOf('uno'), gaps })).toBe(true);
    expect(requests(server)).toEqual([['texts.edit', 'tokens.bulkCreate'], ['texts.edit']]);
    const [first, second] = server.sent;
    expect(second.key).not.toBe(first.key);
    expect(server.body).toBe('uno dos');
    expect(errors).toEqual([]);
  });

  it('gives a document’s first text its words in the batch that makes it', async () => {
    const raw = buildRawDoc({ body: '', words: [], morphemes: [], sentences: [] });
    delete raw.textLayers[0].text;
    const client = makeFakeClient({
      reloadDoc: buildRawDoc({ body: 'uno dos.\ntres cuatro' }),
    });
    const doc = new IgtDocument({
      raw,
      project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
      vocabularies: {},
      client,
      projectId: 'proj-1',
    });
    const gaps = [{ start: 0, end: 0, value: 'uno dos.\ntres cuatro' }];
    expect(await doc.editBaselineText({ base: '', digest: null, gaps })).toBe(true);
    const writes = client.calls.filter((c) => c.kind !== 'beginOperation');
    expect(writes.slice(0, 3).map((c) => c.kind)).toEqual([
      'texts.create',
      'tokens.bulkCreate',
      'tokens.bulkCreate',
    ]);
    const [, sentences, words] = writes;
    expect(sentences.args[0].map((s) => [s.begin, s.end])).toEqual([
      [0, 9],
      [9, 20],
    ]);
    expect(words.args[0].map((w) => [w.tokenLayerId, w.begin, w.end])).toEqual([
      ['wordL', 0, 3],
      ['wordL', 4, 7],
      ['wordL', 9, 13],
      ['wordL', 14, 20],
    ]);
    expect(words.args[0][0].text).toBe(sentences.args[0][0].text);
  });

  it('gives a script’s save of a document’s first text no words', async () => {
    const raw = buildRawDoc({ body: '', words: [], morphemes: [], sentences: [] });
    delete raw.textLayers[0].text;
    const client = makeFakeClient({ reloadDoc: buildRawDoc({ body: 'uno dos' }) });
    const doc = new IgtDocument({
      raw,
      project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
      vocabularies: {},
      client,
      projectId: 'proj-1',
    });
    expect(await doc.saveBaselineText('uno dos', '')).toBe(true);
    const writes = client.calls.filter((c) => c.kind.startsWith('t'));
    expect(writes.map((c) => c.kind)).toEqual(['texts.create', 'tokens.bulkCreate']);
    expect(writes[1].args[0].map((t) => t.tokenLayerId)).toEqual(['sentL']);
  });
});
