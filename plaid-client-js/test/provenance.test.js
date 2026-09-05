import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROV, PROV_STATES, PROV_CONFIRMED, stampInferred, confirmedInferred, stampContributed,
  provState, provOrigin, isMachine, isProtected, needsReview, verifyOnEdit, contributeOnEdit,
  mergeMetadata, serviceSource, userSource,
} from '../src/provenance.js';

const CONTRIBUTED = { prov: 'contributed', provSource: 'user:ann@x.com' };

test('stampInferred produces the machine-unverified fragment', () => {
  assert.deepEqual(stampInferred('service:stanza-parser'),
    { prov: 'inferred', provSource: 'service:stanza-parser' });
});

test('confirmedInferred produces the born-verified fragment', () => {
  assert.deepEqual(confirmedInferred('flex-import'),
    { prov: 'inferred', provSource: 'flex-import', provConfirmed: true });
});

test('prediction extras ride along only when given', () => {
  assert.deepEqual(
    stampInferred('service:p', { prob: 0.84, detail: { deprelProbs: { det: 0.84, nsubj: 0.1 } } }),
    { prov: 'inferred', provSource: 'service:p', provProb: 0.84,
      provDetail: { deprelProbs: { det: 0.84, nsubj: 0.1 } } });
  assert.deepEqual(stampInferred('service:p', { prob: 0 }),
    { prov: 'inferred', provSource: 'service:p', provProb: 0 });
  assert.deepEqual(stampInferred('service:p', {}),
    { prov: 'inferred', provSource: 'service:p' });
  assert.deepEqual(
    confirmedInferred('flex-import', { detail: { model: 'flex' } }),
    { prov: 'inferred', provSource: 'flex-import', provConfirmed: true,
      provDetail: { model: 'flex' } });
});

test('prediction extras do not change state classification', () => {
  assert.equal(provState(stampInferred('x', { prob: 0.5 })), PROV_STATES.MACHINE);
  assert.equal(isProtected(stampInferred('x', { prob: 0.5 })), false);
});

test('provState classifies the four states', () => {
  assert.equal(provState({ prov: 'inferred', provSource: 'x' }), PROV_STATES.MACHINE);
  assert.equal(provState({ prov: 'inferred', provSource: 'x', provConfirmed: true }), PROV_STATES.VERIFIED);
  assert.equal(provState(CONTRIBUTED), PROV_STATES.CONTRIBUTED);
  assert.equal(provState({ ...CONTRIBUTED, provConfirmed: true }), PROV_STATES.VERIFIED);
  assert.equal(provState({ somethingElse: 1 }), PROV_STATES.HUMAN);
});

test('stampContributed and userSource', () => {
  assert.deepEqual(stampContributed('ann@x.com'), CONTRIBUTED);
  assert.equal(userSource('ann@x.com'), 'user:ann@x.com');
});

test('provOrigin survives confirmation; provState does not keep it', () => {
  assert.equal(provOrigin(null), null);
  assert.equal(provOrigin({}), null);
  assert.equal(provOrigin(stampInferred('x')), PROV.INFERRED);
  assert.equal(provOrigin(confirmedInferred('x')), PROV.INFERRED);
  assert.equal(provOrigin(CONTRIBUTED), PROV.CONTRIBUTED);
  assert.equal(provOrigin({ ...CONTRIBUTED, provConfirmed: true }), PROV.CONTRIBUTED);
});

test('needsReview is machine or contributed, unconfirmed', () => {
  assert.equal(needsReview(null), false);
  assert.equal(needsReview(stampInferred('x')), true);
  assert.equal(needsReview(CONTRIBUTED), true);
  assert.equal(needsReview(confirmedInferred('x')), false);
  assert.equal(needsReview({ ...CONTRIBUTED, provConfirmed: true }), false);
});

test('absent/empty metadata is human', () => {
  assert.equal(provState(undefined), PROV_STATES.HUMAN);
  assert.equal(provState(null), PROV_STATES.HUMAN);
  assert.equal(provState({}), PROV_STATES.HUMAN);
});

test('an unknown prov value reads as machine, not as human', () => {
  assert.equal(provState({ prov: 'some-future-vocab', provSource: 'x' }), PROV_STATES.MACHINE);
});

test('isProtected: human, contributed and verified are protected, machine is not', () => {
  assert.equal(isProtected(null), true);
  assert.equal(isProtected({ prov: 'inferred' }), false);
  assert.equal(isProtected({ prov: 'inferred', provConfirmed: true }), true);
  assert.equal(isProtected(CONTRIBUTED), true);
});

test('isMachine is the complement of isProtected', () => {
  for (const m of [null, {}, { prov: 'inferred' }, { prov: 'inferred', provConfirmed: true }, CONTRIBUTED]) {
    assert.equal(isMachine(m), !isProtected(m));
  }
  assert.equal(isMachine({ prov: 'inferred', provSource: 'x' }), true);
  assert.equal(isMachine(CONTRIBUTED), false);
});

test('PROV_CONFIRMED is the verifying fragment and is frozen', () => {
  assert.deepEqual(PROV_CONFIRMED, { provConfirmed: true });
  assert.ok(Object.isFrozen(PROV_CONFIRMED));
  assert.equal(provState({ ...stampInferred('x'), ...PROV_CONFIRMED }), PROV_STATES.VERIFIED);
});

test('verifyOnEdit stamps only material that needs review', () => {
  assert.equal(verifyOnEdit({ prov: 'inferred', provSource: 'x' }), PROV_CONFIRMED);
  assert.deepEqual(verifyOnEdit({ prov: 'inferred', provSource: 'x' }),
    { [PROV.confirmedKey]: true });
  assert.equal(verifyOnEdit(CONTRIBUTED), PROV_CONFIRMED);
  assert.equal(verifyOnEdit(undefined), null);
  assert.equal(verifyOnEdit({ prov: 'inferred', provConfirmed: true }), null);
  assert.equal(verifyOnEdit({ ...CONTRIBUTED, provConfirmed: true }), null);
});

test('contributeOnEdit marks anything contributed and drops the confirmation', () => {
  const frag = contributeOnEdit(confirmedInferred('service:x'), 'ann@x.com');
  assert.deepEqual(frag, { ...CONTRIBUTED, provConfirmed: null });
  // Applied as a patch (null deletes), a verified machine span becomes contributed and
  // keeps the prediction extras as history.
  const before = confirmedInferred('service:x', { prob: 0.8, detail: { value: 'PL' } });
  const after = mergeMetadata(before, frag);
  assert.deepEqual(after, { ...CONTRIBUTED, provProb: 0.8, provDetail: { value: 'PL' } });
  assert.equal(provState(after), PROV_STATES.CONTRIBUTED);
  // The same on a verifier's own (human) value.
  assert.equal(provState(mergeMetadata(null, frag)), PROV_STATES.CONTRIBUTED);
});

test('mergeMetadata deletes null-valued keys and leaves the input alone', () => {
  const m = { a: 1, b: 2 };
  assert.deepEqual(mergeMetadata(m, { a: null, c: 3 }), { b: 2, c: 3 });
  assert.deepEqual(m, { a: 1, b: 2 });
  assert.deepEqual(mergeMetadata(null, null), {});
});

test('serviceSource builds the canonical producer id', () => {
  assert.equal(serviceSource('tok:nltk-punkt-tokenizer'), 'service:tok:nltk-punkt-tokenizer');
});
