import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markVariables,
  percent,
  readAdjudication,
  scoreRows,
  sentenceReport,
} from '../src/domain/adjudication.js';
import { compareNotice } from '../src/domain/compareNotice.js';

const report = {
  version: 1,
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
      matches: [['s1l', 's1x0']],
      unmatched: ['s1p'],
      unmatchedOther: [],
      skipped: null,
    },
  ],
};

test('the report is read from the umr namespace, or not at all', () => {
  assert.equal(readAdjudication({ metadata: { umr: { adjudication: report } } }), report);
  assert.equal(readAdjudication({ metadata: { umr: { adjudication: { version: 1 } } } }), null);
  assert.equal(readAdjudication({ metadata: {} }), null);
  assert.equal(readAdjudication(null), null);
});

test('scores print as whole percents and a missing one is not a row', () => {
  assert.equal(percent(0.8312), '83%');
  assert.equal(percent(null), 'n/a');
  assert.deepEqual(
    scoreRows(report).map((r) => r.key),
    ['sentence', 'modal', 'coref', 'comprehensive'],
  );
  assert.equal(sentenceReport(report, 1).concept, 0.9);
  assert.equal(sentenceReport(report, 2), null);
});

test('marking variables cuts whole tokens only', () => {
  const text = '(s1l / leave-02\n    :ARG0 (s1p / person)\n    :ARG1 s1p2)';
  const segs = markVariables(text, ['s1p']);
  assert.deepEqual(
    segs.filter((s) => s.marked).map((s) => s.text),
    ['s1p'],
  );
  assert.equal(segs.map((s) => s.text).join(''), text);
  assert.deepEqual(markVariables(text, []), [{ text, marked: false }]);
  assert.deepEqual(markVariables('', ['s1p']), []);
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
