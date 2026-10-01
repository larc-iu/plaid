// ud's word layer splits a word a space is typed inside (Luke, 2026-09-30):
// it declares `splitOnSpace`. A project made before the key existed picks it
// up on a maintainer's open, naming what the page read, and a declaration
// another page made first stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAID_NAMESPACE, SPLIT_ON_SPACE_KEY } from '@larc-iu/plaid-client';

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
    tokenLayers: {
      setConfig: async (id, ns, key, value, _msg, options) => {
        sent.push({ id, ns, key, value, options });
        if (
          options &&
          'expected' in options &&
          canonical(options.expected) !== canonical(stored[`${id}.${key}`])
        ) {
          throw Object.assign(new Error('Conflict'), { status: 409 });
        }
        stored[`${id}.${key}`] = value;
        return { status: 200 };
      },
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

test("a maintainer's open declares the key on the word layer, naming what it read", async () => {
  const { doc, sent, stored } = setup();
  const words = doc.layerInfo.wordTokenLayer;
  await doc._backfillSplitOnSpace(doc.layerInfo);
  assert.deepEqual(
    sent.map(({ id, ns, key, value, options }) => [id, ns, key, value, options]),
    [[words.id, PLAID_NAMESPACE, SPLIT_ON_SPACE_KEY, true, { expected: undefined }]],
  );
  assert.equal(stored[`${words.id}.${SPLIT_ON_SPACE_KEY}`], true);
});

test('a word layer that declares it is left alone', async () => {
  const { doc, sent } = setup();
  const words = doc.layerInfo.wordTokenLayer;
  words.config = { ...words.config, plaid: { ...words.config?.plaid, [SPLIT_ON_SPACE_KEY]: true } };
  await doc._backfillSplitOnSpace(doc.layerInfo);
  assert.deepEqual(sent, []);
});

test('a declaration another page made first stands', async () => {
  const { doc, stored } = setup();
  const words = doc.layerInfo.wordTokenLayer;
  stored[`${words.id}.${SPLIT_ON_SPACE_KEY}`] = false;
  await doc._backfillSplitOnSpace(doc.layerInfo);
  assert.equal(stored[`${words.id}.${SPLIT_ON_SPACE_KEY}`], false);
});

test('a writer who is not a maintainer declares nothing', async () => {
  const { doc, sent } = setup({ user: 'w@x' });
  await doc._backfillSplitOnSpace(doc.layerInfo);
  assert.deepEqual(sent, []);
});
