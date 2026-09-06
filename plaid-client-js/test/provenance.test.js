import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROV, PROV_STATES, PROV_CONFIRMED, stampInferred, confirmedInferred, stampContributed,
  provState, provOrigin, isMachine, isProtected, needsReview, verifyOnEdit, contributeOnEdit,
  mergeMetadata, serviceSource, userSource,
  REVIEW_KEY, readReview, projectRole, isReviewed, withReviewedUser, writerPolicy,
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

// ---- review norm + writer policy ----

const PROJECT = (review) => ({
  id: 'p', maintainers: ['lead@x.com'], writers: ['ann@x.com'], readers: ['bob@x.com'],
  config: review ? { plaid: { [REVIEW_KEY]: review } } : {},
});

test('readReview normalizes absent, partial and junk lists', () => {
  assert.deepEqual(readReview(undefined), { users: [], roles: [] });
  assert.deepEqual(readReview({ plaid: {} }), { users: [], roles: [] });
  assert.deepEqual(readReview({ plaid: { review: { users: ['a', 3, null] } } }), { users: ['a'], roles: [] });
  assert.deepEqual(readReview({ plaid: { review: { roles: ['writer'], users: 'x' } } }), { users: [], roles: ['writer'] });
});

test('projectRole reads the ACL lists; an implicit admin is a maintainer', () => {
  const p = PROJECT(null);
  assert.equal(projectRole(p, 'lead@x.com'), 'maintainer');
  assert.equal(projectRole(p, 'ann@x.com'), 'writer');
  assert.equal(projectRole(p, 'bob@x.com'), 'reader');
  assert.equal(projectRole(p, 'root@x.com'), null);
  assert.equal(projectRole(p, 'root@x.com', { isAdmin: true }), 'maintainer');
  assert.equal(projectRole(p, 'ann@x.com', { isAdmin: true }), 'writer');
});

test('isReviewed: named people, or whole roles, whatever the ACL says', () => {
  assert.equal(isReviewed(PROJECT(null), 'ann@x.com'), false);
  assert.equal(isReviewed(PROJECT({ users: ['ann@x.com'] }), 'ann@x.com'), true);
  assert.equal(isReviewed(PROJECT({ users: ['ann@x.com'] }), 'lead@x.com'), false);
  // a maintainer can be reviewed, and a writer need not be
  assert.equal(isReviewed(PROJECT({ users: ['lead@x.com'] }), 'lead@x.com'), true);
  assert.equal(isReviewed(PROJECT({ roles: ['writer'] }), 'ann@x.com'), true);
  assert.equal(isReviewed(PROJECT({ roles: ['writer'] }), 'lead@x.com'), false);
  assert.equal(isReviewed(PROJECT({ roles: ['maintainer'] }), 'root@x.com', { isAdmin: true }), true);
  assert.equal(isReviewed(null, 'ann@x.com'), false);
  assert.equal(isReviewed(PROJECT({ users: ['ann@x.com'] }), null), false);
});

test('withReviewedUser edits users only and is pure', () => {
  const r = { users: ['ann@x.com'], roles: ['writer'] };
  assert.deepEqual(withReviewedUser(r, 'bob@x.com', true), { users: ['ann@x.com', 'bob@x.com'], roles: ['writer'] });
  assert.deepEqual(withReviewedUser(r, 'ann@x.com', false), { users: [], roles: ['writer'] });
  assert.deepEqual(withReviewedUser(r, 'ann@x.com', true), { users: ['ann@x.com'], roles: ['writer'] });
  assert.deepEqual(withReviewedUser(undefined, 'ann@x.com', true), { users: ['ann@x.com'], roles: [] });
  assert.deepEqual(r, { users: ['ann@x.com'], roles: ['writer'] });
});

test('writerPolicy for a verifier: plain writes, confirms what needs review', () => {
  const w = writerPolicy(null);
  assert.equal(w.isContributor, false);
  assert.equal(w.createStamp, null);
  assert.equal(w.editStamp(null), null);
  assert.deepEqual(w.editStamp(stampInferred('x')), PROV_CONFIRMED);
  assert.deepEqual(w.editStamp(CONTRIBUTED), PROV_CONFIRMED);
  assert.deepEqual(w.confirmStamp(CONTRIBUTED), PROV_CONFIRMED);
  assert.equal(w.confirmStamp(confirmedInferred('x')), null);
  assert.equal(w.reviewable(CONTRIBUTED), true);
  assert.equal(w.reviewableState('contributed'), true);
  assert.deepEqual(w.adoptStamp('gloss:precedent', { value: 'cat' }),
    { prov: 'inferred', provSource: 'gloss:precedent', provConfirmed: true, provDetail: { value: 'cat' } });
});

test('writerPolicy for a contributor: everything contributed, reviews machine only', () => {
  const w = writerPolicy('ann@x.com');
  assert.equal(w.isContributor, true);
  assert.deepEqual(w.createStamp, CONTRIBUTED);
  assert.deepEqual(w.editStamp(null), { ...CONTRIBUTED, provConfirmed: null });
  assert.deepEqual(w.editStamp(confirmedInferred('x')), { ...CONTRIBUTED, provConfirmed: null });
  assert.deepEqual(w.confirmStamp(stampInferred('x')), { ...CONTRIBUTED, provConfirmed: null });
  assert.equal(w.confirmStamp(CONTRIBUTED), null);
  assert.equal(w.confirmStamp(null), null);
  assert.equal(w.reviewable(stampInferred('x')), true);
  assert.equal(w.reviewable(CONTRIBUTED), false);
  assert.equal(w.reviewableState('contributed'), false);
  assert.deepEqual(w.adoptStamp('gloss:precedent', { value: 'cat' }),
    { ...CONTRIBUTED, provDetail: { value: 'cat', guess: 'gloss:precedent' } });
});
