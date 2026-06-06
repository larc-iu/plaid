/**
 * Regression tests for request key-recasing vs query string values.
 *
 * `transformRequest` recases object KEYS (camelCase <-> kebab) but must never
 * touch string VALUES (a dotted field path, a layer reference), and passes the
 * `bindings` subtree through verbatim (it is opaque). Mirrors the Python client's
 * tests/test_transforms.py. Uses Node's built-in test runner — run with `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { transformRequest } from '../src/transforms.js';

test('field-path string values are not recased; real keys are', () => {
  const out = transformRequest({
    find: ['?s'],
    where: [['span', '?s', { layer: 'pos' }],
            ['>=', '?s.metadata.caseKey', 5]],
    strictLayers: true,
  });
  assert.deepEqual(out.where[1], ['>=', '?s.metadata.caseKey', 5]); // path value verbatim
  assert.ok('strict-layers' in out && !('strictLayers' in out));    // a real key recased
});

test('layer structural slot keys recase; the layer-ref value does not', () => {
  // the slots (text-layer, parent-token-layer, token-layer, span-layer) are object
  // KEYS in a clause's constraint map, so they recase; the reference VALUE is a
  // string and is left verbatim. Clause heads are literal strings (write kebab).
  const out = transformRequest({
    find: ['?s'],
    where: [['span', '?s', { layer: '?sl' }],
            ['span-layer', '?sl', { tokenLayer: '?tl' }],
            ['token-layer', '?tl', { textLayer: 'Transcription', parentTokenLayer: '?p' }]],
  });
  assert.deepEqual(out.where[1][2], { 'token-layer': '?tl' });
  assert.deepEqual(out.where[2][2], { 'text-layer': 'Transcription', 'parent-token-layer': '?p' });
});

test('bindings keys and values pass through verbatim', () => {
  const out = transformRequest({
    find: ['?s'],
    where: [['span', '?s', { layer: '?lyr' }]],
    bindings: { '?lyr': '0194-uuid', '?tags': ['NOUN', 'PROPN'] },
  });
  assert.deepEqual(out.bindings, { '?lyr': '0194-uuid', '?tags': ['NOUN', 'PROPN'] });
});
