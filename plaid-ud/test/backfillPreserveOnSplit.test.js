// The repair on open declares which metadata keys survive a split, on each
// token layer that lacks them. The write is made from the copy of the layer
// the page loaded, so written whole and unchecked it dropped keys another app
// had declared, and wrote over a save made after the page loaded (W-IGT2's
// note, the same fix as igt's f43ee993). It now adds only the missing keys to
// what the layer declared, names that as `expected`, and lets a 409 go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAID_NAMESPACE, PRESERVE_ON_SPLIT_KEY, PROVENANCE_KEYS } from '@larc-iu/plaid-client';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const INPUT = [
  '# text = el perro',
  '1\tel\tel\tDET\t_\t_\t2\tdet\t_\t_',
  '2\tperro\tperro\tNOUN\t_\t_\t0\troot\t_\t_',
].join('\n');

const canonical = (v) => JSON.stringify(v ?? null);

// A config store that refuses a write naming `expected` when the stored cell
// differs, as the core does.
const setup = (stored) => {
  const sent = [];
  const client = {
    tokenLayers: {
      setConfig: async (id, ns, key, value, _msg, options) => {
        sent.push({ id, value, options });
        const cell = stored[id];
        if (options && 'expected' in options && canonical(options.expected) !== canonical(cell)) {
          throw Object.assign(new Error('Conflict'), { status: 409 });
        }
        stored[id] = value;
      },
    },
  };
  const doc = new ConlluDocument({
    raw: rawDocFromConllu(INPUT, 'd1'),
    client,
    project: { id: 'p1', maintainers: ['m@x'] },
    user: { id: 'm@x' },
  });
  return { doc, sent };
};

const layersOf = (info) => [info.sentenceTokenLayer, info.wordTokenLayer, info.morphemeTokenLayer];

test('adds only the missing keys to what another app declared, and names what it read', async () => {
  const { doc, sent } = setup({});
  const info = doc.layerInfo;
  const [sentences] = layersOf(info);
  sentences.config = { [PLAID_NAMESPACE]: { [PRESERVE_ON_SPLIT_KEY]: ['otherAppKey'] } };
  await doc._backfillPreserveOnSplit(info);
  const toSentences = sent.find((w) => w.id === sentences.id);
  assert.deepEqual(toSentences.value, ['otherAppKey', ...PROVENANCE_KEYS]);
  assert.deepEqual(toSentences.options, { expected: ['otherAppKey'] });
});

test('lets a save made after the page loaded stand, and goes on to the next layer', async () => {
  const stored = {};
  const { doc, sent } = setup(stored);
  const info = doc.layerInfo;
  const [sentences, words] = layersOf(info);
  // Another maintainer declared a key on the sentence layer after this page
  // read it with nothing declared.
  stored[sentences.id] = ['savedMeanwhile'];
  await doc._backfillPreserveOnSplit(info);
  assert.deepEqual(stored[sentences.id], ['savedMeanwhile']);
  assert.deepEqual(stored[words.id], [...PROVENANCE_KEYS]);
  assert.equal(sent.length, 3);
});
