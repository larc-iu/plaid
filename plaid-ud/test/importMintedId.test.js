// A CoNLL-U import creates its document under an id minted here, kept across
// imports of the same file, so an import made again after a create whose
// answer was lost goes on into the document the first made (A3-5).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';
import { withOps } from './helpers/stubClient.js';

const INPUT = [
  '# text = Dogs bark',
  '1\tDogs\tdog\tNOUN\t_\t_\t2\tnsubj\t_\t_',
  '2\tbark\tbark\tVERB\t_\t_\t0\troot\t_\t_',
  '',
].join('\n');

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A server holding the documents made, whose first create answer is lost
// when `loseFirst` is set (the document is made, the answer never comes).
function serverClient({ loseFirst = false } = {}) {
  const made = new Map();
  const creates = [];
  let lose = loseFirst;
  return withOps({
    made,
    creates,
    documents: {
      create: async (projectId, name, _m, _a, opts) => {
        creates.push(opts?.id);
        if (!opts?.id) throw new Error('a create names its id');
        if (made.has(opts.id)) {
          throw Object.assign(new Error('id-taken'), {
            status: 409,
            responseData: { error: 'id-taken', deleted: false },
          });
        }
        // The first free name, as the server picks it under free-name.
        const taken = new Set(made.values());
        let stored = name;
        for (let k = 2; taken.has(stored); k += 1) stored = `${name} (${k})`;
        made.set(opts.id, stored);
        if (lose) {
          lose = false;
          throw Object.assign(new Error('no answer'), { status: 0 });
        }
        return { id: opts.id, name: stored };
      },
      get: async () => {
        throw new Error('the layer info is precomputed');
      },
      delete: async (id) => made.delete(id),
    },
    batched: async (fn) => {
      const queued = [];
      const queue = (kind, ops) => queued.push({ kind, ops });
      await fn({
        texts: { create: () => queued.push({ kind: 'texts', ops: [] }) },
        tokens: { bulkCreate: (ops) => queue('tokens', ops) },
        spans: { bulkCreate: (ops) => queue('spans', ops) },
        relations: { bulkCreate: (ops) => queue('relations', ops) },
      });
      return queued.map(({ kind, ops }) => ({ body: { ids: ops.map((_, i) => `${kind}-${i}`) } }));
    },
  });
}

const info = getUdLayerInfo(rawDocFromConllu(INPUT, 'm'));

test('the document is created under a minted UUIDv7', async () => {
  const client = serverClient();
  const out = await ConlluDocument.importFromConllu(client, 'p1', 'm', INPUT, info);
  assert.equal(client.creates.length, 1);
  assert.match(client.creates[0], UUID7);
  assert.equal(out.documentId, client.creates[0]);
});

// Every caller's import is one operation of kind import, labelled with the
// document, not only the import page's (R2-IO-11).
test('the import labels its own operation', async () => {
  const client = serverClient();
  await ConlluDocument.importFromConllu(client, 'p1', 'm', INPUT, info);
  assert.deepEqual(client.operations, [
    { message: 'Import CoNLL-U document "m"', kind: 'import', ref: 'format:conllu' },
  ]);
});

test('an import made again after a lost create answer goes on into the same document', async () => {
  const client = serverClient({ loseFirst: true });
  const mint = { current: null };
  await assert.rejects(ConlluDocument.importFromConllu(client, 'p1', 'm', INPUT, info, { mint }));
  const out = await ConlluDocument.importFromConllu(client, 'p1', 'm', INPUT, info, { mint });
  assert.equal(client.creates.length, 2);
  assert.equal(client.creates[0], client.creates[1]);
  assert.equal(out.documentId, client.creates[0]);
  assert.deepEqual([...client.made.keys()], [out.documentId]);
});

// LP2-6: a name another document holds is stored as "Name (2)", and the import
// result names the document by the name it was stored under.
test('the import answers the name the server stored', async () => {
  const client = serverClient();
  const first = await ConlluDocument.importFromConllu(client, 'p1', 'fr1', INPUT, info);
  const second = await ConlluDocument.importFromConllu(client, 'p1', 'fr1', INPUT, info);
  assert.equal(first.name, 'fr1');
  assert.equal(second.name, 'fr1 (2)');
});
