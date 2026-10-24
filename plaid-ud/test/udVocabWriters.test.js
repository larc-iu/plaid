// ud's vocabulary config is read and written only through udVocab.js (and
// udVocabMode.js beside it), so a stored shape lives in one place (R4-6-3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  vocabCells,
  withAddedValues,
  readFeatureInventory,
  readVocab,
} from '../src/utils/udVocab.js';
import { UPOS_DESCRIPTIONS } from '../src/utils/udVocabDescriptions.js';

const info = {
  xposLayer: { id: 'x' },
  relationLayer: { id: 'r' },
  uposLayer: { id: 'u' },
  featuresLayer: { id: 'f' },
};
const drafts = {
  xposVocab: ['NN'],
  deprelVocab: ['nsubj'],
  uposVocab: ['NOUN'],
  deprelColors: { nsubj: '#111111', obj: '' },
  uposColors: {},
  featureInventory: [
    { key: ' Case ', values: [' Nom', '', 'Acc'] },
    { key: ' ', values: ['x'] },
  ],
  modes: { upos: 'closed' },
  descriptions: { upos: { ...UPOS_DESCRIPTIONS, NOUN: 'a thing' }, xpos: { NN: ' noun ' } },
};

test('the settings cells are the shapes the readers read', () => {
  const cells = vocabCells(info, drafts);
  const at = (id, key) => cells.find((c) => c.entity.id === id && c.key === key)?.value;
  assert.deepEqual(at('x', 'vocab'), ['NN']);
  assert.equal(at('x', 'vocabMode'), 'open');
  assert.deepEqual(at('x', 'vocabDescriptions'), { NN: 'noun' });
  assert.deepEqual(at('r', 'colors'), { nsubj: '#111111' });
  assert.equal(at('u', 'vocabMode'), 'closed');
  // Only what differs from the shipped definitions is stored.
  assert.deepEqual(at('u', 'vocabDescriptions'), { NOUN: 'a thing' });
  assert.deepEqual(at('f', 'inventory'), [{ key: 'Case', values: ['Nom', 'Acc'] }]);
  const config = { ud: { inventory: at('f', 'inventory'), vocab: at('x', 'vocab') } };
  assert.deepEqual(readFeatureInventory(config).map.get('Case'), ['Nom', 'Acc']);
  assert.deepEqual(readVocab(config), ['NN']);
  assert.deepEqual([...new Set(cells.map((c) => c.bundle))].sort(), [
    'relationLayers',
    'spanLayers',
  ]);
  // A layer the project lacks writes nothing.
  assert.deepEqual(
    vocabCells({ uposLayer: { id: 'u' } }, drafts).map((c) => c.entity.id),
    ['u', 'u', 'u', 'u'],
  );
});

test('adding off-list values merges them into the list or the inventory', () => {
  const layerInfo = {
    ...info,
    vocab: {
      deprel: ['nsubj'],
      featureInventory: { list: [{ key: 'Case', values: ['Nom'] }] },
    },
  };
  assert.deepEqual(
    withAddedValues(layerInfo, {
      key: 'deprel',
      layer: 'relationLayer',
      kind: 'relation',
      values: [{ value: 'obj' }, { value: 'nsubj' }],
    }),
    { bundle: 'relationLayers', entity: { id: 'r' }, key: 'vocab', value: ['nsubj', 'obj'] },
  );
  assert.deepEqual(
    withAddedValues(layerInfo, {
      key: 'feats',
      layer: 'featuresLayer',
      kind: 'feats',
      features: [
        { key: 'Case', values: [{ value: 'Acc' }] },
        { key: 'Number', values: [{ value: 'Sing' }] },
      ],
    }),
    {
      bundle: 'spanLayers',
      entity: { id: 'f' },
      key: 'inventory',
      value: [
        { key: 'Case', values: ['Nom', 'Acc'] },
        { key: 'Number', values: ['Sing'] },
      ],
    },
  );
  // The stored inventory is not changed in place.
  assert.deepEqual(layerInfo.vocab.featureInventory.list, [{ key: 'Case', values: ['Nom'] }]);
});

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(js|jsx)$/.test(f) && !/\.test\.jsx?$/.test(f) ? [p] : [];
  });

test('no other source spells a vocabulary config key', () => {
  const found = [];
  for (const file of walk(SRC)) {
    if (/\/utils\/udVocab(Mode)?\.js$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/'(vocab|inventory|colors|vocabMode|vocabDescriptions)'/g))
      found.push(`${file.slice(SRC.length + 1)}: ${m[0]}`);
  }
  assert.deepEqual(found, []);
});
