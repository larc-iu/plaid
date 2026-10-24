// The text layer UMR reads is the one with the baseline role, and only that
// one: a project whose text layers carry no role is not set up for UMR,
// rather than read through whichever layer the server lists first
// (R2-RULES-7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getUmrLayerInfo } from '../src/utils/umrLayerUtils.js';

test('a text layer with no role is not the baseline', () => {
  const info = getUmrLayerInfo({ textLayers: [{ id: 't1', config: {}, tokenLayers: [] }] });
  assert.equal(info.textLayer, null);
  assert.ok(info.missingLayers.includes('textLayer'));
  assert.equal(info.isConfigured, false);
});

test('the baseline is found by its role wherever it is listed', () => {
  const info = getUmrLayerInfo({
    textLayers: [
      { id: 't1', config: {}, tokenLayers: [] },
      { id: 't2', config: { plaid: { role: 'baseline' } }, tokenLayers: [] },
    ],
  });
  assert.equal(info.textLayer.id, 't2');
});
