// A Baseline save that respells a word whose one morpheme's form spelled the
// whole word respells that form with it (Luke, H17), after the edit and in
// the same save. A word cut into morphemes, a form of its own, and a morpheme
// with no form key (it reads the word already) are left alone.
import { beforeEach, describe, expect, it } from 'vitest';
import { buildRawDoc, resetIds, makeIgtDoc } from './test-helpers.js';
import { segmentServer } from '../test/segmentServer.js';
import { followedForms } from './soleMorphemeForms.js';

beforeEach(() => resetIds());

// "the cat sat dog": the cat's and the dog's morpheme spell their word in a
// form of their own, sat's is "sa" (a form unlike the word), and the's has no
// form key. `dog` is cut into two morphemes, the first spelled as the word.
const RAW = () => {
  const raw = buildRawDoc({
    body: 'the cat sat dog',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
      { id: 'w-4', begin: 12, end: 15 },
    ],
    morphemes: [
      { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} },
      { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: { form: 'cat' } },
      { id: 'm-3', text: 'text-1', begin: 8, end: 11, precedence: 1, metadata: { form: 'sa' } },
      { id: 'm-4', text: 'text-1', begin: 12, end: 15, precedence: 1, metadata: { form: 'dog' } },
      { id: 'm-5', text: 'text-1', begin: 12, end: 15, precedence: 2, metadata: { form: 's' } },
    ],
  });
  raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL').config.igt.tokenizeNewText = false;
  return raw;
};

const morph = (raw, id) =>
  raw.textLayers[0].tokenLayers.find((l) => l.id === 'morphL').tokens.find((t) => t.id === id);

describe('a Baseline save respells a sole morpheme spelled as its word', () => {
  it('follows the word, and leaves the others', async () => {
    const server = segmentServer(RAW());
    const doc = makeIgtDoc({ raw: structuredClone(server.stored), client: server.client });
    // a letter inside each word: "the chat saht dohg"
    const gaps = [
      { start: 1, end: 1, value: 'x' },
      { start: 5, end: 5, value: 'h' },
      { start: 10, end: 10, value: 'h' },
      { start: 14, end: 14, value: 'h' },
    ];
    expect(
      await doc.editBaselineText({ base: 'the cat sat dog', digest: server.digest, gaps }),
    ).toBe(true);
    while (doc.isSaving) await new Promise((r) => setTimeout(r, 0));
    expect(server.body).toBe('txhe chat saht dohg');
    expect(morph(server.stored, 'm-2').metadata.form).toBe('chat');
    expect(morph(server.stored, 'm-1').metadata).toEqual({});
    expect(morph(server.stored, 'm-3').metadata.form).toBe('sa');
    expect(morph(server.stored, 'm-4').metadata.form).toBe('dog');
    expect(morph(doc._raw, 'm-2').metadata.form).toBe('chat');
    // one form write, for the cat
    const updates = server.sent
      .flatMap((r) => (r.kind === 'batch' ? r.ops : [r]))
      .filter((w) => w.kind === 'tokens.bulkUpdate');
    expect(updates.map((w) => w.args[0])).toEqual([
      [{ id: 'm-2', metadata: [{ op: 'set', path: ['form'], value: 'chat' }] }],
    ]);
  });

  it('leaves the form when a space typed in the word leaves it one word with whitespace', async () => {
    const server = segmentServer(RAW());
    const doc = makeIgtDoc({ raw: structuredClone(server.stored), client: server.client });
    // a space inside "cat": "the c at sat dog"
    const gaps = [{ start: 5, end: 5, value: ' ' }];
    expect(
      await doc.editBaselineText({ base: 'the cat sat dog', digest: server.digest, gaps }),
    ).toBe(true);
    while (doc.isSaving) await new Promise((r) => setTimeout(r, 0));
    expect(server.body).toBe('the c at sat dog');
    const w2 = server.stored.textLayers[0].tokenLayers
      .find((l) => l.id === 'wordL')
      .tokens.find((t) => t.id === 'w-2');
    expect([w2.begin, w2.end]).toEqual([4, 8]);
    expect(morph(server.stored, 'm-2').metadata.form).toBe('cat');
    expect(morph(doc._raw, 'm-2').metadata.form).toBe('cat');
    const updates = server.sent
      .flatMap((r) => (r.kind === 'batch' ? r.ops : [r]))
      .filter((w) => w.kind === 'tokens.bulkUpdate');
    expect(updates).toEqual([]);
  });
});

describe('followedForms', () => {
  const info = (body) => ({
    primaryTokenLayer: { tokens: [{ id: 'w', begin: 0, end: [...body].length }] },
    morphemeTokenLayer: {
      tokens: [{ id: 'm', begin: 0, end: [...body].length, metadata: { form: 'pumpkin' } }],
    },
  });
  const before = new Map([['w', { morphemeId: 'm', form: 'pumpkin' }]]);

  it('follows a word respelled without whitespace', () => {
    expect(followedForms(before, info('pumpkins'), 'pumpkins')).toEqual([
      { id: 'm', form: 'pumpkins' },
    ]);
  });

  it('writes nothing when the new spelling holds whitespace', () => {
    for (const body of ['pum pkin', 'pum\tpkin', 'pum\u00a0pkin', 'pum\u3000pkin', 'pum\npkin']) {
      expect(followedForms(before, info(body), body)).toEqual([]);
    }
  });
});
