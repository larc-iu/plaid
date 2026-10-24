// Setup and adopting a substrate write the project's gloss lines
// (config.umr.ilg), in the batch that makes the layers: nothing reads the
// lines from layer names afterwards (domain/ilg.js resolveIlg).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptSubstrate, createUmrProject } from '../src/domain/umrProjectSetup.js';
import { resolveIlg } from '../src/domain/ilg.js';

// Records every call a batch queues, by its dotted name. `projects.get`
// answers the project as the server holds it (`stored`).
function fakeClient(stored = null) {
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
    projects: {
      create: async (name) => ({ id: 'p1', name }),
      get: async (id) => {
        calls.push({ name: 'projects.get', args: [id] });
        return structuredClone(stored);
      },
    },
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

// An IGT project's layers: the gloss on morphemes in English, a note on words.
const substrate = (id, config = {}, wordConfig = {}) => ({
  id,
  config,
  textLayers: [
    {
      id: 't',
      config: { plaid: { role: 'baseline' } },
      tokenLayers: [
        { id: 's', config: { plaid: { role: 'sentence' } }, spanLayers: [] },
        {
          id: 'w',
          config: { plaid: { role: 'word', ...wordConfig } },
          spanLayers: [{ id: 'n', name: 'Notes', config: {} }],
        },
        {
          id: 'm',
          config: { plaid: { role: 'morpheme' } },
          spanLayers: [{ id: 'g', name: 'Gloss', config: { igt: { lang: 'en' } } }],
        },
      ],
    },
  ],
});

// The page's copy of a project: only its id is read.
const page = (id) => ({ id, config: {}, textLayers: [] });

test('adopting a substrate writes the lines its layers propose', async () => {
  const client = fakeClient(substrate('p2'));
  await adoptSubstrate(client, page('p2'));
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
  const mine = [{ header: 'word-gloss', lang: 'fr', source: 'layer:n' }];
  const client = fakeClient(substrate('p3', { umr: { ilg: mine } }));
  const created = await adoptSubstrate(client, page('p3'));
  assert.equal(ilgWrites(client.calls).length, 0);
  assert.equal(created, true);
});

test('a project with no lines set shows none, whatever its layers are called', () => {
  assert.deepEqual(resolveIlg(null), []);
  assert.deepEqual(resolveIlg(undefined), []);
});

// R8 (Luke 2026-10-24): every app's setup has a space typed inside a word of
// the shared word layer split it.
const splitWrites = (calls) =>
  calls.filter(
    (c) =>
      c.name === 'tokenLayers.setConfig' && c.args[1] === 'plaid' && c.args[2] === 'splitOnSpace',
  );

test('a new UMR project and an adopted word layer split a word at a typed space', async () => {
  const made = fakeClient();
  await createUmrProject(made, 'New');
  assert.equal(splitWrites(made.calls).length, 1);
  assert.equal(splitWrites(made.calls)[0].args[3], true);

  const adopted = fakeClient(substrate('p4'));
  await adoptSubstrate(adopted, page('p4'));
  assert.deepEqual(
    splitWrites(adopted.calls).map((c) => c.args),
    [['w', 'plaid', 'splitOnSpace', true]],
  );

  const already = fakeClient(substrate('p5', {}, { splitOnSpace: true }));
  await adoptSubstrate(already, page('p5'));
  assert.equal(splitWrites(already.calls).length, 0);
});

// R4-4-1: "Set up for UMR" plans from the project as it is when the button is
// pressed, never from the page's copy, as ud's does (adoptSubstrate.test.js
// there). A second press from a page loaded before the first set-up made a
// second set of UMR layers that no screen can delete.
test('a set-up from a stale page adds nothing the project has since gained', async () => {
  const first = fakeClient(substrate('p6'));
  await adoptSubstrate(first, page('p6'));
  // The project as the first set-up left it: its layers, flags and lines.
  const stored = substrate(
    'p6',
    {
      umr: { ilg: ilgWrites(first.calls)[0].args[3] },
    },
    { splitOnSpace: true },
  );
  const created = first.calls.filter((c) => c.name === 'tokenLayers.create');
  assert.equal(created.length, 1);
  const nodeLayer = {
    id: 'nodes',
    config: { umr: { nodes: true } },
    spanLayers: [
      {
        id: 'concepts',
        config: { umr: { concepts: true } },
        relationLayers: [
          { id: 'rel', config: { umr: { relations: true } } },
          { id: 'dg', config: { umr: { documentGraph: true } } },
        ],
      },
    ],
  };
  stored.textLayers[0].tokenLayers.push(nodeLayer);

  const second = fakeClient(stored);
  // The page still holds the project as it was before the first set-up.
  assert.equal(await adoptSubstrate(second, substrate('p6')), false);
  assert.equal(second.calls[0].name, 'projects.get', 'reads the project before planning');
  assert.deepEqual(
    second.calls.filter((c) => /\.create$|setConfig$/.test(c.name)),
    [],
  );
});
