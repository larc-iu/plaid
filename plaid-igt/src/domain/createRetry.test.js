// "+ Create" makes an entry, then links the words to it. When the link is
// refused, a maintainer's new entry is deleted again. A project writer who
// does not maintain the vocabulary may not delete it, and a delete can fail
// too: then the entry stays, and the retry links to it instead of making a
// second one spelled the same.
import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';
import { forgetAllLeftovers } from './leftoverEntries.js';

const WRITER = { id: 'wren@example.com' };
const MAINTAINER = { id: 'mara@example.com' };
const MAINTAINERS = [MAINTAINER.id];

// A fake core that keeps the entries it made, so the reload after a refused
// link reads them back. It refuses the next `failNext` link writes, an entry
// delete by `user` when they do not maintain the vocabulary, as core does,
// and any delete when `deleteFails` is set.
const server = (user = WRITER) => {
  const client = makeFakeClient();
  const items = [{ id: 'vi-1', form: 'CAT', metadata: {} }];
  const state = { failNext: 0, deleteFails: false };
  const create = client.vocabItems.create;
  client.vocabItems.create = (vocabId, form, metadata) => {
    const res = create(vocabId, form, metadata);
    items.push({ id: res.id, form, metadata: metadata || {} });
    return res;
  };
  client.vocabItems.delete = (id) => {
    client.calls.push({ kind: 'vocabItems.delete', args: [id] });
    if (!MAINTAINERS.includes(user.id))
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    if (state.deleteFails) throw new TypeError('Failed to fetch');
    items.splice(
      items.findIndex((i) => i.id === id),
      1,
    );
    return {};
  };
  const refuse = (fn) => {
    if (state.failNext > 0) {
      state.failNext -= 1;
      throw Object.assign(new Error('Conflict'), { status: 409 });
    }
    return fn();
  };
  const linkCreate = client.vocabLinks.create;
  client.vocabLinks.create = (...args) => refuse(() => linkCreate(...args));
  const batched = client.batched.bind(client);
  client.batched = (fn) => refuse(() => batched(fn));
  client.vocabLayers.get = async (id) => ({
    id,
    name: 'Lexicon',
    maintainers: MAINTAINERS,
    items: items.map((i) => ({ ...i })),
  });
  return { client, items, state };
};

const makeDoc = (client, user = WRITER) =>
  new IgtDocument({
    raw: buildRawDoc(),
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
    vocabularies: {
      v1: {
        id: 'v1',
        name: 'Lexicon',
        maintainers: MAINTAINERS,
        items: [{ id: 'vi-1', form: 'CAT', metadata: {} }],
        vocabLinks: [],
      },
    },
    client,
    projectId: 'proj-1',
    user,
  });

const count = (client, kind) => client.calls.filter((c) => c.kind === kind).length;
const forms = (doc, form) => doc.vocabularies.v1.items.filter((i) => i.form === form);
const word = (doc, i) => doc.sentences[0].tokens[i];

beforeEach(() => {
  resetIds();
  forgetAllLeftovers();
});

describe('a retried "+ Create" after a refused link', () => {
  it('links the word to the entry the first try made', async () => {
    const { client, items, state } = server();
    const doc = makeDoc(client);
    state.failNext = 1;
    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'kai')).toBe(false);
    expect(items.filter((i) => i.form === 'kai')).toHaveLength(1);
    expect(forms(doc, 'kai')).toHaveLength(1);
    expect(word(doc, 0).vocabItem).toBeFalsy();

    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'kai')).toBe(true);
    expect(count(client, 'vocabItems.create')).toBe(1);
    expect(count(client, 'vocabItems.delete')).toBe(0);
    expect(items.filter((i) => i.form === 'kai')).toHaveLength(1);
    const kai = items.find((i) => i.form === 'kai').id;
    expect(forms(doc, 'kai').map((i) => i.id)).toEqual([kai]);
    expect(word(doc, 0).vocabItem?.id).toBe(kai);
    const link = client.calls.filter((c) => c.kind === 'vocabLinks.create').at(-1);
    expect(link.args[0]).toBe(kai);
  });

  it('shows the retry on the entry at once, with no second entry', async () => {
    const { client, state } = server();
    const doc = makeDoc(client);
    state.failNext = 1;
    await doc.createAndLinkVocabItem('w-1', 'v1', 'kai');
    const kai = forms(doc, 'kai')[0].id;
    const retry = doc.createAndLinkVocabItem('w-1', 'v1', 'kai');
    expect(forms(doc, 'kai').map((i) => i.id)).toEqual([kai]);
    expect(word(doc, 0).vocabItem?.id).toBe(kai);
    expect(await retry).toBe(true);
  });

  it('links the other words read the same to that entry too', async () => {
    const { client, items, state } = server();
    const doc = makeDoc(client);
    state.failNext = 1;
    await doc.createAndLinkVocabItem('w-1', 'v1', 'the', {}, { alsoLink: ['w-2'] });
    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'the', {}, { alsoLink: ['w-2'] })).toBe(
      true,
    );
    expect(items.filter((i) => i.form === 'the')).toHaveLength(1);
    const the = items.find((i) => i.form === 'the').id;
    expect(word(doc, 0).vocabItem?.id).toBe(the);
    expect(word(doc, 1).vocabItem?.id).toBe(the);
  });

  it('keeps the entry for a second retry when the first retry fails too', async () => {
    const { client, items, state } = server();
    const doc = makeDoc(client);
    state.failNext = 2;
    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'kai')).toBe(false);
    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'kai')).toBe(false);
    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'kai')).toBe(true);
    expect(items.filter((i) => i.form === 'kai')).toHaveLength(1);
  });

  it('makes a new entry for another form', async () => {
    const { client, items, state } = server();
    const doc = makeDoc(client);
    state.failNext = 1;
    await doc.createAndLinkVocabItem('w-1', 'v1', 'kai');
    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'kaa')).toBe(true);
    expect(items.map((i) => i.form)).toEqual(['CAT', 'kai', 'kaa']);
  });

  it('makes a new entry once the first one has been linked by picking it', async () => {
    const { client, items, state } = server();
    const doc = makeDoc(client);
    state.failNext = 1;
    await doc.createAndLinkVocabItem('w-1', 'v1', 'kai');
    const kai = forms(doc, 'kai')[0].id;
    expect(await doc.linkVocab('w-1', kai)).toBe(true);
    expect(await doc.createAndLinkVocabItem('w-2', 'v1', 'kai')).toBe(true);
    expect(items.filter((i) => i.form === 'kai')).toHaveLength(2);
  });

  it('makes a new entry once the retry has landed', async () => {
    const { client, items, state } = server();
    const doc = makeDoc(client);
    state.failNext = 1;
    await doc.createAndLinkVocabItem('w-1', 'v1', 'kai');
    await doc.createAndLinkVocabItem('w-1', 'v1', 'kai');
    expect(await doc.createAndLinkVocabItem('w-2', 'v1', 'kai')).toBe(true);
    expect(items.filter((i) => i.form === 'kai')).toHaveLength(2);
  });

  it('makes a new entry when the first one was renamed since', async () => {
    const { client, items, state } = server();
    const doc = makeDoc(client);
    state.failNext = 1;
    await doc.createAndLinkVocabItem('w-1', 'v1', 'kai');
    items.find((i) => i.form === 'kai').form = 'kaj';
    await doc.reload();
    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'kai')).toBe(true);
    expect(items.map((i) => i.form)).toEqual(['CAT', 'kaj', 'kai']);
  });
});

describe('a retried "+ Create" of a multi-word expression', () => {
  it('links the words to the entry the first try made', async () => {
    const { client, items, state } = server();
    const doc = makeDoc(client);
    state.failNext = 1;
    const meta = { morphType: 'phrase' };
    expect(await doc.createAndLinkMwe(['w-1', 'w-2'], 'v1', 'the cat', meta)).toBe(false);
    expect(await doc.createAndLinkMwe(['w-1', 'w-2'], 'v1', 'the cat', meta)).toBe(true);
    expect(count(client, 'vocabItems.create')).toBe(1);
    const phrase = items.filter((i) => i.form === 'the cat');
    expect(phrase).toHaveLength(1);
    expect(forms(doc, 'the cat').map((i) => i.id)).toEqual([phrase[0].id]);
    expect(doc.sentences[0].mwes.map((m) => m.item.id)).toEqual([phrase[0].id]);
  });

  it('makes a new entry for a word that asks for the same form', async () => {
    const { client, items, state } = server();
    const doc = makeDoc(client);
    state.failNext = 1;
    await doc.createAndLinkMwe(['w-1', 'w-2'], 'v1', 'the cat', { morphType: 'phrase' });
    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'the cat')).toBe(true);
    expect(items.filter((i) => i.form === 'the cat')).toHaveLength(2);
  });
});

describe('a refused "+ Create" by a maintainer of the vocabulary', () => {
  it('deletes the new entry, and the retry makes it again', async () => {
    const { client, items, state } = server(MAINTAINER);
    const doc = makeDoc(client, MAINTAINER);
    state.failNext = 1;
    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'kai')).toBe(false);
    expect(count(client, 'vocabItems.delete')).toBe(1);
    expect(items.filter((i) => i.form === 'kai')).toHaveLength(0);
    expect(forms(doc, 'kai')).toHaveLength(0);
    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'kai')).toBe(true);
    const kai = items.filter((i) => i.form === 'kai');
    expect(kai).toHaveLength(1);
    expect(word(doc, 0).vocabItem?.id).toBe(kai[0].id);
  });

  it('links the retry to the entry when the delete failed too', async () => {
    const { client, items, state } = server(MAINTAINER);
    const doc = makeDoc(client, MAINTAINER);
    state.failNext = 1;
    state.deleteFails = true;
    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'kai')).toBe(false);
    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'kai')).toBe(true);
    const kai = items.filter((i) => i.form === 'kai');
    expect(kai).toHaveLength(1);
    expect(word(doc, 0).vocabItem?.id).toBe(kai[0].id);
    expect(count(client, 'vocabItems.delete')).toBe(1);
  });

  it('deletes a new multi-word expression entry too', async () => {
    const { client, items, state } = server(MAINTAINER);
    const doc = makeDoc(client, MAINTAINER);
    state.failNext = 1;
    const meta = { morphType: 'phrase' };
    expect(await doc.createAndLinkMwe(['w-1', 'w-2'], 'v1', 'the cat', meta)).toBe(false);
    expect(items.filter((i) => i.form === 'the cat')).toHaveLength(0);
    expect(await doc.createAndLinkMwe(['w-1', 'w-2'], 'v1', 'the cat', meta)).toBe(true);
    expect(items.filter((i) => i.form === 'the cat')).toHaveLength(1);
  });

  it('never deletes an entry the retry reused', async () => {
    const { client, items, state } = server(MAINTAINER);
    const doc = makeDoc(client, MAINTAINER);
    state.failNext = 2;
    state.deleteFails = true;
    await doc.createAndLinkVocabItem('w-1', 'v1', 'kai');
    state.deleteFails = false;
    expect(await doc.createAndLinkVocabItem('w-1', 'v1', 'kai')).toBe(false);
    expect(count(client, 'vocabItems.delete')).toBe(1);
    expect(items.filter((i) => i.form === 'kai')).toHaveLength(1);
  });
});
