// What a finished draft run says, worded here from the counts the service
// reports (R18). These cases are the ones the service's own wording was held
// to before the words moved into the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftNotice } from '../src/domain/draftNotice.js';

const run = (counts) => ({
  drafted: 0,
  skipped: 0,
  kept: 0,
  linked: 0,
  sentencesFailed: [],
  sentencesNotDrafted: [],
  ...counts,
});

test('a draft says how many sentences it drafted', () => {
  assert.deepEqual(draftNotice(run({ drafted: 1 })), {
    level: 'success',
    title: 'Drafted 1 sentence',
    message: '',
  });
  assert.equal(draftNotice(run({ drafted: 3 })).title, 'Drafted 3 sentences');
});

test('the sentences kept are named beside a draft, and a person is claimed only for theirs', () => {
  assert.deepEqual(draftNotice(run({ drafted: 1, kept: 1 })), {
    level: 'success',
    title: 'Drafted 1 sentence',
    message: 'Kept 1 sentence a person had worked on.',
  });
  assert.equal(
    draftNotice(run({ linked: 1 })).message,
    'Kept 1 sentence that another sentence links to.',
  );
  assert.deepEqual(draftNotice(run({ kept: 1 })), {
    level: 'warning',
    title: 'Document not modified',
    message: 'Kept 1 sentence a person had worked on.',
  });
});

test('the Overwrite hint is worded for what it would redraft', () => {
  assert.deepEqual(draftNotice(run({ skipped: 3 })), {
    level: 'warning',
    title: 'Document not modified',
    message:
      'All 3 sentences already have graphs. Turn on “Overwrite existing graphs” to draft over them.',
  });
  assert.equal(
    draftNotice(run({ skipped: 2, kept: 1 })).message,
    '2 sentences already have graphs. Turn on “Overwrite existing graphs” to draft over them. ' +
      'Kept 1 sentence a person had worked on.',
  );
  assert.equal(
    draftNotice(run({ skipped: 1, kept: 1 })).message,
    '1 sentence already has a graph. Turn on “Overwrite existing graphs” to draft over it. ' +
      'Kept 1 sentence a person had worked on.',
  );
});

test('each failed sentence is named with its own reason, alike ones together, and the notice stays', () => {
  assert.deepEqual(draftNotice(run({ sentencesFailed: [{ sentence: 3, reason: 'x is wrong' }] })), {
    level: 'warning',
    title: 'Nothing drafted',
    message: 'Failed to draft sentence 3: x is wrong.',
    sticky: true,
  });
  const many = draftNotice(
    run({
      drafted: 2,
      sentencesFailed: [
        { sentence: 1, reason: 'A.' },
        { sentence: 4, reason: 'B.' },
        { sentence: 5, reason: 'A.' },
        { sentence: 9, reason: 'A.' },
      ],
    }),
  );
  assert.equal(many.level, 'warning', 'a run with failures is not a success to tick off');
  assert.equal(many.sticky, true);
  assert.equal(
    many.message,
    'Failed to draft 4 sentences. Sentences 1, 5 and 9: A. Sentence 4: B.',
  );
  assert.equal(draftNotice(run({ drafted: 2 })).sticky, undefined);
});

test('a cause the service reports as a code is worded here', () => {
  assert.equal(
    draftNotice(run({ sentencesFailed: [{ sentence: 2, code: 'no-link-or-gloss' }] })).message,
    'Failed to draft sentence 2: No word has a vocabulary link or a gloss.',
  );
  assert.equal(
    draftNotice(
      run({
        sentencesFailed: [
          { sentence: 1, code: 'no-link-no-gloss-line' },
          { sentence: 3, code: 'no-link-no-gloss-line' },
        ],
      }),
    ).message,
    'Failed to draft 2 sentences. Sentences 1 and 3: No word has a vocabulary link, and UMR settings name no word or morpheme gloss line.',
  );
});

test('a run the model stopped answering says so after its failures', () => {
  const notice = draftNotice(
    run({
      drafted: 1,
      sentencesFailed: [
        { sentence: 2, reason: 'The model did not answer within 120 seconds.' },
        { sentence: 3, reason: 'The model did not answer within 120 seconds.' },
      ],
      sentencesNotDrafted: [4, 5, 6],
    }),
  );
  assert.deepEqual(notice, {
    level: 'warning',
    title: 'Drafted 1 sentence',
    sticky: true,
    message:
      'Failed to draft 2 sentences. Sentences 2 and 3: The model did not answer within 120 seconds. ' +
      'Stopped early: the model did not answer. 3 sentences were not drafted.',
  });
  assert.match(
    draftNotice(run({ sentencesFailed: [{ sentence: 1, reason: 'x' }], sentencesNotDrafted: [2] }))
      .message,
    /1 sentence was not drafted\.$/,
  );
});

test('a run with nothing in scope says so, and no counts at all is that too', () => {
  for (const summary of [run({}), {}, undefined, null]) {
    assert.deepEqual(draftNotice(summary), {
      level: 'warning',
      title: 'Nothing to draft',
      message: 'The document has no sentences in scope.',
    });
  }
});

test('a notice text a result carries is not shown: the words are the app’s', () => {
  const notice = draftNotice({ notice: { level: 'success', title: 'Drafted', message: 'M' } });
  assert.equal(notice.title, 'Nothing to draft');
});
