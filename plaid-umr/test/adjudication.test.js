import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markVariables,
  percent,
  readAdjudication,
  scoreRows,
  sentenceMarks,
  sentenceReport,
} from '../src/domain/adjudication.js';
import { compareNotice } from '../src/domain/compareNotice.js';

const report = {
  version: 2,
  tool: 'ancast 0.1.1',
  against: { id: 'd2', name: 'Copy' },
  at: '2026-09-19T20:00:00Z',
  scope: 'doc',
  scores: { sentence: 0.8312, modal: 0.5, temporal: null, coref: 1, comprehensive: 0.7 },
  sentences: [
    {
      index: 1,
      concept: 0.9,
      labeled: 0.8,
      unlabeled: 0.85,
      weighted: 0.8,
      smatch: 0.7,
      matches: [
        {
          this: 's1l',
          other: 's1x0',
          thisConcept: 'leave-02',
          otherConcept: 'leave-11',
          leftover: false,
        },
        {
          this: 's1e',
          other: 's1x1',
          thisConcept: 'eat-01',
          otherConcept: 'eat-01',
          leftover: true,
        },
      ],
      unmatched: ['s1p'],
      unmatchedOther: [],
      skipped: null,
    },
  ],
};

test('the report is read from the umr namespace, or not at all', () => {
  assert.equal(readAdjudication({ metadata: { umr: { adjudication: report } } }), report);
  assert.equal(readAdjudication({ metadata: { umr: { adjudication: { version: 2 } } } }), null);
  // A report of another shape is not read as this one.
  assert.equal(
    readAdjudication({ metadata: { umr: { adjudication: { ...report, version: 1 } } } }),
    null,
  );
  assert.equal(readAdjudication({ metadata: {} }), null);
  assert.equal(readAdjudication(null), null);
});

test('scores print as whole percents and a missing one is not a row', () => {
  assert.equal(percent(0.8312), '83%');
  assert.equal(percent(null), 'n/a');
  // Temporal is null: neither document annotates it, a row saying so.
  assert.deepEqual(
    scoreRows(report).map((r) => [r.key, r.value]),
    [
      ['sentence', 0.8312],
      ['modal', 0.5],
      ['temporal', null],
      ['coref', 1],
      ['comprehensive', 0.7],
    ],
  );
  assert.deepEqual(
    scoreRows({ ...report, scope: 'snt' }).map((r) => r.key),
    ['sentence'],
  );
  assert.equal(sentenceReport(report, 1).concept, 0.9);
  assert.equal(sentenceReport(report, 2), null);
});

test('marking variables cuts whole tokens only', () => {
  const text = '(s1l / leave-02\n    :ARG0 (s1p / person)\n    :ARG1 s1p2)';
  const segs = markVariables(text, new Map([['s1p', 'missing']]));
  assert.deepEqual(
    segs.filter((s) => s.mark).map((s) => [s.text, s.mark]),
    [['s1p', 'missing']],
  );
  assert.equal(segs.map((s) => s.text).join(''), text);
  assert.deepEqual(markVariables(text, new Map()), [{ text, mark: null }]);
  // A variable made from a concept in another script is one too.
  const cyrillic = '(s1д / дом-01 :ARG0 (s2ł / łódź))';
  const marked = markVariables(
    cyrillic,
    new Map([
      ['s1д', 'differs'],
      ['s2ł', 'missing'],
    ]),
  );
  assert.deepEqual(
    marked.filter((x) => x.mark).map((x) => [x.text, x.mark]),
    [
      ['s1д', 'differs'],
      ['s2ł', 'missing'],
    ],
  );
  assert.deepEqual(markVariables('', new Map([['s1p', 'missing']])), []);
});

// A pair whose concepts differ is a disagreement on both sides. A leftover
// pair of one concept is not marked: the pairing may be arbitrary, but the
// two graphs agree on what is there.
test('each side marks what has no counterpart and what differs in concept', () => {
  const { mine, theirs } = sentenceMarks(report.sentences[0]);
  assert.deepEqual(
    [...mine],
    [
      ['s1p', 'missing'],
      ['s1l', 'differs'],
    ],
  );
  assert.deepEqual([...theirs], [['s1x0', 'differs']]);
  assert.deepEqual([...sentenceMarks(null).mine], []);
});

test('the notice says the scores and the other document, or warns', () => {
  assert.deepEqual(compareNotice({ scores: report.scores, against: report.against }), {
    level: 'success',
    title: 'Compared with Copy',
    message: 'Sentence graphs 83%, comprehensive 70%.',
  });
  assert.equal(compareNotice({}).level, 'warning');
  assert.equal(
    compareNotice({ notice: { level: 'success', title: 'T', message: 'M' } }).title,
    'T',
  );
});
