// ud's word layer takes a text edit plainly, splitting a word a space is typed
// inside (Luke, 2026-09-30): it declares `plainEdits` and `splitOnSpace`. A
// project made before the keys existed picks them up on a maintainer's open,
// in one batch naming what the page read, so the words never take one key
// without the other, and a declaration another page made first stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAID_NAMESPACE, PLAIN_EDITS_KEY, SPLIT_ON_SPACE_KEY } from '@larc-iu/plaid-client';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const INPUT = [
  '# text = el perro',
  '1\tel\tel\tDET\t_\t_\t2\tdet\t_\t_',
  '2\tperro\tperro\tNOUN\t_\t_\t0\troot\t_\t_',
].join('\n');

const canonical = (v) => JSON.stringify(v ?? null);

const setup = ({ stored = {}, user = 'm@x' } = {}) => {
  const sent = [];
  const client = {
    batched: async (fn) => {
      const queued = [];
      await fn({ tokenLayers: { setConfig: (...args) => queued.push(args) } });
      const batch = sent.length;
      for (const [id, ns, key, value, _msg, options] of queued) {
        sent.push({ id, ns, key, value, options, batch });
        if (
          options &&
          'expected' in options &&
          canonical(options.expected) !== canonical(stored[`${id}.${key}`])
        ) {
          throw Object.assign(new Error('Conflict'), { status: 409 });
        }
      }
      for (const [id, , key, value] of queued) stored[`${id}.${key}`] = value;
      return queued.map(() => ({ status: 200 }));
    },
  };
  const doc = new ConlluDocument({
    raw: rawDocFromConllu(INPUT, 'd1'),
    client,
    project: { id: 'p1', maintainers: ['m@x'], writers: ['w@x'] },
    user: { id: user },
  });
  return { doc, sent, stored };
};

test("a maintainer's open declares both keys on the word layer in one batch, naming what it read", async () => {
  const { doc, sent, stored } = setup();
  const words = doc.layerInfo.wordTokenLayer;
  await doc._backfillPlainEdits(doc.layerInfo);
  assert.deepEqual(
    sent.map(({ id, ns, key, value, options }) => [id, ns, key, value, options]),
    [
      [words.id, PLAID_NAMESPACE, PLAIN_EDITS_KEY, true, { expected: undefined }],
      [words.id, PLAID_NAMESPACE, SPLIT_ON_SPACE_KEY, true, { expected: undefined }],
    ],
  );
  assert.equal(new Set(sent.map((s) => s.batch)).size, 1);
  assert.equal(stored[`${words.id}.${PLAIN_EDITS_KEY}`], true);
});

test('a word layer that declares both is left alone, and one that declares one gets the other', async () => {
  const { doc, sent } = setup();
  const words = doc.layerInfo.wordTokenLayer;
  words.config = { ...words.config, plaid: { ...words.config?.plaid, [PLAIN_EDITS_KEY]: true } };
  await doc._backfillPlainEdits(doc.layerInfo);
  assert.deepEqual(
    sent.map((s) => s.key),
    [SPLIT_ON_SPACE_KEY],
  );
  words.config.plaid[SPLIT_ON_SPACE_KEY] = true;
  await doc._backfillPlainEdits(doc.layerInfo);
  assert.equal(sent.length, 1);
});

test('a declaration another page made first stands, and nothing of the batch is written', async () => {
  const { doc, stored } = setup();
  const words = doc.layerInfo.wordTokenLayer;
  stored[`${words.id}.${SPLIT_ON_SPACE_KEY}`] = false;
  await doc._backfillPlainEdits(doc.layerInfo);
  assert.equal(stored[`${words.id}.${SPLIT_ON_SPACE_KEY}`], false);
  assert.equal(stored[`${words.id}.${PLAIN_EDITS_KEY}`], undefined);
});

test('a writer who is not a maintainer declares nothing', async () => {
  const { doc, sent } = setup({ user: 'w@x' });
  await doc._backfillPlainEdits(doc.layerInfo);
  assert.deepEqual(sent, []);
});
