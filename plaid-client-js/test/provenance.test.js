import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROV, PROV_STATES, stampInferred, confirmedInferred, provState,
  isProtected, verifyOnEdit, serviceSource,
} from '../src/provenance.js';

test('stampInferred produces the machine-unverified fragment', () => {
  assert.deepEqual(stampInferred('service:stanza-parser'),
    { prov: 'inferred', provSource: 'service:stanza-parser' });
});

test('confirmedInferred produces the born-verified fragment', () => {
  assert.deepEqual(confirmedInferred('flex-import'),
    { prov: 'inferred', provSource: 'flex-import', provConfirmed: true });
});

test('provState classifies the three states', () => {
  assert.equal(provState({ prov: 'inferred', provSource: 'x' }), PROV_STATES.MACHINE);
  assert.equal(provState({ prov: 'inferred', provSource: 'x', provConfirmed: true }), PROV_STATES.VERIFIED);
  assert.equal(provState({ somethingElse: 1 }), PROV_STATES.HUMAN);
});

test('absent/empty metadata is human', () => {
  assert.equal(provState(undefined), PROV_STATES.HUMAN);
  assert.equal(provState(null), PROV_STATES.HUMAN);
  assert.equal(provState({}), PROV_STATES.HUMAN);
});

test('the prov KEY presence, not its value, is the discriminator', () => {
  assert.equal(provState({ prov: 'some-future-vocab', provSource: 'x' }), PROV_STATES.MACHINE);
});

test('isProtected: human and verified are protected, machine is not', () => {
  assert.equal(isProtected(null), true);
  assert.equal(isProtected({ prov: 'inferred' }), false);
  assert.equal(isProtected({ prov: 'inferred', provConfirmed: true }), true);
});

test('verifyOnEdit stamps only machine-unverified material', () => {
  assert.deepEqual(verifyOnEdit({ prov: 'inferred', provSource: 'x' }),
    { [PROV.confirmedKey]: true });
  assert.equal(verifyOnEdit(undefined), null);
  assert.equal(verifyOnEdit({ prov: 'inferred', provConfirmed: true }), null);
});

test('serviceSource builds the canonical producer id', () => {
  assert.equal(serviceSource('tok:nltk-punkt-tokenizer'), 'service:tok:nltk-punkt-tokenizer');
});
