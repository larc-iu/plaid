// A new segment's text stands apart from the text beside it: a space on each
// side it would touch other text, none where whitespace is there already (a
// line break included). Against test/segmentServer.js.
import { beforeEach, describe, expect, it } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, resetIds } from './test-helpers.js';
import { segmentServer } from '../test/segmentServer.js';

beforeEach(() => resetIds());

const open = (server) =>
  new IgtDocument({
    raw: structuredClone(server.stored),
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client: server.client,
    projectId: 'proj-1',
    user: { id: 'a' },
  });

const raw = (body, alignmentTokens = []) =>
  buildRawDoc({ body, words: [], morphemes: [], alignmentTokens });

const seg = (id, begin, end, timeBegin, timeEnd) => ({
  id,
  text: 'text-1',
  begin,
  end,
  metadata: { timeBegin, timeEnd },
});

const segmentTexts = (server) => {
  const body = [...server.body];
  return server
    .segments()
    .slice()
    .sort((a, b) => a.begin - b.begin)
    .map((t) => body.slice(t.begin, t.end).join(''));
};

describe("a new segment's text", () => {
  it('after text that ends in a line break gets no space before it', async () => {
    const server = segmentServer(raw('one\n'));
    expect(await open(server).createAlignment({ text: 'two', timeBegin: 0, timeEnd: 1 })).toBe(
      true,
    );
    expect(server.body).toBe('one\ntwo');
    expect(segmentTexts(server)).toEqual(['two']);
  });

  it('between a segment and a line break gets a space before it only', async () => {
    const server = segmentServer(
      raw('one\nthree', [seg('a-1', 0, 3, 0, 1), seg('a-3', 4, 9, 4, 5)]),
    );
    await open(server).createAlignment({ text: 'two', timeBegin: 2, timeEnd: 3 });
    expect(server.body).toBe('one two\nthree');
    expect(segmentTexts(server)).toEqual(['one', 'two', 'three']);
  });

  it('before text that starts with whitespace gets no space after it', async () => {
    const server = segmentServer(raw(' one', [seg('a-1', 1, 4, 5, 6)]));
    await open(server).createAlignment({ text: 'zero', timeBegin: 0, timeEnd: 1 });
    expect(server.body).toBe('zero one');
    expect(segmentTexts(server)).toEqual(['zero', 'one']);
  });

  it('against text on both sides gets a space on each', async () => {
    const server = segmentServer(raw('onethree', [seg('a-1', 0, 3, 0, 1), seg('a-3', 3, 8, 4, 5)]));
    await open(server).createAlignment({ text: 'two', timeBegin: 2, timeEnd: 3 });
    expect(server.body).toBe('one two three');
    expect(segmentTexts(server)).toEqual(['one', 'two', 'three']);
  });
});
