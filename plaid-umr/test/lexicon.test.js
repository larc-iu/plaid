import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  lemmaCandidates,
  sensesFor,
  argsOf,
  argSummary,
  rolesetsStartingWith,
} from '../src/domain/lexicon.js';

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

// A roleset stored on a vocabulary entry comes back from core in any key
// order, and the picker printed it that way.
test('argSummary lists the numbered arguments in order, anything else after', () => {
  assert.equal(
    argSummary({ ARG0: 'giver', ARG2: 'recipient', ARG1: 'thing given' }),
    'ARG0 giver, ARG1 thing given, ARG2 recipient',
  );
  assert.equal(
    argSummary({ 'ARGM-LOC': 'place', ARG10: 'ten', ARG2: 'two', ARG: 'bare' }),
    'ARG2 two, ARG10 ten, ARGM-LOC place, ARG bare',
  );
  assert.equal(argSummary(null), '');
});

// umr-igt-inflected-forms, the Arabic half: alif folded on both sides, and a
// word less one proclitic and a suffix.
const arabic = {
  'قال-01': { ARG0: 'sayer' },
  'اعلن-01': { ARG0: 'announcer' },
  'ٱنكشف-01': { ARG1: 'thing revealed' },
  'كتب-01': { ARG0: 'writer' },
  'كتاب-01': { ARG0: 'book' },
};

test('an Arabic word less its proclitic and suffix finds its roleset', () => {
  // و + قال + ت
  assert.deepEqual(
    sensesFor(arabic, 'وقالت').map((s) => s.id),
    ['قال-01'],
  );
  // The hamza the text writes is not in the file's key.
  assert.deepEqual(
    sensesFor(arabic, 'أعلنت').map((s) => s.id),
    ['اعلن-01'],
  );
  // ال + كتاب, and nothing shorter than two letters is guessed.
  assert.deepEqual(
    sensesFor(arabic, 'الكتاب').map((s) => s.id),
    ['كتاب-01'],
  );
  assert.ok(lemmaCandidates('وقالت').every((c) => [...c].length >= 2));
  // Diacritics are not letters and do not block the match.
  assert.deepEqual(
    sensesFor(arabic, 'قَالَ').map((s) => s.id),
    ['قال-01'],
  );
});

test('typed search folds alif on both sides', () => {
  assert.deepEqual(
    rolesetsStartingWith(arabic, 'أعلن').map((s) => s.id),
    ['اعلن-01'],
  );
  assert.deepEqual(
    rolesetsStartingWith(arabic, 'انكشف').map((s) => s.id),
    ['ٱنكشف-01'],
  );
});

test('the English candidates are unchanged by the Arabic ones', () => {
  assert.deepEqual(lemmaCandidates('Leaving'), ['leaving', 'leav', 'leave']);
});

// The ruling's own examples, on the bundled Arabic file.
test('the bundled Arabic file offers قال-01 for وقالت and اعلن-01 for أعلنت', () => {
  const file = JSON.parse(
    fs.readFileSync(new URL('../src/data/frames/arabic.json', import.meta.url), 'utf8'),
  );
  assert.ok(sensesFor(file, 'وقالت').some((s) => s.id === 'قال-01'));
  assert.ok(sensesFor(file, 'أعلنت').some((s) => s.id === 'اعلن-01'));
  assert.ok(rolesetsStartingWith(file, 'قال').some((s) => s.id === 'قال-01'));
});
