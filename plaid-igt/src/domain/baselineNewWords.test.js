// "Tokenize new text" on the Baseline tab's save: the edit names the word
// layer, the server makes the words of the text it types, and the page shows
// them from the answer. Which words the server makes is the core's
// (`tokenize_new_text_test.clj`): the fake server here makes a stand-in's.
import { beforeEach, describe, expect, it } from 'vitest';
import { buildRawDoc, makeFakeClient, resetIds, makeIgtDoc } from './test-helpers.js';
import { digestOf, segmentServer } from '../test/segmentServer.js';

beforeEach(() => resetIds());

const wordLayer = (raw) => raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL');
const setting = (raw, value) => {
  if (value !== undefined) wordLayer(raw).config.igt.tokenizeNewText = value;
  return raw;
};

const open = (server) => {
  const doc = makeIgtDoc({
    raw: structuredClone(server.stored),
    client: server.client,
    user: { id: 'a' },
  });
  doc._writes._retryDelay = () => 5;
  return doc;
};

// What was sent: each request as the kinds of its writes.
const requests = (server) =>
  server.sent.map((r) => (r.kind === 'batch' ? r.ops.map((o) => o.kind) : [r.kind]));

// The options the text write of request `i` went with.
const textOptions = (server, i = 0) => {
  const r = server.sent[i];
  return (r.kind === 'batch' ? r.ops[0].args : r.args)[3];
};

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

const shownWords = (doc) => {
  const body = [...doc.body];
  return doc.layerInfo.primaryTokenLayer.tokens.map((t) => body.slice(t.begin, t.end).join(''));
};

describe('a Baseline save with "Tokenize new text"', () => {
  it('names the word layer in the edit, and shows the words the answer made', async () => {
    const server = segmentServer(tokenized('uno dos'));
    const doc = open(server);
    const gaps = [{ start: 7, end: 7, value: ' tres cuatro' }];
    expect(await doc.editBaselineText({ base: 'uno dos', digest: digestOf('uno dos'), gaps })).toBe(
      true,
    );
    expect(requests(server)).toEqual([['texts.edit']]);
    expect(textOptions(server).tokenizeLayer).toBe('wordL');
    expect(shownWords(doc)).toEqual(['uno', 'dos', 'tres', 'cuatro']);
  });

  it('is on when the project has never set it', async () => {
    const raw = tokenized('uno');
    expect(wordLayer(raw).config.igt.tokenizeNewText).toBeUndefined();
    const server = segmentServer(raw);
    const doc = open(server);
    const gaps = [{ start: 3, end: 3, value: ' dos' }];
    await doc.editBaselineText({ base: 'uno', digest: digestOf('uno'), gaps });
    expect(textOptions(server).tokenizeLayer).toBe('wordL');
  });

  it('names no layer when the project has it off', async () => {
    const server = segmentServer(setting(tokenized('uno dos'), false));
    const doc = open(server);
    const gaps = [{ start: 7, end: 7, value: ' tres' }];
    await doc.editBaselineText({ base: 'uno dos', digest: digestOf('uno dos'), gaps });
    expect(requests(server)).toEqual([['texts.edit']]);
    expect(textOptions(server).tokenizeLayer).toBeUndefined();
    expect(shownWords(doc)).toEqual(['uno', 'dos']);
  });

  it('sends the first sentences with the edit when the text has no sentences', async () => {
    const server = segmentServer(
      buildRawDoc({ body: 'uno', words: [], morphemes: [], sentences: [] }),
    );
    const doc = open(server);
    const gaps = [{ start: 3, end: 3, value: ' dos\ntres' }];
    await doc.editBaselineText({ base: 'uno', digest: digestOf('uno'), gaps });
    expect(requests(server)).toEqual([['texts.edit', 'tokens.bulkCreate']]);
    expect(textOptions(server).tokenizeLayer).toBe('wordL');
  });

  it('names the word layer when it makes a document’s first text', async () => {
    const raw = buildRawDoc({ body: '', words: [], morphemes: [], sentences: [] });
    delete raw.textLayers[0].text;
    const client = makeFakeClient({
      reloadDoc: buildRawDoc({ body: 'uno dos.\ntres cuatro' }),
    });
    const doc = makeIgtDoc({ raw, client });
    const gaps = [{ start: 0, end: 0, value: 'uno dos.\ntres cuatro' }];
    expect(await doc.editBaselineText({ base: '', digest: null, gaps })).toBe(true);
    const writes = client.calls.filter((c) => c.kind !== 'beginOperation');
    expect(writes.slice(0, 2).map((c) => c.kind)).toEqual(['texts.create', 'tokens.bulkCreate']);
    expect(writes[0].args[5].tokenizeLayer).toBe('wordL');
    expect(writes[1].args[0].map((s) => [s.tokenLayerId, s.begin, s.end])).toEqual([
      ['sentL', 0, 9],
      ['sentL', 9, 20],
    ]);
  });

  it('names no layer in a script’s save of a document’s first text', async () => {
    const raw = buildRawDoc({ body: '', words: [], morphemes: [], sentences: [] });
    delete raw.textLayers[0].text;
    const client = makeFakeClient({ reloadDoc: buildRawDoc({ body: 'uno dos' }) });
    const doc = makeIgtDoc({ raw, client });
    expect(await doc.saveBaselineText('uno dos', '')).toBe(true);
    const writes = client.calls.filter((c) => c.kind.startsWith('t'));
    expect(writes.map((c) => c.kind)).toEqual(['texts.create', 'tokens.bulkCreate']);
    expect(writes[0].args[5].tokenizeLayer).toBeUndefined();
  });
});
