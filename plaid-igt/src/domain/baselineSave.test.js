// The Baseline tab's save when the stored text has moved on (V2 F1), and a
// save whose answer is lost (V5 H5-5).
import { beforeEach, describe, expect, it } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';

function makeDoc({ raw, client } = {}) {
  return new IgtDocument({
    raw: raw ?? buildRawDoc(),
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client: client ?? makeFakeClient(),
    projectId: 'proj-1',
  });
}

const httpError = (status, method = 'PATCH') =>
  Object.assign(new Error(`HTTP ${status} refused at http://x/api/v1/texts/text-1`), {
    status,
    method,
  });

// A client whose document reads come from `reads` in turn (the last one
// repeats), and whose text updates answer from `answers` in turn.
function scriptedClient({ reads, answers = [] }) {
  const client = makeFakeClient();
  let read = 0;
  client.documents.get = async () => reads[Math.min(read++, reads.length - 1)];
  const update = client.texts.update;
  let sent = 0;
  client.texts.update = async (...args) => {
    const answer = answers[sent++];
    await update(...args);
    if (answer) throw answer;
    return {};
  };
  return client;
}

const updates = (client) =>
  client.calls.filter((c) => c.kind === 'texts.update').map((c) => c.args[1]);

beforeEach(() => resetIds());

describe('saveBaselineText over a text saved elsewhere', () => {
  const base = 'the big fish swam';
  const theirs = 'the fish swam'; // someone else deleted "big "
  const draft = 'the big fish swam. Then they slept.'; // typed over the old copy

  it('merges the draft onto the text the 409 refetch read, and sends that', async () => {
    const client = scriptedClient({
      reads: [buildRawDoc({ body: theirs, sentences: [{ id: 's-1', begin: 0, end: 13 }] })],
      answers: [httpError(409)],
    });
    const doc = makeDoc({ raw: buildRawDoc({ body: base }), client });
    expect(await doc.saveBaselineText(draft, base)).toBe(true);
    expect(updates(client)).toEqual([draft, 'the fish swam. Then they slept.']);
  });

  it('merges before the first send when this copy already holds the newer text', async () => {
    const client = makeFakeClient();
    const doc = makeDoc({
      raw: buildRawDoc({ body: theirs, sentences: [{ id: 's-1', begin: 0, end: 13 }] }),
      client,
    });
    expect(await doc.saveBaselineText(draft, base)).toBe(true);
    expect(updates(client)).toEqual(['the fish swam. Then they slept.']);
  });

  it('refuses a draft that changed the same passage, and sends nothing over it', async () => {
    const client = scriptedClient({
      reads: [buildRawDoc({ body: theirs, sentences: [{ id: 's-1', begin: 0, end: 13 }] })],
      answers: [httpError(409)],
    });
    const errors = [];
    const doc = makeDoc({ raw: buildRawDoc({ body: base }), client });
    doc.onError = (message, err) => errors.push(err?.message ?? message);
    expect(await doc.saveBaselineText('the large fish swam', base)).toBe(false);
    expect(updates(client)).toEqual(['the large fish swam']);
    expect(errors.join(' ')).toMatch(/same passage was changed elsewhere/);
  });

  it('a second save after a refused one still merges, never resending the stale draft', async () => {
    const newer = buildRawDoc({ body: theirs, sentences: [{ id: 's-1', begin: 0, end: 13 }] });
    const client = scriptedClient({
      reads: [newer],
      answers: [httpError(409), httpError(409), httpError(409)],
    });
    const doc = makeDoc({ raw: buildRawDoc({ body: base }), client });
    expect(await doc.saveBaselineText(draft, base)).toBe(false);
    // Every send after the first carried the other save's deletion.
    expect(
      updates(client)
        .slice(1)
        .every((b) => !b.includes('big')),
    ).toBe(true);
    // Save again from the same draft, with the server taking it now.
    const sent = [];
    client.texts.update = async (...args) => {
      sent.push(args[1]);
      return {};
    };
    expect(await doc.saveBaselineText(draft, base)).toBe(true);
    expect(sent).toEqual(['the fish swam. Then they slept.']);
  });
});

describe('saveBaselineText and the sentence partition', () => {
  it('sends the text and its sentences in one batch when the text has none', async () => {
    const raw = buildRawDoc({ body: '', sentences: [], words: [], morphemes: [] });
    const client = makeFakeClient({
      reloadDoc: buildRawDoc({
        body: 'one\ntwo',
        sentences: [
          { id: 's-1', begin: 0, end: 4 },
          { id: 's-2', begin: 4, end: 7 },
        ],
      }),
    });
    const doc = makeDoc({ raw, client });
    expect(await doc.saveBaselineText('one\ntwo')).toBe(true);
    const kinds = client.calls.map((c) => c.kind);
    expect(kinds.slice(kinds.indexOf('texts.update'))).toEqual([
      'texts.update',
      'tokens.bulkCreate',
      'batch.submit',
    ]);
  });

  it('a save whose answer was lost and that landed goes on to seed the sentences', async () => {
    const raw = buildRawDoc({ body: 'old', sentences: [{ id: 's-1', begin: 0, end: 3 }] });
    const landed = buildRawDoc({ body: 'new\nlines', sentences: [], words: [], morphemes: [] });
    const client = scriptedClient({ reads: [landed], answers: [httpError(0)] });
    const doc = makeDoc({ raw, client });
    expect(await doc.saveBaselineText('new\nlines')).toBe(true);
    const seed = client.calls.find((c) => c.kind === 'tokens.bulkCreate');
    expect(seed.args[0]).toEqual([
      { tokenLayerId: 'sentL', text: 'text-1', begin: 0, end: 4 },
      { tokenLayerId: 'sentL', text: 'text-1', begin: 4, end: 9 },
    ]);
  });

  it('a save whose answer was lost and that did not land is reported, not seeded', async () => {
    const raw = buildRawDoc({ body: 'old', sentences: [{ id: 's-1', begin: 0, end: 3 }] });
    const client = scriptedClient({ reads: [raw], answers: [httpError(0)] });
    const doc = makeDoc({ raw, client });
    expect(await doc.saveBaselineText('new\nlines')).toBe(false);
    expect(client.calls.some((c) => c.kind === 'tokens.bulkCreate')).toBe(false);
  });
});

describe('saveBaselineText on a document with no text yet', () => {
  it('a create whose answer was lost and that landed seeds the sentences', async () => {
    const raw = buildRawDoc({ body: '', sentences: [], words: [], morphemes: [] });
    raw.textLayers[0].text = null;
    const landed = buildRawDoc({ body: 'a\nb', sentences: [], words: [], morphemes: [] });
    const client = makeFakeClient();
    client.documents.get = async () => landed;
    client.texts.create = async () => {
      throw httpError(0, 'POST');
    };
    const doc = makeDoc({ raw, client });
    expect(await doc.saveBaselineText('a\nb')).toBe(true);
    const seed = client.calls.find((c) => c.kind === 'tokens.bulkCreate');
    expect(seed.args[0]).toEqual([
      { tokenLayerId: 'sentL', text: 'text-1', begin: 0, end: 2 },
      { tokenLayerId: 'sentL', text: 'text-1', begin: 2, end: 3 },
    ]);
  });
});
