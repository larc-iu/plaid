// The new project is made under an id the dialog mints and keeps across
// presses (createOnce.js), so an answer lost past the client's resends leaves
// no project nobody deletes, and the next press does not make a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUmrProject } from '../src/domain/umrProjectSetup.js';

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const lost = () => Object.assign(new Error('Failed to fetch'), { status: 0 });
const idTaken = () =>
  Object.assign(new Error('HTTP 409'), { status: 409, responseData: { error: 'id-taken' } });

// A client whose project create answers with `answer(id)`, recording the ids
// it was sent, what was deleted and which project the batch wrote under.
function fakeClient(answer, { deleteFails = false } = {}) {
  const seen = { created: [], deleted: [], batchedUnder: [] };
  const queue = new Proxy(
    {},
    {
      get: (_, bundle) =>
        new Proxy(
          {},
          {
            get:
              (_b, op) =>
              (...args) => {
                if (bundle === 'textLayers' && op === 'create') seen.batchedUnder.push(args[0]);
              },
          },
        ),
    },
  );
  const client = {
    withOperation: (_label, fn) => fn(),
    projects: {
      create: async (name, _audit, opts) => {
        seen.created.push(opts?.id);
        return answer(opts?.id);
      },
      delete: async (id) => {
        seen.deleted.push(id);
        if (deleteFails) throw Object.assign(new Error('HTTP 403'), { status: 403 });
      },
    },
    batched: async (fn) => fn(queue),
  };
  return { client, seen };
}

test('the create names a minted UUIDv7', async () => {
  const { client, seen } = fakeClient((id) => ({ id }));
  const made = await createUmrProject(client, 'New');
  assert.match(seen.created[0], UUIDV7);
  assert.equal(made.id, seen.created[0]);
  assert.deepEqual(seen.batchedUnder, [seen.created[0]]);
});

test('a lost answer is rolled back by its id, and the next press sends the same id', async () => {
  const mint = { current: null };
  const first = fakeClient(
    () => {
      throw lost();
    },
    { deleteFails: true },
  );
  await assert.rejects(createUmrProject(first.client, 'New', mint), /Failed to fetch/);
  assert.deepEqual(first.seen.deleted, first.seen.created, 'the rollback names the minted id');

  const second = fakeClient(() => {
    throw idTaken();
  });
  const made = await createUmrProject(second.client, 'New', mint);
  assert.equal(second.seen.created[0], first.seen.created[0]);
  assert.equal(made.id, first.seen.created[0]);
  assert.deepEqual(second.seen.batchedUnder, [first.seen.created[0]]);
  assert.deepEqual(second.seen.deleted, []);
});

test('a lost answer after a re-mint rolls back the id the create was last sent', async () => {
  // The first id names a deleted project, so createOnce mints a second and
  // sends again, and that answer is lost.
  const answers = [
    () => {
      throw Object.assign(idTaken(), { responseData: { error: 'id-taken', deleted: true } });
    },
    () => {
      throw lost();
    },
  ];
  const { client, seen } = fakeClient(() => answers.shift()(), { deleteFails: true });
  await assert.rejects(createUmrProject(client, 'New', { current: null }), /Failed to fetch/);
  assert.equal(seen.created.length, 2);
  assert.deepEqual(seen.deleted, [seen.created[1]]);
});
