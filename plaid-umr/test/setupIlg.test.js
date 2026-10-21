// Setup and adopting a substrate write the project's gloss lines
// (config.umr.ilg), in the batch that makes the layers: nothing reads the
// lines from layer names afterwards (domain/ilg.js resolveIlg).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptSubstrate, createUmrProject } from '../src/domain/umrProjectSetup.js';
import { resolveIlg } from '../src/domain/ilg.js';

// Records every call a batch queues, by its dotted name.
function fakeClient() {
  const calls = [];
  const bundle = (name) =>
    new Proxy(
      {},
      {
        get:
          (_, op) =>
          (...args) =>
            calls.push({ name: `${name}.${op}`, args }),
      },
    );
  const b = new Proxy({}, { get: (_, name) => bundle(name) });
  return {
    calls,
    withOperation: (_label, fn) => fn(),
    projects: { create: async (name) => ({ id: 'p1', name }) },
    batched: async (fn) => fn(b),
  };
}

const ilgWrites = (calls) =>
  calls.filter(
    (c) => c.name === 'projects.setConfig' && c.args[1] === 'umr' && c.args[2] === 'ilg',
  );

test('a new UMR project is made with the lines an import stores', async () => {
  const client = fakeClient();
  await createUmrProject(client, 'New');
  const writes = ilgWrites(client.calls);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].args[0], 'p1');
  assert.deepEqual(writes[0].args[3], [{ header: null, lang: null, source: 'stored' }]);
  assert.deepEqual(writes[0].args[5], { expected: null });
});

const substrate = () => ({
  textLayer: { id: 't' },
  sentenceTokenLayer: { id: 's' },
  wordTokenLayer: { id: 'w' },
  morphemeTokenLayer: { id: 'm' },
  glossLayers: [
    { layer: { id: 'g', name: 'Gloss' }, scope: 'morpheme', lang: 'en' },
    { layer: { id: 'n', name: 'Notes' }, scope: 'word', lang: null },
  ],
});

test('adopting a substrate writes the lines its layers propose', async () => {
  const client = fakeClient();
  await adoptSubstrate(client, { id: 'p2', config: {} }, substrate());
  const writes = ilgWrites(client.calls);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].args[0], 'p2');
  assert.deepEqual(writes[0].args[3], [
    { header: 'morphemes', lang: null, source: 'morphemes' },
    { header: 'morpheme-gloss', lang: 'en', source: 'layer:g' },
    { header: null, lang: null, source: 'stored' },
  ]);
});

test('adopting keeps the lines a project already has', async () => {
  const client = fakeClient();
  const mine = [{ header: 'word-gloss', lang: 'fr', source: 'layer:n' }];
  const created = await adoptSubstrate(
    client,
    { id: 'p3', config: { umr: { ilg: mine } } },
    substrate(),
  );
  assert.equal(ilgWrites(client.calls).length, 0);
  assert.equal(created, true);
});

test('a project with no lines set shows none, whatever its layers are called', () => {
  assert.deepEqual(resolveIlg(null), []);
  assert.deepEqual(resolveIlg(undefined), []);
});
