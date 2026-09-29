// "+ Create" makes an entry and links the words to it in one batch: the link
// names the entry by the batch's stand-in for its id ({ $ref }), so a refused
// link leaves no entry behind, and pressing "+ Create" again makes exactly one.
// The same holds for the morpheme an unanalyzed word needs before anything can
// point at it.
import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';

const WRITER = { id: 'wren@example.com' };

// A fake core that applies a batch whole or not at all: it refuses the next
// `failNext` batches with a 409, and keeps the entries a batch that lands made,
// so the reload after a refusal reads back exactly what was stored.
const server = () => {
  const client = makeFakeClient();
  const items = [{ id: 'vi-1', form: 'CAT', metadata: {} }];
  const state = { failNext: 0 };
  const batched = client.batched.bind(client);
  client.batched = async (fn) => {
    const made = [];
    const results = await batched(async (b) => {
      const create = b.vocabItems.create;
      b.vocabItems = {
        ...b.vocabItems,
        create: (vocabId, form, metadata) => {
          made.push({ at: b.operations.length, form, metadata });
          return create(vocabId, form, metadata);
        },
      };
      await fn(b);
    });
    if (state.failNext > 0) {
      state.failNext -= 1;
      throw Object.assign(new Error('Conflict'), { status: 409 });
    }
    made.forEach((m) =>
      items.push({ id: results[m.at].body.id, form: m.form, metadata: m.metadata || {} }),
    );
    return results;
  };
  client.projects.get = async () => PROJECT();
  client.vocabLayers.get = async (id) => ({
    id,
    name: 'Lexicon',
    maintainers: [],
    items: items.map((i) => ({ ...i })),
  });
  return { client, items, state };
};

const PROJECT = () => ({ id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } });

const makeDoc = (client, raw = buildRawDoc()) =>
  new IgtDocument({
    raw,
    project: PROJECT(),
    vocabularies: {
      v1: {
        id: 'v1',
        name: 'Lexicon',
        maintainers: [],
        items: [{ id: 'vi-1', form: 'CAT', metadata: {} }],
        vocabLinks: [],
      },
    },
    client,
    projectId: 'proj-1',
    user: WRITER,
  });

const calls = (client, kind) => client.calls.filter((c) => c.kind === kind);
const forms = (doc, form) => doc.vocabularies.v1.items.filter((i) => i.form === form);
const word = (doc, i) => doc.sentences[0].tokens[i];

beforeEach(() => resetIds());

describe('"+ Create"', () => {
  it('sends the entry and its link in one batch, the link naming the entry by reference', async () => {
    const { client } = server();
    const doc = makeDoc(client);
    expect(await doc.createAndLinkVocabItem('m-1', 'v1', 'kai')).toBe(true);

    expect(calls(client, 'batch.submit')).toHaveLength(1);
    const [link] = calls(client, 'vocabLinks.create');
    expect(link.args[0]).toEqual({ $ref: 0 });
    expect(link.args[1]).toEqual(['m-1']);
    // Both carry the server's ids once it answers.
    const kai = forms(doc, 'kai')[0];
    expect(kai.id.startsWith('vitem')).toBe(true);
    expect(word(doc, 0).morphemes[0].vocabItem?.id).toBe(kai.id);
  });

  it('refused, leaves no entry behind, and pressed again makes exactly one', async () => {
    const { client, items, state } = server();
    const doc = makeDoc(client);
    state.failNext = 1;
    expect(await doc.createAndLinkVocabItem('m-1', 'v1', 'kai')).toBe(false);
    expect(items.filter((i) => i.form === 'kai')).toHaveLength(0);
    expect(forms(doc, 'kai')).toHaveLength(0);
    expect(calls(client, 'vocabItems.delete')).toHaveLength(0);

    expect(await doc.createAndLinkVocabItem('m-1', 'v1', 'kai')).toBe(true);
    expect(items.filter((i) => i.form === 'kai')).toHaveLength(1);
    expect(forms(doc, 'kai')).toHaveLength(1);
  });

  it('on a word nobody has analyzed makes its morpheme in the same batch', async () => {
    const { client } = server();
    const doc = makeDoc(client, buildRawDoc({ morphemes: [] }));
    expect(await doc.createAndLinkVocabItem('virtual:w-1', 'v1', 'kai')).toBe(true);

    expect(calls(client, 'batch.submit')).toHaveLength(1);
    const order = client.calls.map((c) => c.kind).filter((k) => k !== 'beginOperation');
    expect(order.slice(0, 4)).toEqual([
      'tokens.create',
      'vocabItems.create',
      'vocabLinks.create',
      'batch.submit',
    ]);
    const [link] = calls(client, 'vocabLinks.create');
    expect(link.args[0]).toEqual({ $ref: 1 });
    expect(link.args[1]).toEqual([{ $ref: 0 }]);
    const m = word(doc, 0).morphemes[0];
    expect(m.virtual).toBeUndefined();
    expect(m.id.startsWith('tok')).toBe(true);
    expect(m.vocabItem?.form).toBe('kai');
  });

  it('for a multi-word expression sends the entry and its link in one batch', async () => {
    const { client } = server();
    const doc = makeDoc(client);
    expect(
      await doc.createAndLinkMwe(['w-1', 'w-2'], 'v1', 'the cat', { morphType: 'phrase' }),
    ).toBe(true);
    expect(calls(client, 'batch.submit')).toHaveLength(1);
    const [link] = calls(client, 'vocabLinks.create');
    expect(link.args[0]).toEqual({ $ref: 0 });
    expect(link.args[1]).toEqual(['w-1', 'w-2']);
  });
});

describe('linking an existing entry to a word nobody has analyzed', () => {
  it('makes the morpheme and the link in one batch', async () => {
    const { client } = server();
    const doc = makeDoc(client, buildRawDoc({ morphemes: [] }));
    expect(await doc.linkVocab('virtual:w-1', 'vi-1')).toBe(true);
    expect(calls(client, 'batch.submit')).toHaveLength(1);
    const [link] = calls(client, 'vocabLinks.create');
    expect(link.args).toEqual(['vi-1', [{ $ref: 0 }], undefined]);
    expect(word(doc, 0).morphemes[0].vocabItem?.id).toBe('vi-1');
  });

  it('together with the others that read the same, in one batch', async () => {
    const { client } = server();
    const doc = makeDoc(
      client,
      buildRawDoc({
        body: 'cat cat',
        morphemes: [],
        words: [
          { id: 'w-1', begin: 0, end: 3 },
          { id: 'w-2', begin: 4, end: 7 },
        ],
      }),
    );
    expect(await doc.linkVocabMany(['virtual:w-1', 'virtual:w-2'], 'vi-1')).toBe(true);
    expect(calls(client, 'batch.submit')).toHaveLength(1);
    const [bulk] = calls(client, 'vocabLinks.bulkCreate');
    expect(bulk.args[0].map((l) => l.tokens)).toEqual([
      [{ $ref: 0, index: 0 }],
      [{ $ref: 0, index: 1 }],
    ]);
    expect(word(doc, 0).morphemes[0].vocabItem?.id).toBe('vi-1');
    expect(word(doc, 1).morphemes[0].vocabItem?.id).toBe('vi-1');
  });
});
