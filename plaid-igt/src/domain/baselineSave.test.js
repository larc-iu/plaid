// saveBaselineText, a whole body saved as the document's text: a new text is
// made with its sentences in one batch, and a text that exists takes the one
// edit between the two bodies, sent as the Baseline tab sends its edits.
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

beforeEach(() => resetIds());

describe('saveBaselineText on a text that exists', () => {
  it('sends the one edit between the bodies, with the digest of the body stored', async () => {
    const raw = buildRawDoc({ body: 'the cat ran', sentences: [{ id: 's-1', begin: 0, end: 11 }] });
    raw.textLayers[0].text.digest = 'd0';
    raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL').config.igt.tokenizeNewText = false;
    const client = makeFakeClient();
    const doc = makeDoc({ raw, client });
    expect(await doc.saveBaselineText('the big cat ran')).toBe(true);
    const edit = client.calls.find((c) => c.kind === 'texts.edit');
    expect(edit.args[1]).toEqual([{ type: 'insert', index: 4, value: 'big ' }]);
    expect(edit.args[3]).toEqual({ base: 'd0' });
    expect(client.calls.map((c) => c.kind)).not.toContain('texts.update');
  });
});

describe('saveBaselineText on a document with no text yet', () => {
  it('makes the text and its sentences in one batch, the sentences naming the id minted for the text', async () => {
    const raw = buildRawDoc({ body: '', sentences: [], words: [], morphemes: [] });
    raw.textLayers[0].text = null;
    const client = makeFakeClient({
      reloadDoc: buildRawDoc({ body: 'a\nb', sentences: [], words: [], morphemes: [] }),
    });
    const doc = makeDoc({ raw, client });
    expect(await doc.saveBaselineText('a\nb')).toBe(true);
    const create = client.calls.find((c) => c.kind === 'texts.create');
    const id = create.args[5].id;
    expect(typeof id).toBe('string');
    const seed = client.calls.find((c) => c.kind === 'tokens.bulkCreate');
    expect(seed.args[0]).toEqual([
      { tokenLayerId: 'sentL', text: id, begin: 0, end: 2 },
      { tokenLayerId: 'sentL', text: id, begin: 2, end: 3 },
    ]);
  });
});
