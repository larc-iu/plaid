import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lemmaCandidates, sensesFor, argsOf, rolesetsStartingWith } from '../src/domain/lexicon.js';

const frames = {
  'leave-02': { ARG0: 'leaver', ARG1: 'thing left' },
  'leave-05': { ARG0: 'leaver', ARG1: 'thing' },
  'eat-01': { ARG0: 'eater', ARG1: 'food' },
  'run-02': { ARG0: 'runner' },
  'have-org-role-92': { ARG0: 'person', ARG1: 'organization', ARG2: 'role' },
};

test('lemma candidates strip the common English inflections', () => {
  assert.ok(lemmaCandidates('Leaving').includes('leave'));
  assert.ok(lemmaCandidates('eats').includes('eat'));
  assert.ok(lemmaCandidates('running').includes('run'));
  assert.ok(lemmaCandidates('carried').includes('carry'));
  assert.deepEqual(lemmaCandidates(''), []);
});

test('senses for a form come exact first, then in sense order', () => {
  assert.deepEqual(
    sensesFor(frames, 'left').map((s) => s.id),
    [],
  );
  assert.deepEqual(
    sensesFor(frames, 'leaving').map((s) => s.id),
    ['leave-02', 'leave-05'],
  );
  assert.deepEqual(
    sensesFor(frames, 'Eat').map((s) => s.id),
    ['eat-01'],
  );
});

test('args of a roleset are roles in number order', () => {
  assert.deepEqual(
    argsOf(frames, 'have-org-role-92').map((a) => a.role),
    [':ARG0', ':ARG1', ':ARG2'],
  );
  assert.deepEqual(argsOf(frames, 'person'), []);
});

test('rolesets by prefix, capped', () => {
  assert.deepEqual(
    rolesetsStartingWith(frames, 'lea').map((s) => s.id),
    ['leave-02', 'leave-05'],
  );
  assert.equal(rolesetsStartingWith(frames, 'lea', 1).length, 1);
  assert.deepEqual(rolesetsStartingWith(frames, ''), []);
});
